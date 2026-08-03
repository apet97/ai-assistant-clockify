import type { ToolCall } from "../assistant/model-client.js";
import { DISCOVERY_META_TOOL_NAME } from "../harness/api-operation.js";
import {
  validateLoadedToolCall,
  type LoadedToolValidationFailure,
} from "../assistant-v2/discovery/api-search-tool.js";
import { V2_LIMITS } from "../assistant-v2/budgets.js";
import { computeArgumentsHash } from "../assistant-v2/events.js";
import type {
  ReadExecutionOutcome,
  RunnerDependencies,
  RunScope,
  WritePreparationOutcome,
} from "../assistant-v2/protocol.js";
import type { RunState } from "../assistant-v2/state.js";
import { boundedDenialCode, type RunObservation } from "../assistant-v2/observations.js";
import type { ActionRegistry } from "../harness/api-catalog.js";
import { scopedRun } from "./run-service.js";
import { classifyLoggableError } from "../log-error-class.js";
import { asTerminalReason, InstallationChangedError } from "../assistant-v2/terminal-reason.js";

/**
 * ActionExecutionService (T16-C): validated tool-call execution extracted from
 * `runner.ts`. The read path can ONLY reach the injected read port through the
 * request governor's pool; the write path can ONLY reach the preparation port
 * (which never dispatches a host mutation — `ConfirmationService` remains the
 * sole assistant-write dispatch seam).
 */
export type ActionExecutionDeps = Pick<
  RunnerDependencies,
  "reads" | "preparations" | "requestGovernor" | "eventService" | "runStore" | "actionRegistry"
>;

export type DeniedToolCall = {
  toolCallId: string;
  actionName: string;
  code: string;
};

function denyCode(reason: LoadedToolValidationFailure | "duplicate_tool_call_id" | "mixed_discovery_batch" | "budget_exhausted" | "read_write_dependency" | "duplicate_write" | "too_many_refinements" | "write_port_not_ready"): string {
  return reason;
}

/** F11: order-insensitive canonical form — reordered keys collide, genuinely
 * distinct arguments do not. */
function canonicalArgumentsKey(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>).sort()
          .map((key) => [key, canonical((v as Record<string, unknown>)[key])]),
      );
    }
    return v;
  };
  return JSON.stringify(canonical(value));
}

export function validateCompletionToolCalls(
  toolCalls: ToolCall[],
  loadedNames: ReadonlySet<string>,
  registry: ActionRegistry,
  catalogHash: string,
  authClass: RunScope["authClass"],
  /** PR 7: provider tool-call ids must be unique across the RUN, not merely
   * one completion array. */
  priorToolCallIds: ReadonlySet<string> = new Set(),
): { accepted: ToolCall[]; denied: DeniedToolCall[] } {
  const denied: DeniedToolCall[] = [];
  const seenIds = new Set<string>(priorToolCallIds);
  const accepted: ToolCall[] = [];
  const hasDiscovery = toolCalls.some((call) => call.name === DISCOVERY_META_TOOL_NAME);
  const hasApi = toolCalls.some((call) => call.name !== DISCOVERY_META_TOOL_NAME);
  if (hasDiscovery && hasApi) {
    for (const call of toolCalls) {
      if (call.name === DISCOVERY_META_TOOL_NAME) accepted.push(call);
      else denied.push({ toolCallId: call.id, actionName: call.name, code: denyCode("mixed_discovery_batch") });
    }
    return { accepted, denied };
  }
  for (const call of toolCalls) {
    if (seenIds.has(call.id)) {
      denied.push({ toolCallId: call.id, actionName: call.name, code: denyCode("duplicate_tool_call_id") });
      continue;
    }
    seenIds.add(call.id);
    const validation = validateLoadedToolCall({
      toolName: call.name,
      loadedNames,
      expectedCatalogHash: catalogHash,
      currentCatalogHash: catalogHash,
      registry,
      authClass,
    });
    if (!validation.ok) {
      denied.push({ toolCallId: call.id, actionName: call.name, code: denyCode(validation.reason) });
      continue;
    }
    accepted.push(call);
  }
  return { accepted, denied };
}

export async function executeReadsConcurrently(
  calls: ToolCall[],
  scope: RunScope & { runId: string },
  deps: Pick<RunnerDependencies, "requestGovernor" | "reads">,
  signal: AbortSignal | undefined,
  onResult: (call: ToolCall, outcome: ReadExecutionOutcome) => void,
  /** Plan B1: the run's validated host-call ceiling, threaded to the governor
   * boundary. Defaults to the production `V2_LIMITS` ceiling; an override can
   * only narrow it (the runner rejects anything wider). */
  hostCallCeiling: number = V2_LIMITS.maxHostCalls,
): Promise<void> {
  const poolSize = V2_LIMITS.maxConcurrentReads;
  let nextIndex = 0;
  // Closure-plan PR 5 (F03): one worker's failure must not unwind the batch
  // while siblings are mid-flight. Workers catch everything (the read port
  // itself no longer throws; this bounds governor/budget rejections), stop
  // ADMITTING new work after cancellation or a fatal denial, and every
  // already-started worker is awaited (`allSettled`) before the batch reports.
  let stopAdmitting = false;
  const ordered: Array<{ call: ToolCall; outcome: ReadExecutionOutcome } | undefined> = new Array(calls.length);
  async function worker(): Promise<void> {
    for (;;) {
      if (signal?.aborted || stopAdmitting) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= calls.length) return;
      const call = calls[index];
      try {
        const outcome = await deps.requestGovernor.runRead(
          scope,
          () => deps.reads.execute(call, scope),
          { signal, maxHostCalls: hostCallCeiling },
        );
        ordered[index] = { call, outcome };
      } catch (error) {
        stopAdmitting = true;
        console.error(`[v2-run] event=read_dispatch_failed ${classifyLoggableError(error)}`);
        ordered[index] = {
          call,
          outcome: {
            kind: "denied",
            // The caught message is NOT a denial code. `lastDenialCode` carries this
            // value to `failRun`, so it reached the admin's screen and the API `code`
            // field — the same leak as `runner.ts`'s model-call catch, on a path the
            // 256-byte `boundedDenialCode` cap bounded in LENGTH but never in CONTENT.
            // The diagnosis goes to the operator log as a bounded classification.
            //
            // PARSE rather than flatten. `requestGovernor.runRead` signals a revoked
            // installation (`routes/v2-chat-pipeline.ts:49`) — ideally via the typed
            // `InstallationChangedError` (T12), checked first below — and the
            // generation recheck at `runner.ts:200` runs BEFORE this batch, so a
            // revocation during the reads arrives here. Collapsing every throw to
            // `read_dispatch_failed` would tell that admin to "try again in a
            // moment" when only a reload helps. A known reason survives (either via
            // the typed instanceof check or the legacy message-string recognizer);
            // anything else becomes `internal_error`.
            code: error instanceof InstallationChangedError
              ? error.code
              : asTerminalReason(error instanceof Error ? error.message : "read_dispatch_failed"),
          },
        };
      }
    }
  }
  await Promise.allSettled(Array.from({ length: Math.min(poolSize, calls.length) }, () => worker()));
  for (const [index, call] of calls.entries()) {
    const entry = ordered[index];
    if (entry) {
      onResult(entry.call, entry.outcome);
      continue;
    }
    // Never silently dropped: a call that was not admitted (cancellation or a
    // fatal denial stopped the pool) is journaled as an explicit denial.
    onResult(call, {
      kind: "denied",
      code: signal?.aborted ? "cancelled_before_dispatch" : "not_admitted",
    });
  }
}

export type PartitionedToolCalls = {
  readCalls: ToolCall[];
  writeCalls: ToolCall[];
  discoveryCalls: ToolCall[];
  denied: DeniedToolCall[];
  /** Two write calls with identical name+arguments in one batch: the run must
   * fail rather than guess which one the model meant. */
  duplicateWrite: boolean;
};

export type ReadBatchResult = {
  state: RunState;
  /** Set when a read produced a clarification: the run suspends immediately. */
  clarification?: { clarificationId: string };
  /** What this batch learned, for the next model request. */
  observations: RunObservation[];
};

export type WriteBatchResult = {
  state: RunState;
  /** Set when a write batch was prepared: the run suspends awaiting the button. */
  suspended?: { operationIds: string[]; batchId?: string; confirmationId: string };
  /** F19: set when an ambiguous write produced a durable clarification — the
   * run suspends awaiting the answer, exactly like an ambiguous read. */
  clarification?: { clarificationId: string };
  /** What this batch learned, for the next model request. */
  observations: RunObservation[];
};

export function createActionExecutionService(
  deps: ActionExecutionDeps,
  options?: {
    /** Plan B1: the run's validated host-call ceiling (see `RunBudgetOverrides`).
     * Absent — every production composition — it is the `V2_LIMITS` default. */
    hostCallCeiling?: number;
  },
) {
  const hostCallCeiling = options?.hostCallCeiling ?? V2_LIMITS.maxHostCalls;
  function isWriteAction(name: string): boolean {
    return deps.actionRegistry.get(name)?.apiOperation?.access === "write";
  }

  function isReadAction(name: string): boolean {
    return deps.actionRegistry.get(name)?.apiOperation?.access === "read";
  }

  /** Validate + partition one completion's tool calls. A mixed read/write
   * batch denies the writes (`read_write_dependency`); unknown access grades
   * conservatively as a write. */
  function partitionToolCalls(
    toolCalls: ToolCall[],
    loadedNames: ReadonlySet<string>,
    catalogHash: string,
    authClass: RunScope["authClass"],
    priorToolCallIds: ReadonlySet<string> = new Set(),
  ): PartitionedToolCalls {
    const { accepted, denied } = validateCompletionToolCalls(
      toolCalls,
      loadedNames,
      deps.actionRegistry,
      catalogHash,
      authClass,
      priorToolCallIds,
    );
    const readCalls: ToolCall[] = [];
    const writeCalls: ToolCall[] = [];
    const discoveryCalls: ToolCall[] = [];
    for (const call of accepted) {
      if (call.name === DISCOVERY_META_TOOL_NAME) discoveryCalls.push(call);
      else if (isWriteAction(call.name)) writeCalls.push(call);
      else if (isReadAction(call.name)) readCalls.push(call);
      else writeCalls.push(call);
    }
    if (readCalls.length > 0 && writeCalls.length > 0) {
      for (const call of writeCalls) {
        denied.push({ toolCallId: call.id, actionName: call.name, code: denyCode("read_write_dependency") });
      }
      writeCalls.length = 0;
    }
    // F11: canonical, order-insensitive duplicate detection.
    const writeNames = writeCalls.map((c) => `${c.name}:${canonicalArgumentsKey(c.arguments)}`);
    const duplicateWrite = new Set(writeNames).size !== writeNames.length;
    return { readCalls, writeCalls, discoveryCalls, denied, duplicateWrite };
  }

  /** Run budget-admitted reads through the governor pool, journal each tool
   * transition in provider order, and surface the first clarification. */
  async function executeReads(
    state: RunState,
    readCalls: ToolCall[],
    scope: RunScope,
    signal: AbortSignal | undefined,
    denied: DeniedToolCall[],
  ): Promise<ReadBatchResult> {
    const readOutcomes: Array<{ call: ToolCall; outcome: ReadExecutionOutcome }> = [];
    const readCallsToRun: ToolCall[] = [];
    // Closure-plan PR 7 (F17): admit the batch against the REMAINING logical
    // allowance in provider order — the old per-call check read one stale
    // `apiCallsUsed` for the whole batch and could overshoot the ceiling.
    const remainingLogical = Math.max(0, V2_LIMITS.maxApiCalls - state.budget.apiCallsUsed);
    for (const [index, call] of readCalls.entries()) {
      if (index >= remainingLogical) {
        denied.push({ toolCallId: call.id, actionName: call.name, code: denyCode("budget_exhausted") });
        continue;
      }
      readCallsToRun.push(call);
    }
    await executeReadsConcurrently(
      readCallsToRun,
      { ...scope, runId: state.runId },
      deps,
      signal,
      (call, outcome) => {
        readOutcomes.push({ call, outcome });
      },
      hostCallCeiling,
    );

    // The reads have ALL already run (the pool resolves every call before any
    // outcome can suspend the run), so returning at the first clarification
    // erased later reads that really made host calls and really persisted
    // results. Journal the whole batch in provider order first, then suspend on
    // the first clarification.
    let firstClarification: { clarificationId: string; actionResultId: string } | undefined;
    const observations: RunObservation[] = [];
    for (const { call, outcome } of readOutcomes) {
      deps.eventService.requestTool({
        scope: scopedRun(state),
        state,
        payload: {
          toolCallId: call.id,
          actionName: call.name,
          argumentsHash: computeArgumentsHash(call.arguments),
        },
      });
      state = deps.runStore.getRun(scopedRun(state)) ?? state;
      deps.eventService.startTool({
        scope: scopedRun(state),
        state,
        payload: { toolCallId: call.id, actionName: call.name },
      });
      state = deps.runStore.getRun(scopedRun(state)) ?? state;
      if (!state.usedToolNames.includes(call.name)) state.usedToolNames.push(call.name);
      if (outcome.kind === "succeeded") {
        deps.eventService.completeTool({
          scope: scopedRun(state),
          state,
          payload: {
            toolCallId: call.id,
            actionName: call.name,
            actionResultId: outcome.actionResultId,
          },
        });
        state = deps.runStore.getRun(scopedRun(state)) ?? state;
        if (outcome.modelSummary) {
          observations.push({ kind: "result", actionName: call.name, summary: outcome.modelSummary });
        }
      } else if (outcome.kind === "denied" || outcome.kind === "validation_failed" || outcome.kind === "failed") {
        // A failed read previously journaled `tool.requested` + `tool.started`
        // and then nothing, so the timeline lied about an in-flight read and
        // the model never learned why the read did not help.
        const code = boundedDenialCode(outcome.code);
        deps.eventService.denyTool({
          scope: scopedRun(state),
          state,
          payload: {
            toolCallId: call.id,
            actionName: call.name,
            code,
            ...(outcome.actionResultId ? { actionResultId: outcome.actionResultId } : {}),
          },
        });
        state = deps.runStore.getRun(scopedRun(state)) ?? state;
        observations.push({ kind: "denied", actionName: call.name, code });
      } else if (outcome.kind === "clarification" && !firstClarification) {
        firstClarification = {
          clarificationId: outcome.clarificationId,
          actionResultId: outcome.actionResultId,
        };
      }
    }
    if (firstClarification) {
      // Order matters: the continuation must be set BEFORE the commit, because
      // the atomic suspension persists `state.continuation`. The per-tool
      // events above committed with the continuation still `none`, which is
      // correct: the run is only awaiting clarification once the whole batch
      // is journaled. The question and the suspension then commit in ONE
      // store transaction (F23) — a crash cannot journal one without the other.
      state.continuation = {
        kind: "awaiting_clarification",
        clarificationId: firstClarification.clarificationId,
      };
      deps.eventService.requireClarificationAndSuspend({
        scope: scopedRun(state),
        state,
        payload: firstClarification,
      });
      state = deps.runStore.getRun(scopedRun(state)) ?? state;
      return { state, clarification: { clarificationId: firstClarification.clarificationId }, observations };
    }
    return { state, observations };
  }

  /** Prepare a write batch: zero host mutations, one durable suspension when
   * previews were prepared. The preparation port failing is journaled as a
   * completed tool with a not-ready marker, never a crash. */
  async function prepareWrites(
    state: RunState,
    writeCalls: ToolCall[],
    fallbackContinuationId: string,
  ): Promise<WriteBatchResult> {
    const observations: RunObservation[] = [];
    // Closure-plan PR 7 (F17): WRITES are logical API calls too — the old
    // loop here checked the budget and did nothing. Admit against the
    // remaining allowance in provider order, deny the excess, and persist the
    // count BEFORE preparation (which reloads the run row itself).
    const remainingLogical = Math.max(0, V2_LIMITS.maxApiCalls - state.budget.apiCallsUsed);
    const admitted = writeCalls.slice(0, remainingLogical);
    for (const call of writeCalls.slice(remainingLogical)) {
      deps.eventService.denyTool({
        scope: scopedRun(state),
        state,
        payload: { toolCallId: call.id, actionName: call.name, code: denyCode("budget_exhausted") },
      });
      state = deps.runStore.getRun(scopedRun(state)) ?? state;
      observations.push({ kind: "denied", actionName: call.name, code: denyCode("budget_exhausted") });
    }
    if (admitted.length === 0) return { state, observations };
    state = {
      ...state,
      budget: { ...state.budget, apiCallsUsed: state.budget.apiCallsUsed + admitted.length },
    };
    deps.runStore.saveRun(state);
    writeCalls = admitted;
    for (const call of writeCalls) {
      deps.eventService.requestTool({
        scope: scopedRun(state),
        state,
        payload: {
          toolCallId: call.id,
          actionName: call.name,
          argumentsHash: computeArgumentsHash(call.arguments),
        },
      });
      state = deps.runStore.getRun(scopedRun(state)) ?? state;
    }
    let preparation: WritePreparationOutcome;
    try {
      // `scopedRun(state)` carries the run id. Forwarding the runner's bare
      // `scope` here is what made every production write fail: preparation
      // needs the run to reserve its budget against.
      preparation = await deps.preparations.prepare(writeCalls, scopedRun(state));
    } catch (error) {
      // Discarding the exception here made every unexpected preparation failure
      // present as the same opaque `write_port_not_ready`, which is how the
      // real cause of a production outage stayed invisible.
      console.error(`[v2-run] event=write_preparation_failed ${classifyLoggableError(error)}`);
      preparation = { kind: "not_ready", code: "write_port_not_ready", actionResultId: "prep-failed" };
    }
    if (preparation.kind === "prepared") {
      // The preparation transaction already committed phase, continuation, and
      // `run.suspended` atomically with the operation/confirmation rows (F23).
      // Reload the durably suspended state instead of re-suspending here.
      state = deps.runStore.getRun(scopedRun(state)) ?? state;
      return {
        state,
        suspended: {
          operationIds: preparation.operationIds,
          batchId: preparation.batchId,
          confirmationId: preparation.confirmationIds[0] ?? fallbackContinuationId,
        },
        observations,
      };
    }
    if (preparation.kind === "clarification") {
      // F19: suspend on the write's durable question — the question event and
      // the run suspension commit atomically (F23), same as an ambiguous read.
      state.continuation = {
        kind: "awaiting_clarification",
        clarificationId: preparation.clarificationId,
      };
      deps.eventService.requireClarificationAndSuspend({
        scope: scopedRun(state),
        state,
        payload: {
          clarificationId: preparation.clarificationId,
          actionResultId: preparation.actionResultId,
        },
      });
      state = deps.runStore.getRun(scopedRun(state)) ?? state;
      return {
        state,
        clarification: { clarificationId: preparation.clarificationId },
        observations,
      };
    }
    if (preparation.kind === "not_ready") {
      const call = writeCalls[0];
      if (call) {
        deps.eventService.completeTool({
          scope: scopedRun(state),
          state,
          payload: {
            toolCallId: call.id,
            actionName: call.name,
            actionResultId: preparation.actionResultId,
          },
        });
        state = deps.runStore.getRun(scopedRun(state)) ?? state;
        observations.push({
          kind: "denied",
          actionName: call.name,
          // The FOURTH interpolation site. `thrownCause` exists so an
          // unexpected preparation failure is not invisible — a real outage
          // hid behind an opaque `write_port_not_ready` once — but appending
          // it to the CODE put a raw `error.message` on the same admin-facing
          // path as the other three. The cause keeps its diagnostic job in the
          // operator log; the code stays a parsed reason.
          code: asTerminalReason(preparation.code),
        });
      }
    }
    if (preparation.kind === "denied") {
      // T14-T16 review gate HIGH-2: a denied preparation (policy, validation,
      // auth-class, clarification_required, budget) must never vanish from the
      // durable journal. Record it with the same tool.denied vocabulary the
      // validation layer uses — the canonical action_results row the
      // preparation already wrote stays the full audit record.
      for (const call of writeCalls) {
        deps.eventService.denyTool({
          scope: scopedRun(state),
          state,
          payload: {
            toolCallId: call.id,
            actionName: call.name,
            code: preparation.code,
          },
        });
        state = deps.runStore.getRun(scopedRun(state)) ?? state;
        observations.push({ kind: "denied", actionName: call.name, code: preparation.code });
      }
    }
    return { state, observations };
  }

  /** Journal every denial from this completion batch. */
  function recordDenials(state: RunState, denied: DeniedToolCall[]): { state: RunState; observations: RunObservation[] } {
    const observations: RunObservation[] = [];
    for (const d of denied) {
      const code = boundedDenialCode(d.code);
      deps.eventService.denyTool({
        scope: scopedRun(state),
        state,
        payload: {
          toolCallId: d.toolCallId,
          actionName: d.actionName,
          code,
        },
      });
      state = deps.runStore.getRun(scopedRun(state)) ?? state;
      observations.push({ kind: "denied", actionName: d.actionName, code });
    }
    return { state, observations };
  }

  return { partitionToolCalls, executeReads, prepareWrites, recordDenials };
}

export type ActionExecutionService = ReturnType<typeof createActionExecutionService>;
