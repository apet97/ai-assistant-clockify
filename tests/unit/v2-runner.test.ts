import { describe, expect, it, vi } from "vitest";
import { runAssistantV2 } from "../../src/assistant-v2/runner.js";
import {
  createActionExecutionService,
  executeReadsConcurrently,
  validateCompletionToolCalls,
} from "../../src/services/action-execution-service.js";
import { seedCacheFromPriorRun } from "../../src/services/api-discovery-service.js";
import { DISCOVERY_META_TOOL_NAME } from "../../src/harness/api-operation.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import type { RunnerDependencies, RunScope } from "../../src/assistant-v2/protocol.js";
import type { RunState } from "../../src/assistant-v2/state.js";
import type { ToolCall } from "../../src/assistant/model-client.js";

function baseScope(): RunScope {
  return {
    sessionId: "session-1",
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    installationGeneration: 1,
    authClass: "addon",
  };
}

function fakeEventLayer() {
  let sequence = 0;
  const next = (runId: string, eventType: string) => ({
    runId,
    sequence: ++sequence,
    event: { eventType, payload: {}, createdAt: new Date().toISOString() },
  });
  const eventStore = {
    reserveModelCallWithEvent: vi.fn((_s, _st, _p) => next("run", "model.started")),
    completeModelCallWithEvent: vi.fn((_s, _st, _p) => next("run", "model.completed")),
    reserveDiscoveryCallWithEvent: vi.fn((_s, _st, _p) => next("run", "api.search_started")),
    loadOperationsWithEvent: vi.fn((_s, _st, _p) => next("run", "api.operations_loaded")),
    requestToolWithEvent: vi.fn((_s, _st, _p) => next("run", "tool.requested")),
    denyToolWithEvent: vi.fn((_s, _st, _p) => next("run", "tool.denied")),
    startToolWithEvent: vi.fn((_s, _st, _p) => next("run", "tool.started")),
    completeToolWithEvent: vi.fn((_s, _st, _p) => next("run", "tool.completed")),
    requireClarificationWithEvent: vi.fn((_s, _st, _p) => next("run", "clarification.required")),
    suspendRunWithEvent: vi.fn((_s, _st, _p) => next("run", "run.suspended")),
    completeRunWithEvent: vi.fn((_s, _st, _p) => next("run", "run.completed")),
    failRunWithEvent: vi.fn((_s, _st, _p) => next("run", "run.failed")),
    getLastRunEventSequence: vi.fn(() => sequence),
  };
  const eventService = {
    startRun: vi.fn(() => next("run", "run.started")),
    reserveModelCall: vi.fn((input) => eventStore.reserveModelCallWithEvent({}, input.state, input.payload)),
    completeModelCall: vi.fn((input) => eventStore.completeModelCallWithEvent({}, input.state, input.payload)),
    reserveDiscoveryCall: vi.fn((input) => eventStore.reserveDiscoveryCallWithEvent({}, input.state, input.payload)),
    loadOperations: vi.fn((input) => eventStore.loadOperationsWithEvent({}, input.state, input.payload)),
    requestTool: vi.fn((input) => eventStore.requestToolWithEvent({}, input.state, input.payload)),
    denyTool: vi.fn((input) => eventStore.denyToolWithEvent({}, input.state, input.payload)),
    startTool: vi.fn((input) => eventStore.startToolWithEvent({}, input.state, input.payload)),
    completeTool: vi.fn((input) => eventStore.completeToolWithEvent({}, input.state, input.payload)),
    requireClarification: vi.fn((input) => eventStore.requireClarificationWithEvent({}, input.state, input.payload)),
    suspendRun: vi.fn((input) => eventStore.suspendRunWithEvent({}, input.state, input.payload)),
    completeRun: vi.fn((input) => eventStore.completeRunWithEvent({}, input.state, input.payload)),
    failRun: vi.fn((input) => eventStore.failRunWithEvent({}, input.state, input.payload)),
  };
  return { eventStore, eventService };
}

function fakeDeps(overrides: Partial<RunnerDependencies> = {}): RunnerDependencies {
  const modelClient = {
    complete: vi.fn(),
    completeWithTools: vi.fn(async () => ({ text: "done", toolCalls: [] })),
  };
  const { eventService } = fakeEventLayer();
  const store = {
    startRunWithTurn: vi.fn(),
    startRunWithEvent: vi.fn(),
    getRun: vi.fn(() => undefined),
    saveRun: vi.fn(),
    getLastRunEventSequence: vi.fn(() => 0),
    findLatestEligibleRunForCache: vi.fn(() => undefined),
    recoverOrphanedActiveRuns: vi.fn(() => 0),
    failActiveRunsForSession: vi.fn(() => 0),
  };
  return {
    modelClient,
    runStore: store as unknown as RunnerDependencies["runStore"],
    eventService: eventService as unknown as RunnerDependencies["eventService"],
    eventViews: { list: vi.fn(() => ({ runId: "run", events: [], nextAfter: 0, hasMore: false, lastSequence: 0 })) },
    actionRegistry: MODEL_API_ACTION_CATALOG,
    discovery: {
      search: vi.fn(async () => ({ kind: "matches" as const, query: "x", access: "any" as const, operations: [] })),
    },
    reads: {
      execute: vi.fn(async () => ({ kind: "succeeded" as const, actionResultId: "result-1" })),
    },
    preparations: {
      prepare: vi.fn(async () => ({ kind: "not_ready" as const, code: "write_port_not_ready" as const, actionResultId: "prep-1" })),
    },
    installationGuard: { assertCurrent: vi.fn() },
    requestGovernor: {
      runRead: vi.fn(async (_scope, op) => op()),
      remainingHostCalls: vi.fn(() => 60),
      persistHostCallAllowance: vi.fn(),
    },
    clock: { now: () => new Date(), monotonicMs: () => 0 },
    ...overrides,
  } as RunnerDependencies;
}

describe("validateCompletionToolCalls", () => {
  it("denies mixed discovery and API calls, keeping discovery only", () => {
    const loaded = new Set([DISCOVERY_META_TOOL_NAME, "clockify_projects_list"]);
    const calls: ToolCall[] = [
      { id: "c1", name: DISCOVERY_META_TOOL_NAME, arguments: { query: "projects" } },
      { id: "c2", name: "clockify_projects_list", arguments: {} },
    ];
    const result = validateCompletionToolCalls(
      calls,
      loaded,
      MODEL_API_ACTION_CATALOG,
      MODEL_API_ACTION_CATALOG.hash(),
      "addon",
    );
    expect(result.accepted.map((c) => c.name)).toEqual([DISCOVERY_META_TOOL_NAME]);
    expect(result.denied[0]?.code).toBe("mixed_discovery_batch");
  });

  it("rejects duplicate tool call ids", () => {
    const loaded = new Set([DISCOVERY_META_TOOL_NAME, "clockify_projects_list"]);
    const calls: ToolCall[] = [
      { id: "dup", name: "clockify_projects_list", arguments: {} },
      { id: "dup", name: "clockify_projects_list", arguments: {} },
    ];
    const result = validateCompletionToolCalls(
      calls,
      loaded,
      MODEL_API_ACTION_CATALOG,
      MODEL_API_ACTION_CATALOG.hash(),
      "addon",
    );
    expect(result.denied.some((d) => d.code === "duplicate_tool_call_id")).toBe(true);
  });
});

describe("seedCacheFromPriorRun", () => {
  it("reuses used tools in most-recent order when catalog hash matches", () => {
    const prior: RunState = {
      version: 2,
      runId: "old",
      sessionId: "s",
      workspaceId: "ws",
      adminUserId: "a",
      installationGeneration: 1,
      authClass: "addon",
      originalRequest: "x",
      requestHash: "h",
      phase: "completed",
      registryId: "v2-api",
      catalogHash: MODEL_API_ACTION_CATALOG.hash(),
      loadedToolNames: [DISCOVERY_META_TOOL_NAME, "clockify_projects_list", "clockify_clients_list"],
      usedToolNames: ["clockify_clients_list", "clockify_projects_list"],
      completedResults: [],
      pendingOperationIds: [],
      unfinishedOperations: [],
      continuation: { kind: "none" },
      budget: {
        modelCallsUsed: 0,
        discoveryCallsUsed: 0,
        apiCallsUsed: 0,
        hostCallsUsed: 0,
        hostCallsReserved: 0,
        promptTokensUsed: 0,
        completionTokensUsed: 0,
        estimatedTokensUsed: 0,
        activeWallMsUsed: 0,
      },
      createdAt: "t",
      updatedAt: "t",
    };
    const seeded = seedCacheFromPriorRun(MODEL_API_ACTION_CATALOG, prior, MODEL_API_ACTION_CATALOG.hash());
    expect(seeded.has("clockify_clients_list")).toBe(true);
    expect(seeded.has(DISCOVERY_META_TOOL_NAME)).toBe(true);
  });

  it("starts discovery-only when catalog hash mismatches", () => {
    const seeded = seedCacheFromPriorRun(MODEL_API_ACTION_CATALOG, undefined, "dead".repeat(16));
    expect(seeded.has(DISCOVERY_META_TOOL_NAME)).toBe(true);
    expect([...seeded].filter((n) => n !== DISCOVERY_META_TOOL_NAME)).toHaveLength(0);
  });
});

describe("runAssistantV2", () => {
  it("completes a plain answer without tool calls", async () => {
    const deps = fakeDeps();
    const outcome = await runAssistantV2({
      runId: "run-1",
      scope: baseScope(),
      originalRequest: "hello",
    }, deps);
    expect(outcome.kind).toBe("completed");
    expect(deps.modelClient.completeWithTools).toHaveBeenCalledTimes(1);
  });

  it("replays a terminal completed run with zero model calls", async () => {
    const completed: RunState = {
      version: 2,
      runId: "run-1",
      sessionId: "session-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      installationGeneration: 1,
      authClass: "addon",
      originalRequest: "hello",
      requestHash: "h".repeat(64),
      phase: "completed",
      registryId: "v2-api",
      catalogHash: MODEL_API_ACTION_CATALOG.hash(),
      loadedToolNames: [DISCOVERY_META_TOOL_NAME],
      usedToolNames: [],
      completedResults: [],
      pendingOperationIds: [],
      unfinishedOperations: [],
      continuation: { kind: "none" },
      budget: {
        modelCallsUsed: 1,
        discoveryCallsUsed: 0,
        apiCallsUsed: 0,
        hostCallsUsed: 0,
        hostCallsReserved: 0,
        promptTokensUsed: 0,
        completionTokensUsed: 0,
        estimatedTokensUsed: 0,
        activeWallMsUsed: 0,
      },
      createdAt: "t",
      updatedAt: "t",
    };
    const deps = fakeDeps({
      runStore: {
        startRunWithTurn: vi.fn(),
        startRunWithEvent: vi.fn(),
        getRun: vi.fn(() => completed),
        saveRun: vi.fn(),
        getLastRunEventSequence: vi.fn(() => 1),
        findLatestEligibleRunForCache: vi.fn(() => undefined),
        recoverOrphanedActiveRuns: vi.fn(() => 0),
        failActiveRunsForSession: vi.fn(() => 0),
      } as unknown as RunnerDependencies["runStore"],
    });
    const outcome = await runAssistantV2({ runId: "run-1", scope: baseScope() }, deps);
    expect(outcome.kind).toBe("completed");
    expect(deps.modelClient.completeWithTools).not.toHaveBeenCalled();
  });
});

describe("prepareWrites denial journaling (review-gate HIGH-2)", () => {
  function stateForWrites(): RunState {
    return {
      version: 2,
      runId: "run-1",
      sessionId: "session-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      installationGeneration: 1,
      authClass: "addon",
      originalRequest: "delete the tag urgent",
      requestHash: "h".repeat(64),
      phase: "model",
      registryId: "v2-api",
      catalogHash: MODEL_API_ACTION_CATALOG.hash(),
      loadedToolNames: [DISCOVERY_META_TOOL_NAME, "clockify_tags_delete"],
      usedToolNames: [],
      completedResults: [],
      pendingOperationIds: [],
      unfinishedOperations: [],
      continuation: { kind: "none" },
      budget: {
        modelCallsUsed: 1,
        discoveryCallsUsed: 0,
        apiCallsUsed: 0,
        hostCallsUsed: 0,
        hostCallsReserved: 0,
        promptTokensUsed: 0,
        completionTokensUsed: 0,
        estimatedTokensUsed: 0,
        activeWallMsUsed: 0,
      },
      createdAt: "t",
      updatedAt: "t",
    };
  }

  it("journals every call of a denied preparation as tool.denied with the denial code", async () => {
    const state = stateForWrites();
    const deps = fakeDeps({
      preparations: {
        prepare: vi.fn(async () => ({
          kind: "denied" as const,
          code: "policy_denied",
          actionResultId: "result-denied",
        })),
      },
      runStore: {
        startRunWithTurn: vi.fn(),
        startRunWithEvent: vi.fn(),
        getRun: vi.fn(() => state),
        saveRun: vi.fn(),
        getLastRunEventSequence: vi.fn(() => 1),
        findLatestEligibleRunForCache: vi.fn(() => undefined),
        recoverOrphanedActiveRuns: vi.fn(() => 0),
        failActiveRunsForSession: vi.fn(() => 0),
      } as unknown as RunnerDependencies["runStore"],
    });
    const service = createActionExecutionService(deps);
    const calls: ToolCall[] = [
      { id: "w1", name: "clockify_tags_delete", arguments: { id: "a".repeat(24) } },
      { id: "w2", name: "clockify_tags_delete", arguments: { id: "b".repeat(24) } },
    ];
    const result = await service.prepareWrites(state, calls, "fallback");
    // A denied preparation never suspends and never claims completion — but it
    // must not vanish: each call is durably denied with the preparation's code.
    expect(result.suspended).toBeUndefined();
    const denyTool = deps.eventService.denyTool as ReturnType<typeof vi.fn>;
    expect(denyTool).toHaveBeenCalledTimes(2);
    expect(denyTool.mock.calls.map((c) => (c[0] as { payload: { toolCallId: string; code: string } }).payload)).toEqual([
      { toolCallId: "w1", actionName: "clockify_tags_delete", code: "policy_denied" },
      { toolCallId: "w2", actionName: "clockify_tags_delete", code: "policy_denied" },
    ]);
    expect(deps.eventService.completeTool).not.toHaveBeenCalled();
    expect(deps.eventService.suspendRun).not.toHaveBeenCalled();
  });
});

describe("executeReadsConcurrently", () => {
  it("never exceeds four simultaneous reads", async () => {
    let active = 0;
    let maxActive = 0;
    const deps = fakeDeps({
      requestGovernor: {
        runRead: vi.fn(async (_scope, op) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return op();
        }),
        remainingHostCalls: vi.fn(() => 60),
        persistHostCallAllowance: vi.fn(),
      },
      reads: {
        execute: vi.fn(async () => ({ kind: "succeeded" as const, actionResultId: "r" })),
      },
    });
    const calls = Array.from({ length: 8 }, (_, i) => ({
      id: `c${i}`,
      name: "clockify_projects_list",
      arguments: {},
    }));
    const order: string[] = [];
    await executeReadsConcurrently(calls, { ...baseScope(), runId: "run-1" }, deps, undefined, (call) => {
      order.push(call.id);
    });
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(order).toEqual(calls.map((c) => c.id));
  });
});
