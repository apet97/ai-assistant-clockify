import { ProviderProtocolError } from "../assistant/model-client.js";
import {
  canReserveModelCall,
  isActiveWallBudgetExceeded,
  isTokenBudgetExceeded,
} from "./budgets.js";
import type {
  RunAssistantInput,
  RunOutcome,
  RunnerDependencies,
  RunScope,
} from "./protocol.js";
import {
  computeRequestHash,
  createEmptyRunBudget,
  isTerminalPhase,
} from "./state.js";
import { discoveryToolsForLoadedSet } from "../harness/tools.js";
import { formatObservations, summarizeActionResultForModel, type RunObservation } from "./observations.js";
import { createRunService, scopedRun } from "../services/run-service.js";
import {
  createApiDiscoveryService,
  seedCacheFromPriorRun,
} from "../services/api-discovery-service.js";
import { createActionExecutionService } from "../services/action-execution-service.js";

/**
 * The durable, provider-independent v2 loop (T08-C/T16-C): orchestration only.
 * The model-call machinery lives in `services/run-service.ts`, discovery
 * refinement in `services/api-discovery-service.ts`, and validated tool
 * execution in `services/action-execution-service.ts`. This file decides the
 * ORDER: resume/terminal short-circuits, fresh-state creation, then
 * model → validate/partition → discovery → reads → write preparation →
 * denials, until a terminal or suspension outcome.
 */

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export async function runAssistantV2(
  input: RunAssistantInput,
  deps: RunnerDependencies,
): Promise<RunOutcome> {
  const scope: RunScope = input.scope;
  deps.installationGuard.assertCurrent(scope);

  const runs = createRunService(deps);
  const discovery = createApiDiscoveryService(deps);
  const actions = createActionExecutionService(deps);

  let state = deps.runStore.getRun({
    sessionId: scope.sessionId,
    runId: input.runId,
    workspaceId: scope.workspaceId,
    adminUserId: scope.adminUserId,
    installationGeneration: scope.installationGeneration,
    authClass: scope.authClass,
  });
  // A durable run reloaded mid-flight (e.g. after a clarification resolve
  // committed its result and cleared the suspension) has no in-memory message
  // history to resume from — the next model call must summarize what already
  // completed instead of repeating a bare original request (§14-D "resume the
  // same run and event sequence").
  const resumingExistingRun = state !== undefined;

  if (state && isTerminalPhase(state.phase)) {
    if (state.phase === "failed") {
      return runs.budgetStopOutcome(state, "interrupted_before_durable_completion");
    }
    return runs.completeOutcome(state);
  }

  if (state && (state.phase === "awaiting_confirmation" || state.phase === "awaiting_clarification")) {
    if (state.phase === "awaiting_confirmation") {
      return runs.suspendOutcome(state, "awaiting_confirmation", state.continuation.kind === "awaiting_operations"
        ? state.continuation.operationIds[0] ?? input.runId
        : input.runId);
    }
    return runs.suspendOutcome(state, "awaiting_clarification", state.continuation.kind === "awaiting_clarification"
      ? state.continuation.clarificationId
      : input.runId);
  }

  if (!state) {
    if (!input.originalRequest) {
      return { kind: "failed", runId: input.runId, lastSequence: 0, code: "missing_original_request", presentationRefs: [] };
    }
    const prior = deps.runStore.findLatestEligibleRunForCache(
      scope.sessionId,
      scope.workspaceId,
      scope.adminUserId,
      scope.installationGeneration,
      scope.authClass,
      deps.actionRegistry.hash(),
    );
    const loaded = seedCacheFromPriorRun(deps.actionRegistry, prior, deps.actionRegistry.hash());
    state = {
      version: 2,
      runId: input.runId,
      sessionId: scope.sessionId,
      workspaceId: scope.workspaceId,
      adminUserId: scope.adminUserId,
      installationGeneration: scope.installationGeneration,
      authClass: scope.authClass,
      originalRequest: input.originalRequest,
      requestHash: computeRequestHash(input.originalRequest),
      phase: "model",
      registryId: "v2-api",
      catalogHash: deps.actionRegistry.hash(),
      loadedToolNames: [...loaded],
      usedToolNames: [],
      completedResults: [],
      pendingOperationIds: [],
      unfinishedOperations: [],
      continuation: { kind: "none" },
      budget: createEmptyRunBudget(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    deps.eventService.startRun({
      scope: { ...scope, runId: input.runId },
      input: {
        originalRequest: input.originalRequest,
        requestHash: state.requestHash,
        catalogHash: state.catalogHash,
        loadedToolNames: state.loadedToolNames,
        intentHash: input.runId,
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      },
    });
    state = deps.runStore.getRun({ ...scope, runId: input.runId }) ?? state;
  }

  if (signalAborted(input.signal)) {
    return runs.failRun(state, "cancelled");
  }

  let modelCall = state.budget.modelCallsUsed;
  let firstModelCallOfInvocation = true;
  // What this invocation has learned so far. Rebuilt into every model request:
  // v2 persists no provider transcript, so without this the model receives
  // byte-identical input on every iteration and the loop cannot progress.
  const observations: RunObservation[] = [];
  let lastIterationSignature: string | undefined;
  let lastIterationObservations = "";
  let lastDenialCode: string | undefined;
  while (canReserveModelCall(state.budget) && !isTokenBudgetExceeded(state.budget) && !isActiveWallBudgetExceeded(state.budget)) {
    if (signalAborted(input.signal)) {
      return runs.failRun(state, "cancelled");
    }
    modelCall += 1;
    // F22: a resumed model request receives the BOUNDED CANONICAL RECEIPT of
    // each already-completed tool, in provider order — never an opaque result
    // id (which forced the model to repeat reads it could not see).
    const resumeSummaries = firstModelCallOfInvocation && resumingExistingRun && state.completedResults.length > 0
      ? state.completedResults.map((r) => {
          const stored = deps.runStore.getActionResult(r.actionResultId);
          const summary = summarizeActionResultForModel(stored);
          return summary !== undefined
            ? `${r.actionName} returned: ${summary}`
            : `${r.actionName} completed (result ${r.actionResultId}).`;
        })
      : [];
    const adminFollowUp = firstModelCallOfInvocation ? input.continuationMessage : undefined;
    firstModelCallOfInvocation = false;
    const messages = runs.buildFreshMessages(
      state,
      [...resumeSummaries, ...formatObservations(observations)],
      adminFollowUp,
    );
    const tools = discoveryToolsForLoadedSet(deps.actionRegistry, new Set(state.loadedToolNames));
    let completion;
    try {
      ({ completion } = await runs.callModel(state, messages, tools, modelCall, input.signal));
    } catch (error) {
      if (error instanceof ProviderProtocolError) {
        return runs.failRun(state, error.reason);
      }
      return runs.failRun(state, error instanceof Error ? error.message : "model_failed");
    }
    state = deps.runStore.getRun(scopedRun(state)) ?? state;
    // Wall-clock start of the post-model phases (the model call charged its
    // own elapsed time in run-service).
    const iterationStarted = deps.clock.monotonicMs();

    if (completion.toolCalls.length === 0) {
      // The model answered in prose. That text IS the deliverable for a read,
      // so it must reach the admin rather than being replaced by boilerplate.
      return runs.completeRun(state, undefined, completion.text);
    }

    // Closure-plan PR 5 (F03): a fail-safe around the pre-mutation phases.
    // Discovery, reads, and preparation may only end this run as a bounded
    // terminal failure — never an escaped exception that strands the session
    // at an active phase. Durable suspensions return INSIDE the try, so the
    // guard can never overwrite one; confirmed mutation dispatch never runs
    // inside this loop at all.
    let iterationObservations: RunObservation[];
    try {
      const { readCalls, writeCalls, discoveryCalls, denied, duplicateWrite } = actions.partitionToolCalls(
        completion.toolCalls,
        new Set(state.loadedToolNames),
        state.catalogHash,
        scope.authClass,
        // PR 7: provider tool-call ids are unique across the RUN.
        new Set(state.completedResults.map((r) => r.toolCallId)),
      );
      if (duplicateWrite) {
        return runs.failRun(state, "duplicate_write");
      }

      const discovered = await discovery.executeDiscoveryBatch(state, discoveryCalls, scope);
      state = discovered.state;

      iterationObservations = [...discovered.observations];

      const readBatch = await actions.executeReads(state, readCalls, scope, input.signal, denied);
      state = readBatch.state;
      iterationObservations.push(...readBatch.observations);
      if (readBatch.clarification) {
        return runs.suspendOutcome(state, "awaiting_clarification", readBatch.clarification.clarificationId);
      }

      if (writeCalls.length > 0) {
        const writeBatch = await actions.prepareWrites(state, writeCalls, input.runId);
        state = writeBatch.state;
        iterationObservations.push(...writeBatch.observations);
        if (writeBatch.suspended) {
          return runs.suspendOutcome(state, "awaiting_confirmation", writeBatch.suspended.confirmationId);
        }
        if (writeBatch.clarification) {
          return runs.suspendOutcome(state, "awaiting_clarification", writeBatch.clarification.clarificationId);
        }
      }

      const denials = actions.recordDenials(state, denied);
      state = denials.state;
      iterationObservations.push(...denials.observations);
    } catch (error) {
      // A stable server code, never the raw exception text (which can carry
      // Clockify data or driver SQL) — the real cause is logged server-side.
      console.error(
        "v2 iteration failed before durable completion:",
        error instanceof Error ? error.message : String(error),
      );
      state = deps.runStore.getRun(scopedRun(state)) ?? state;
      return runs.failRun(state, "internal_error");
    }

    // Closure-plan PR 7 (F17): discovery/read/preparation time counts toward
    // the 300-second active-wall allowance, not just provider calls. The next
    // loop-condition check (a pre-dispatch boundary) enforces it.
    const iterationElapsed = deps.clock.monotonicMs() - iterationStarted;
    state = deps.runStore.getRun(scopedRun(state)) ?? state;
    state = {
      ...state,
      budget: {
        ...state.budget,
        activeWallMsUsed: state.budget.activeWallMsUsed + Math.max(0, iterationElapsed),
      },
    };
    deps.runStore.saveRun(state);

    observations.push(...iterationObservations);
    const denial = iterationObservations.find((o) => o.kind === "denied");
    if (denial) lastDenialCode = denial.code;

    // A repeat of the same tool calls that produced the same observations is
    // provably not progressing: the next request would be byte-identical to the
    // one just answered. Stop with the reason, instead of spending the rest of
    // the model-call budget rebuilding the same failure and reporting it as
    // `budget_exhausted`.
    const signature = JSON.stringify(completion.toolCalls.map((c) => [c.name, c.arguments]));
    const observationSignature = JSON.stringify(iterationObservations);
    if (signature === lastIterationSignature && observationSignature === lastIterationObservations) {
      return runs.failRun(state, lastDenialCode ?? "no_progress");
    }
    lastIterationSignature = signature;
    lastIterationObservations = observationSignature;

    if (!canReserveModelCall(state.budget)) break;
  }

  // Exhausting the model-call budget after a denial is not a budget problem —
  // report what actually blocked the run.
  return runs.failRun(state, lastDenialCode ?? "budget_exhausted");
}
