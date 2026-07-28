import type { ToolCall } from "../assistant/model-client.js";
import { DISCOVERY_META_TOOL_NAME } from "../harness/api-operation.js";
import {
  validateLoadedToolCall,
  type LoadedToolValidationFailure,
} from "../assistant-v2/discovery/api-search-tool.js";
import { V2_LIMITS, canReserveApiCall } from "../assistant-v2/budgets.js";
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

export function validateCompletionToolCalls(
  toolCalls: ToolCall[],
  loadedNames: ReadonlySet<string>,
  registry: ActionRegistry,
  catalogHash: string,
  authClass: RunScope["authClass"],
): { accepted: ToolCall[]; denied: DeniedToolCall[] } {
  const denied: DeniedToolCall[] = [];
  const seenIds = new Set<string>();
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
): Promise<void> {
  const poolSize = V2_LIMITS.maxConcurrentReads;
  let nextIndex = 0;
  const ordered: Array<{ call: ToolCall; outcome: ReadExecutionOutcome } | undefined> = new Array(calls.length);
  async function worker(): Promise<void> {
    for (;;) {
      if (signal?.aborted) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= calls.length) return;
      const call = calls[index];
      const outcome = await deps.requestGovernor.runRead(scope, () => deps.reads.execute(call, scope), { signal });
      ordered[index] = { call, outcome };
    }
  }
  await Promise.all(Array.from({ length: Math.min(poolSize, calls.length) }, () => worker()));
  for (const entry of ordered) {
    if (entry) onResult(entry.call, entry.outcome);
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
  /** What this batch learned, for the next model request. */
  observations: RunObservation[];
};

export function createActionExecutionService(deps: ActionExecutionDeps) {
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
  ): PartitionedToolCalls {
    const { accepted, denied } = validateCompletionToolCalls(
      toolCalls,
      loadedNames,
      deps.actionRegistry,
      catalogHash,
      authClass,
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
    const writeNames = writeCalls.map((c) => `${c.name}:${JSON.stringify(c.arguments)}`);
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
    for (const call of readCalls) {
      if (!canReserveApiCall(state.budget)) {
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
          payload: { toolCallId: call.id, actionName: call.name, code },
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
      // Order matters: the continuation must be set BEFORE any event commits,
      // because `commitStateEvent` persists `state.continuation` — journaling
      // first and then reloading would write back `{kind:"none"}` and lose the
      // clarification id the resolve route restores from. The per-tool events
      // above committed with the continuation still `none`, which is correct:
      // the run is only awaiting clarification once the whole batch is journaled.
      state.continuation = {
        kind: "awaiting_clarification",
        clarificationId: firstClarification.clarificationId,
      };
      deps.eventService.requireClarification({
        scope: scopedRun(state),
        state,
        payload: firstClarification,
      });
      // The reload returns the persisted state, which already carries the
      // continuation set before the event; no re-assignment is needed.
      state = deps.runStore.getRun(scopedRun(state)) ?? state;
      deps.eventService.suspendRun({
        scope: scopedRun(state),
        state,
        payload: { reason: "awaiting_clarification" },
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
    scope: RunScope,
    fallbackContinuationId: string,
  ): Promise<WriteBatchResult> {
    for (const _call of writeCalls) {
      if (!canReserveApiCall(state.budget)) break;
    }
    let preparation: WritePreparationOutcome;
    const observations: RunObservation[] = [];
    let thrownCause: string | undefined;
    try {
      preparation = await deps.preparations.prepare(writeCalls, scope);
    } catch (error) {
      // Discarding the exception here made every unexpected preparation failure
      // present as the same opaque `write_port_not_ready`, which is how the
      // real cause of a production outage stayed invisible.
      thrownCause = error instanceof Error ? error.message : String(error);
      preparation = { kind: "not_ready", code: "write_port_not_ready", actionResultId: "prep-failed" };
    }
    if (preparation.kind === "prepared") {
      state.continuation = { kind: "awaiting_operations", operationIds: preparation.operationIds, batchId: preparation.batchId };
      state.pendingOperationIds = preparation.operationIds;
      deps.eventService.suspendRun({
        scope: scopedRun(state),
        state,
        payload: { reason: "awaiting_confirmation" },
      });
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
          code: boundedDenialCode(thrownCause ? `${preparation.code}: ${thrownCause}` : preparation.code),
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
