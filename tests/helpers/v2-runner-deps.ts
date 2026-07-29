import { vi } from "vitest";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import type { RunnerDependencies, RunScope } from "../../src/assistant-v2/protocol.js";

export function mockRunnerDeps(overrides: Partial<RunnerDependencies> = {}): RunnerDependencies {
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
    requireClarificationAndSuspend: vi.fn((input) => ({
      required: eventStore.requireClarificationWithEvent({}, input.state, input.payload),
      suspended: eventStore.suspendRunWithEvent({}, input.state, { reason: "awaiting_clarification" }),
    })),
    suspendRun: vi.fn((input) => eventStore.suspendRunWithEvent({}, input.state, input.payload)),
    completeRun: vi.fn((input) => eventStore.completeRunWithEvent({}, input.state, input.payload)),
    failRun: vi.fn((input) => eventStore.failRunWithEvent({}, input.state, input.payload)),
  };
  return {
    modelClient: {
      complete: vi.fn(),
      completeWithTools: vi.fn(async () => ({ text: "done", toolCalls: [] })),
    },
    runStore: {
      startRunWithTurn: vi.fn(),
      startRunWithEvent: vi.fn(),
      getRun: vi.fn(),
      saveRun: vi.fn(),
      getActionResult: vi.fn(() => undefined),
      getLastRunEventSequence: vi.fn(() => sequence),
      findLatestEligibleRunForCache: vi.fn(),
      recoverOrphanedActiveRuns: vi.fn(() => 0),
      failActiveRunsForSession: vi.fn(() => 0),
    },
    eventService: eventService as unknown as RunnerDependencies["eventService"],
    eventViews: { list: vi.fn(() => ({ runId: "run", events: [], nextAfter: 0, hasMore: false, lastSequence: 0 })) },
    actionRegistry: MODEL_API_ACTION_CATALOG,
    discovery: { search: vi.fn() },
    reads: { execute: vi.fn(async () => ({ kind: "succeeded" as const, actionResultId: "r" })) },
    preparations: { prepare: vi.fn() },
    installationGuard: { assertCurrent: vi.fn() },
    requestGovernor: {
      runRead: vi.fn(async (_s, op) => op()),
    },
    clock: { now: () => new Date(), monotonicMs: () => 0 },
    ...overrides,
  } as RunnerDependencies;
}

export function baseRunScope(): RunScope {
  return {
    sessionId: "session-1",
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    installationGeneration: 1,
    authClass: "addon",
  };
}
