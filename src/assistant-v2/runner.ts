import type { ModelMessage, ToolCall, ToolDefinition } from "../assistant/model-client.js";
import { ProviderProtocolError } from "../assistant/model-client.js";
import { DISCOVERY_META_TOOL_NAME } from "../harness/api-operation.js";
import {
  initialV2ToolSet,
  refineLoadedToolSet,
  validateLoadedToolCall,
  type LoadedToolValidationFailure,
} from "./discovery/api-search-tool.js";
import {
  V2_LIMITS,
  canReserveApiCall,
  canReserveDiscoveryCall,
  canReserveModelCall,
  chargeFailedModelAttempt,
  chargeSuccessfulModelAttempt,
  isActiveWallBudgetExceeded,
  isTokenBudgetExceeded,
  preflightModelRequest,
  serializeModelRequestForPreflight,
  utf8ByteLength,
} from "./budgets.js";
import { buildResumeUserMessage, buildV2SystemPrompt } from "./prompt.js";
import { computeArgumentsHash } from "./events.js";
import type {
  NativeToolModelClient,
  ReadExecutionOutcome,
  RunAssistantInput,
  RunOutcome,
  RunnerDependencies,
  RunScope,
  WritePreparationOutcome,
} from "./protocol.js";
import {
  computeRequestHash,
  createEmptyRunBudget,
  isTerminalPhase,
  type RunState,
} from "./state.js";
import { discoveryToolsForLoadedSet } from "../harness/tools.js";
import type { ActionRegistry } from "../harness/api-catalog.js";

export type DeniedToolCall = {
  toolCallId: string;
  actionName: string;
  code: string;
};

function loadedToolSetFromState(state: RunState): Set<string> {
  return new Set(state.loadedToolNames);
}

function toolsForState(registry: ActionRegistry, state: RunState): ToolDefinition[] {
  return discoveryToolsForLoadedSet(registry, loadedToolSetFromState(state));
}

function serializeToolsForPreflight(tools: ToolDefinition[]): string {
  return JSON.stringify(tools);
}

function serializeMessagesForPreflight(messages: ModelMessage[]): string {
  return JSON.stringify(messages);
}

function denyCode(reason: LoadedToolValidationFailure | "duplicate_tool_call_id" | "mixed_discovery_batch" | "budget_exhausted" | "read_write_dependency" | "duplicate_write" | "too_many_refinements" | "write_port_not_ready"): string {
  return reason;
}

function validateCompletionToolCalls(
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

async function executeReadsConcurrently(
  calls: ToolCall[],
  scope: RunScope,
  deps: RunnerDependencies,
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

function seedCacheFromPriorRun(
  registry: ActionRegistry,
  prior: RunState | undefined,
  currentCatalogHash: string,
): ReadonlySet<string> {
  if (!prior || prior.registryId !== "v2-api" || prior.catalogHash !== currentCatalogHash) {
    return initialV2ToolSet(registry);
  }
  const used = [...prior.usedToolNames].reverse();
  const unused = prior.loadedToolNames.filter((name) => !prior.usedToolNames.includes(name));
  const ordered = [...used, ...unused].filter((name, index, all) => all.indexOf(name) === index);
  return initialV2ToolSet(registry, ordered);
}

function buildFreshMessages(state: RunState, resumeSummaries: string[] = [], adminFollowUp?: string): ModelMessage[] {
  const userContent = resumeSummaries.length > 0 || adminFollowUp
    ? buildResumeUserMessage({
        originalRequest: state.originalRequest,
        structuredSummaries: resumeSummaries,
        adminFollowUp,
      })
    : state.originalRequest;
  return [
    { role: "system", content: buildV2SystemPrompt() },
    { role: "user", content: userContent },
  ];
}

function scopedRun(state: RunState): RunScope & { runId: string } {
  return {
    sessionId: state.sessionId,
    workspaceId: state.workspaceId,
    adminUserId: state.adminUserId,
    installationGeneration: state.installationGeneration,
    authClass: state.authClass,
    runId: state.runId,
  };
}

function lastSequence(deps: RunnerDependencies, state: RunState): number {
  return deps.runStore.getLastRunEventSequence(scopedRun(state));
}

function budgetStopOutcome(deps: RunnerDependencies, state: RunState, code: string): RunOutcome {
  return {
    kind: "failed",
    runId: state.runId,
    lastSequence: lastSequence(deps, state),
    code,
    presentationRefs: state.completedResults.map((r) => ({ kind: "action_result", id: r.actionResultId })),
  };
}

function suspendOutcome(
  deps: RunnerDependencies,
  state: RunState,
  reason: "awaiting_confirmation" | "awaiting_clarification",
  continuationId: string,
): RunOutcome {
  return {
    kind: "suspended",
    runId: state.runId,
    lastSequence: lastSequence(deps, state),
    reason,
    continuationId,
    presentationRefs: state.completedResults.map((r) => ({ kind: "action_result", id: r.actionResultId })),
  };
}

function completeOutcome(deps: RunnerDependencies, state: RunState): RunOutcome {
  return {
    kind: "completed",
    runId: state.runId,
    lastSequence: lastSequence(deps, state),
    presentationRefs: state.completedResults.map((r) => ({ kind: "action_result", id: r.actionResultId })),
  };
}

function failRun(deps: RunnerDependencies, state: RunState, code: string): RunOutcome {
  deps.eventService.failRun({
    scope: scopedRun(state),
    state,
    payload: { code },
  });
  state = deps.runStore.getRun(scopedRun(state)) ?? state;
  return budgetStopOutcome(deps, state, code);
}

function completeRun(deps: RunnerDependencies, state: RunState, chatMessageId?: string): RunOutcome {
  deps.eventService.completeRun({
    scope: scopedRun(state),
    state,
    payload: {
      chatMessageId,
      actionResultIds: state.completedResults.map((r) => r.actionResultId),
    },
  });
  state = deps.runStore.getRun(scopedRun(state)) ?? state;
  return completeOutcome(deps, state);
}

async function callModel(
  deps: RunnerDependencies,
  state: RunState,
  messages: ModelMessage[],
  tools: ToolDefinition[],
  modelCall: number,
  signal?: AbortSignal,
): Promise<{ completion: Awaited<ReturnType<NativeToolModelClient["completeWithTools"]>>; providerAttempts: 1 | 2; latencyMs: number }> {
  const requestBytes = serializeModelRequestForPreflight(
    serializeMessagesForPreflight(messages),
    serializeToolsForPreflight(tools),
  );
  const preflight = preflightModelRequest(state.budget, requestBytes);
  if (!preflight.ok) throw new Error("token_budget_exhausted");
  let providerAttempts: 1 | 2 = 1;
  deps.eventService.reserveModelCall({
    scope: scopedRun(state),
    state,
    payload: {
      modelCall,
      providerAttempt: 1,
      loadedOperationIds: state.loadedToolNames.filter((n) => n !== DISCOVERY_META_TOOL_NAME),
      cacheSeeded: state.usedToolNames.length > 0,
    },
  });
  state = deps.runStore.getRun(scopedRun(state)) ?? state;
  const started = deps.clock.monotonicMs();
  try {
    const completion = await deps.modelClient.completeWithTools(messages, tools, signal, {
      maxOutputTokens: preflight.maxOutputTokens,
      onProviderAttempt: (attempt) => {
        if (attempt === 2 && providerAttempts === 1) {
          providerAttempts = 2;
          deps.eventService.reserveModelCall({
            scope: scopedRun(state),
            state: deps.runStore.getRun(scopedRun(state)) ?? state,
            payload: {
              modelCall,
              providerAttempt: 2,
              loadedOperationIds: state.loadedToolNames.filter((n) => n !== DISCOVERY_META_TOOL_NAME),
              cacheSeeded: state.usedToolNames.length > 0,
            },
          });
        }
      },
    });
    const responseBytes = utf8ByteLength(JSON.stringify(completion));
    state = deps.runStore.getRun(scopedRun(state)) ?? state;
    state.budget = chargeSuccessfulModelAttempt(
      state.budget,
      completion.usage
        ? { promptTokens: completion.usage.promptTokens, completionTokens: completion.usage.completionTokens }
        : undefined,
      requestBytes,
      responseBytes,
    );
    const latencyMs = deps.clock.monotonicMs() - started;
    deps.eventService.completeModelCall({
      scope: scopedRun(state),
      state,
      payload: {
        modelCall,
        providerAttempts,
        usage: {
          promptTokens: completion.usage?.promptTokens,
          completionTokens: completion.usage?.completionTokens,
        },
        latencyMs,
      },
    });
    state = deps.runStore.getRun(scopedRun(state)) ?? state;
    return { completion, providerAttempts, latencyMs };
  } catch (error) {
    state = deps.runStore.getRun(scopedRun(state)) ?? state;
    if (providerAttempts === 1) {
      state.budget = chargeFailedModelAttempt(state.budget, preflight.inputReserve, preflight.maxOutputTokens);
    }
    throw error;
  } finally {
    state = deps.runStore.getRun(scopedRun(state)) ?? state;
    state.budget = {
      ...state.budget,
      activeWallMsUsed: state.budget.activeWallMsUsed + (deps.clock.monotonicMs() - started),
    };
    deps.runStore.saveRun({ ...state, updatedAt: new Date().toISOString() });
  }
}

function isWriteAction(registry: ActionRegistry, name: string): boolean {
  return registry.get(name)?.apiOperation?.access === "write";
}

function isReadAction(registry: ActionRegistry, name: string): boolean {
  return registry.get(name)?.apiOperation?.access === "read";
}

export async function runAssistantV2(
  input: RunAssistantInput,
  deps: RunnerDependencies,
): Promise<RunOutcome> {
  const scope: RunScope = input.scope;
  deps.installationGuard.assertCurrent(scope);

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
      return budgetStopOutcome(deps, state, "interrupted_before_durable_completion");
    }
    return completeOutcome(deps, state);
  }

  if (state && (state.phase === "awaiting_confirmation" || state.phase === "awaiting_clarification")) {
    if (state.phase === "awaiting_confirmation") {
      return suspendOutcome(deps, state, "awaiting_confirmation", state.continuation.kind === "awaiting_operations"
        ? state.continuation.operationIds[0] ?? input.runId
        : input.runId);
    }
    return suspendOutcome(deps, state, "awaiting_clarification", state.continuation.kind === "awaiting_clarification"
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
    return failRun(deps, state, "cancelled");
  }

  let modelCall = state.budget.modelCallsUsed;
  let firstModelCallOfInvocation = true;
  while (canReserveModelCall(state.budget) && !isTokenBudgetExceeded(state.budget) && !isActiveWallBudgetExceeded(state.budget)) {
    if (signalAborted(input.signal)) {
      return failRun(deps, state, "cancelled");
    }
    modelCall += 1;
    const resumeSummaries = firstModelCallOfInvocation && resumingExistingRun && state.completedResults.length > 0
      ? state.completedResults.map((r) => `${r.actionName} completed (result ${r.actionResultId}).`)
      : [];
    const adminFollowUp = firstModelCallOfInvocation ? input.continuationMessage : undefined;
    firstModelCallOfInvocation = false;
    const messages = buildFreshMessages(state, resumeSummaries, adminFollowUp);
    const tools = toolsForState(deps.actionRegistry, state);
    let completion;
    try {
      ({ completion } = await callModel(deps, state, messages, tools, modelCall, input.signal));
    } catch (error) {
      if (error instanceof ProviderProtocolError) {
        return failRun(deps, state, error.reason);
      }
      return failRun(deps, state, error instanceof Error ? error.message : "model_failed");
    }
    state = deps.runStore.getRun(scopedRun(state)) ?? state;

    if (completion.toolCalls.length === 0) {
      return completeRun(deps, state);
    }

    const loadedSet = loadedToolSetFromState(state);
    const { accepted, denied } = validateCompletionToolCalls(
      completion.toolCalls,
      loadedSet,
      deps.actionRegistry,
      state.catalogHash,
      scope.authClass,
    );

    const readCalls: ToolCall[] = [];
    const writeCalls: ToolCall[] = [];
    const discoveryCalls: ToolCall[] = [];
    for (const call of accepted) {
      if (call.name === DISCOVERY_META_TOOL_NAME) discoveryCalls.push(call);
      else if (isWriteAction(deps.actionRegistry, call.name)) writeCalls.push(call);
      else if (isReadAction(deps.actionRegistry, call.name)) readCalls.push(call);
      else writeCalls.push(call);
    }

    if (readCalls.length > 0 && writeCalls.length > 0) {
      for (const call of writeCalls) {
        denied.push({ toolCallId: call.id, actionName: call.name, code: denyCode("read_write_dependency") });
      }
      writeCalls.length = 0;
    }

    const writeNames = writeCalls.map((c) => `${c.name}:${JSON.stringify(c.arguments)}`);
    if (new Set(writeNames).size !== writeNames.length) {
      return failRun(deps, state, denyCode("duplicate_write"));
    }

    let searchIndex = state.budget.discoveryCallsUsed;
    for (const call of discoveryCalls) {
      if (!canReserveDiscoveryCall(state.budget)) {
        return failRun(deps, state, denyCode("too_many_refinements"));
      }
      searchIndex += 1;
      const parsed = call.arguments as { query?: string; access?: "read" | "write" | "any" };
      deps.eventService.reserveDiscoveryCall({
        scope: scopedRun(state),
        state,
        payload: {
          searchIndex,
          access: parsed.access ?? "any",
          groups: [],
        },
      });
      state = deps.runStore.getRun(scopedRun(state)) ?? state;
      const searchResult = await deps.discovery.search({ query: String(parsed.query ?? "") }, scope);
      state.loadedToolNames = [...refineLoadedToolSet(loadedToolSetFromState(state), new Set(state.usedToolNames), searchResult)];
      if (!state.usedToolNames.includes(call.name)) state.usedToolNames.push(call.name);
      deps.eventService.loadOperations({
        scope: scopedRun(state),
        state,
        payload: {
          operationIds: state.loadedToolNames.filter((n) => n !== DISCOVERY_META_TOOL_NAME),
          source: "discovery",
        },
      });
      state = deps.runStore.getRun(scopedRun(state)) ?? state;
    }

    const readOutcomes: Array<{ call: ToolCall; outcome: ReadExecutionOutcome }> = [];
    const readCallsToRun: ToolCall[] = [];
    for (const call of readCalls) {
      if (!canReserveApiCall(state.budget)) {
        denied.push({ toolCallId: call.id, actionName: call.name, code: denyCode("budget_exhausted") });
        continue;
      }
      readCallsToRun.push(call);
    }
    await executeReadsConcurrently(readCallsToRun, scope, deps, input.signal, (call, outcome) => {
      readOutcomes.push({ call, outcome });
    });

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
      } else if (outcome.kind === "clarification") {
        state.continuation = { kind: "awaiting_clarification", clarificationId: outcome.clarificationId };
        deps.eventService.suspendRun({
          scope: scopedRun(state),
          state,
          payload: { reason: "awaiting_clarification" },
        });
        state = deps.runStore.getRun(scopedRun(state)) ?? state;
        return suspendOutcome(deps, state, "awaiting_clarification", outcome.clarificationId);
      }
    }

    if (writeCalls.length > 0) {
      for (const _call of writeCalls) {
        if (!canReserveApiCall(state.budget)) break;
      }
      let preparation: WritePreparationOutcome;
      try {
        preparation = await deps.preparations.prepare(writeCalls, scope);
      } catch {
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
        return suspendOutcome(deps, state, "awaiting_confirmation", preparation.confirmationIds[0] ?? input.runId);
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
        }
      }
    }

    for (const d of denied) {
      deps.eventService.denyTool({
        scope: scopedRun(state),
        state,
        payload: {
          toolCallId: d.toolCallId,
          actionName: d.actionName,
          code: d.code,
        },
      });
      state = deps.runStore.getRun(scopedRun(state)) ?? state;
    }

    if (!canReserveModelCall(state.budget)) break;
  }

  return failRun(deps, state, "budget_exhausted");
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export { seedCacheFromPriorRun, validateCompletionToolCalls, executeReadsConcurrently };
