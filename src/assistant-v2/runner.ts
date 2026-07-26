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
      },
    });
    state = deps.runStore.getRun({ ...scope, runId: input.runId }) ?? state;
  }

  if (signalAborted(input.signal)) {
    return runs.failRun(state, "cancelled");
  }

  let modelCall = state.budget.modelCallsUsed;
  let firstModelCallOfInvocation = true;
  while (canReserveModelCall(state.budget) && !isTokenBudgetExceeded(state.budget) && !isActiveWallBudgetExceeded(state.budget)) {
    if (signalAborted(input.signal)) {
      return runs.failRun(state, "cancelled");
    }
    modelCall += 1;
    const resumeSummaries = firstModelCallOfInvocation && resumingExistingRun && state.completedResults.length > 0
      ? state.completedResults.map((r) => `${r.actionName} completed (result ${r.actionResultId}).`)
      : [];
    const adminFollowUp = firstModelCallOfInvocation ? input.continuationMessage : undefined;
    firstModelCallOfInvocation = false;
    const messages = runs.buildFreshMessages(state, resumeSummaries, adminFollowUp);
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

    if (completion.toolCalls.length === 0) {
      return runs.completeRun(state);
    }

    const { readCalls, writeCalls, discoveryCalls, denied, duplicateWrite } = actions.partitionToolCalls(
      completion.toolCalls,
      new Set(state.loadedToolNames),
      state.catalogHash,
      scope.authClass,
    );
    if (duplicateWrite) {
      return runs.failRun(state, "duplicate_write");
    }

    const discovered = await discovery.executeDiscoveryBatch(state, discoveryCalls, scope);
    state = discovered.state;
    if (discovered.kind === "budget_exhausted") {
      return runs.failRun(state, discovered.code);
    }

    const readBatch = await actions.executeReads(state, readCalls, scope, input.signal, denied);
    state = readBatch.state;
    if (readBatch.clarification) {
      return runs.suspendOutcome(state, "awaiting_clarification", readBatch.clarification.clarificationId);
    }

    if (writeCalls.length > 0) {
      const writeBatch = await actions.prepareWrites(state, writeCalls, scope, input.runId);
      state = writeBatch.state;
      if (writeBatch.suspended) {
        return runs.suspendOutcome(state, "awaiting_confirmation", writeBatch.suspended.confirmationId);
      }
    }

    state = actions.recordDenials(state, denied);

    if (!canReserveModelCall(state.budget)) break;
  }

  return runs.failRun(state, "budget_exhausted");
}
