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
  incrementApiCallsUsed,
  incrementDiscoveryCallsUsed,
  incrementModelCallsUsed,
  isActiveWallBudgetExceeded,
  isTokenBudgetExceeded,
  preflightModelRequest,
  serializeModelRequestForPreflight,
  utf8ByteLength,
} from "./budgets.js";
import { buildResumeUserMessage, buildV2SystemPrompt } from "./prompt.js";
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
  type CompletedToolResult,
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

function toRunScope(state: RunState): RunScope {
  return {
    sessionId: state.sessionId,
    workspaceId: state.workspaceId,
    adminUserId: state.adminUserId,
    installationGeneration: state.installationGeneration,
    authClass: state.authClass,
  };
}

function buildFreshMessages(state: RunState, resumeSummaries: string[] = []): ModelMessage[] {
  const userContent = resumeSummaries.length > 0
    ? buildResumeUserMessage({
        originalRequest: state.originalRequest,
        structuredSummaries: resumeSummaries,
      })
    : state.originalRequest;
  return [
    { role: "system", content: buildV2SystemPrompt() },
    { role: "user", content: userContent },
  ];
}

function budgetStopOutcome(state: RunState, code: string): RunOutcome {
  return {
    kind: "failed",
    runId: state.runId,
    code,
    presentationRefs: state.completedResults.map((r) => ({ kind: "action_result", id: r.actionResultId })),
  };
}

function suspendOutcome(
  state: RunState,
  reason: "awaiting_confirmation" | "awaiting_clarification",
  continuationId: string,
): RunOutcome {
  return {
    kind: "suspended",
    runId: state.runId,
    reason,
    continuationId,
    presentationRefs: state.completedResults.map((r) => ({ kind: "action_result", id: r.actionResultId })),
  };
}

function completeOutcome(state: RunState): RunOutcome {
  return {
    kind: "completed",
    runId: state.runId,
    presentationRefs: state.completedResults.map((r) => ({ kind: "action_result", id: r.actionResultId })),
  };
}

function persistState(deps: RunnerDependencies, state: RunState): void {
  deps.installationGuard.assertCurrent(toRunScope(state));
  deps.runStore.saveRun({ ...state, updatedAt: new Date().toISOString() });
}

async function callModel(
  deps: RunnerDependencies,
  state: RunState,
  messages: ModelMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
): Promise<{ completion: Awaited<ReturnType<NativeToolModelClient["completeWithTools"]>>; providerAttempts: 1 | 2 }> {
  const requestBytes = serializeModelRequestForPreflight(
    serializeMessagesForPreflight(messages),
    serializeToolsForPreflight(tools),
  );
  const preflight = preflightModelRequest(state.budget, requestBytes);
  if (!preflight.ok) throw new Error("token_budget_exhausted");
  let providerAttempts: 1 | 2 = 1;
  const started = deps.clock.monotonicMs();
  try {
    const completion = await deps.modelClient.completeWithTools(messages, tools, signal, {
      maxOutputTokens: preflight.maxOutputTokens,
      onProviderAttempt: (attempt) => {
        providerAttempts = attempt;
      },
    });
    const responseBytes = utf8ByteLength(JSON.stringify(completion));
    state.budget = chargeSuccessfulModelAttempt(
      state.budget,
      completion.usage
        ? { promptTokens: completion.usage.promptTokens, completionTokens: completion.usage.completionTokens }
        : undefined,
      requestBytes,
      responseBytes,
    );
    return { completion, providerAttempts };
  } catch (error) {
    if (providerAttempts === 1) {
      state.budget = chargeFailedModelAttempt(state.budget, preflight.inputReserve, preflight.maxOutputTokens);
    }
    throw error;
  } finally {
    state.budget = {
      ...state.budget,
      activeWallMsUsed: state.budget.activeWallMsUsed + (deps.clock.monotonicMs() - started),
    };
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

  if (state && isTerminalPhase(state.phase)) {
    if (state.phase === "failed") {
      return budgetStopOutcome(state, "interrupted_before_durable_completion");
    }
    return completeOutcome(state);
  }

  if (state && (state.phase === "awaiting_confirmation" || state.phase === "awaiting_clarification")) {
    if (state.phase === "awaiting_confirmation") {
      return suspendOutcome(state, "awaiting_confirmation", state.continuation.kind === "awaiting_operations"
        ? state.continuation.operationIds[0] ?? input.runId
        : input.runId);
    }
    return suspendOutcome(state, "awaiting_clarification", state.continuation.kind === "awaiting_clarification"
      ? state.continuation.clarificationId
      : input.runId);
  }

  if (!state) {
    if (!input.originalRequest) {
      return { kind: "failed", runId: input.runId, code: "missing_original_request", presentationRefs: [] };
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
    deps.runStore.startRunWithTurn({
      scope: { ...scope, runId: input.runId },
      originalRequest: input.originalRequest,
      requestHash: state.requestHash,
      catalogHash: state.catalogHash,
      loadedToolNames: state.loadedToolNames,
      intentHash: input.runId,
    });
    state = deps.runStore.getRun({ ...scope, runId: input.runId }) ?? state;
  }

  if (signalAborted(input.signal)) {
    state.phase = "failed";
    persistState(deps, state);
    return budgetStopOutcome(state, "cancelled");
  }

  while (canReserveModelCall(state.budget) && !isTokenBudgetExceeded(state.budget) && !isActiveWallBudgetExceeded(state.budget)) {
    if (signalAborted(input.signal)) {
      state.phase = "failed";
      persistState(deps, state);
      return budgetStopOutcome(state, "cancelled");
    }
    state.phase = "model";
    state.budget = incrementModelCallsUsed(state.budget);
    persistState(deps, state);
    const messages = buildFreshMessages(state);
    const tools = toolsForState(deps.actionRegistry, state);
    let completion;
    try {
      ({ completion } = await callModel(deps, state, messages, tools, input.signal));
    } catch (error) {
      if (error instanceof ProviderProtocolError) {
        state.phase = "failed";
        persistState(deps, state);
        return budgetStopOutcome(state, error.reason);
      }
      state.phase = "failed";
      persistState(deps, state);
      return budgetStopOutcome(state, error instanceof Error ? error.message : "model_failed");
    }

    if (completion.toolCalls.length === 0) {
      state.phase = "completed";
      persistState(deps, state);
      return completeOutcome(state);
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
      state.phase = "failed";
      persistState(deps, state);
      return budgetStopOutcome(state, denyCode("duplicate_write"));
    }

    state.phase = "discovering";
    persistState(deps, state);
    for (const call of discoveryCalls) {
      if (!canReserveDiscoveryCall(state.budget)) {
        state.phase = "failed";
        persistState(deps, state);
        return budgetStopOutcome(state, denyCode("too_many_refinements"));
      }
      state.budget = incrementDiscoveryCallsUsed(state.budget);
      const parsed = call.arguments as { query?: string };
      const searchResult = await deps.discovery.search({ query: String(parsed.query ?? "") }, scope);
      state.loadedToolNames = [...refineLoadedToolSet(loadedToolSetFromState(state), new Set(state.usedToolNames), searchResult)];
      if (!state.usedToolNames.includes(call.name)) state.usedToolNames.push(call.name);
      persistState(deps, state);
    }

    state.phase = "executing_reads";
    persistState(deps, state);
    const readOutcomes: Array<{ call: ToolCall; outcome: ReadExecutionOutcome }> = [];
    const readCallsToRun: ToolCall[] = [];
    for (const call of readCalls) {
      if (!canReserveApiCall(state.budget)) {
        denied.push({ toolCallId: call.id, actionName: call.name, code: denyCode("budget_exhausted") });
        continue;
      }
      state.budget = incrementApiCallsUsed(state.budget);
      readCallsToRun.push(call);
    }
    await executeReadsConcurrently(readCallsToRun, scope, deps, input.signal, (call, outcome) => {
      readOutcomes.push({ call, outcome });
    });

    for (const { call, outcome } of readOutcomes) {
      if (!state.usedToolNames.includes(call.name)) state.usedToolNames.push(call.name);
      if (outcome.kind === "succeeded") {
        const link: CompletedToolResult = {
          toolCallId: call.id,
          actionName: call.name,
          actionResultId: outcome.actionResultId,
        };
        state.completedResults.push(link);
      } else if (outcome.kind === "clarification") {
        state.phase = "awaiting_clarification";
        state.continuation = { kind: "awaiting_clarification", clarificationId: outcome.clarificationId };
        persistState(deps, state);
        return suspendOutcome(state, "awaiting_clarification", outcome.clarificationId);
      }
    }

    if (writeCalls.length > 0) {
      state.phase = "preparing_writes";
      persistState(deps, state);
      for (const _call of writeCalls) {
        if (!canReserveApiCall(state.budget)) break;
        state.budget = incrementApiCallsUsed(state.budget);
      }
      let preparation: WritePreparationOutcome;
      try {
        preparation = await deps.preparations.prepare(writeCalls, scope);
      } catch {
        preparation = { kind: "not_ready", code: "write_port_not_ready", actionResultId: "prep-failed" };
      }
      if (preparation.kind === "prepared") {
        state.phase = "awaiting_confirmation";
        state.continuation = { kind: "awaiting_operations", operationIds: preparation.operationIds, batchId: preparation.batchId };
        state.pendingOperationIds = preparation.operationIds;
        persistState(deps, state);
        return suspendOutcome(state, "awaiting_confirmation", preparation.confirmationIds[0] ?? input.runId);
      }
      if (preparation.kind === "not_ready") {
        const link: CompletedToolResult = {
          toolCallId: writeCalls[0]?.id ?? "unknown",
          actionName: writeCalls[0]?.name ?? "unknown",
          actionResultId: preparation.actionResultId,
        };
        state.completedResults.push(link);
      }
    }

    for (const d of denied) {
      void d;
    }

    persistState(deps, state);
    if (!canReserveModelCall(state.budget)) break;
  }

  state.phase = "failed";
  persistState(deps, state);
  return budgetStopOutcome(state, "budget_exhausted");
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export { seedCacheFromPriorRun, validateCompletionToolCalls, executeReadsConcurrently };
