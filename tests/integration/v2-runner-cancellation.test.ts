import { describe, expect, it, vi } from "vitest";
import { runAssistantV2 } from "../../src/assistant-v2/runner.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import type { RunnerDependencies, RunScope } from "../../src/assistant-v2/protocol.js";

function scope(): RunScope {
  return {
    sessionId: "session-1",
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    installationGeneration: 1,
    authClass: "addon",
  };
}

describe("v2 runner cancellation", () => {
  it("stops before the model call when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const deps: RunnerDependencies = {
      modelClient: {
        complete: vi.fn(),
        completeWithTools: vi.fn(async () => ({ text: "nope", toolCalls: [] })),
      },
      runStore: {
        startRunWithTurn: vi.fn(),
        getRun: vi.fn(() => undefined),
        saveRun: vi.fn(),
        findLatestEligibleRunForCache: vi.fn(() => undefined),
        recoverOrphanedActiveRuns: vi.fn(() => 0),
        failActiveRunsForSession: vi.fn(() => 0),
      },
      actionRegistry: MODEL_API_ACTION_CATALOG,
      discovery: {
        search: vi.fn(async () => ({ kind: "matches" as const, query: "x", access: "any" as const, operations: [] })),
      },
      reads: {
        execute: vi.fn(async () => ({ kind: "succeeded" as const, actionResultId: "r" })),
      },
      preparations: {
        prepare: vi.fn(async () => ({ kind: "not_ready" as const, code: "write_port_not_ready" as const, actionResultId: "p" })),
      },
      installationGuard: { assertCurrent: vi.fn() },
      requestGovernor: {
        runRead: vi.fn(async (_s, op) => op()),
        remainingHostCalls: vi.fn(() => 60),
        persistHostCallAllowance: vi.fn(),
      },
      clock: { now: () => new Date(), monotonicMs: () => 0 },
    };
    const outcome = await runAssistantV2({
      runId: "run-cancel",
      scope: scope(),
      originalRequest: "list projects",
      signal: controller.signal,
    }, deps);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.code).toBe("cancelled");
    expect(deps.modelClient.completeWithTools).not.toHaveBeenCalled();
  });
});
