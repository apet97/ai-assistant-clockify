import { describe, expect, it, vi } from "vitest";
import {
  executeReadsConcurrently,
  runAssistantV2,
  seedCacheFromPriorRun,
  validateCompletionToolCalls,
} from "../../src/assistant-v2/runner.js";
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

function fakeDeps(overrides: Partial<RunnerDependencies> = {}): RunnerDependencies {
  const modelClient = {
    complete: vi.fn(),
    completeWithTools: vi.fn(async () => ({ text: "done", toolCalls: [] })),
  };
  const store = {
    startRunWithTurn: vi.fn(),
    getRun: vi.fn(() => undefined),
    saveRun: vi.fn(),
    findLatestEligibleRunForCache: vi.fn(() => undefined),
    recoverOrphanedActiveRuns: vi.fn(() => 0),
    failActiveRunsForSession: vi.fn(() => 0),
  };
  return {
    modelClient,
    runStore: store,
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
  };
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
        getRun: vi.fn(() => completed),
        saveRun: vi.fn(),
        findLatestEligibleRunForCache: vi.fn(() => undefined),
        recoverOrphanedActiveRuns: vi.fn(() => 0),
        failActiveRunsForSession: vi.fn(() => 0),
      },
    });
    const outcome = await runAssistantV2({ runId: "run-1", scope: baseScope() }, deps);
    expect(outcome.kind).toBe("completed");
    expect(deps.modelClient.completeWithTools).not.toHaveBeenCalled();
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
    await executeReadsConcurrently(calls, baseScope(), deps, undefined, (call) => {
      order.push(call.id);
    });
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(order).toEqual(calls.map((c) => c.id));
  });
});
