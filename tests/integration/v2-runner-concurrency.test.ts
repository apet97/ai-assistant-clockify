import { describe, expect, it, vi } from "vitest";
import { executeReadsConcurrently } from "../../src/assistant-v2/runner.js";
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

describe("v2 runner read concurrency integration", () => {
  it("preserves provider order while capping simultaneous reads at four", async () => {
    let active = 0;
    let maxActive = 0;
    const deps: RunnerDependencies = {
      modelClient: {
        complete: vi.fn(),
        completeWithTools: vi.fn(),
      },
      runStore: {
        startRunWithTurn: vi.fn(),
        getRun: vi.fn(),
        saveRun: vi.fn(),
        findLatestEligibleRunForCache: vi.fn(),
        recoverOrphanedActiveRuns: vi.fn(() => 0),
        failActiveRunsForSession: vi.fn(() => 0),
      },
      actionRegistry: MODEL_API_ACTION_CATALOG,
      discovery: { search: vi.fn() },
      reads: {
        execute: vi.fn(async () => ({ kind: "succeeded" as const, actionResultId: "r" })),
      },
      preparations: { prepare: vi.fn() },
      installationGuard: { assertCurrent: vi.fn() },
      requestGovernor: {
        runRead: vi.fn(async (_s, op) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
          return op();
        }),
        remainingHostCalls: vi.fn(() => 60),
        persistHostCallAllowance: vi.fn(),
      },
      clock: { now: () => new Date(), monotonicMs: () => 0 },
    };
    const calls = Array.from({ length: 6 }, (_, i) => ({
      id: `call-${i}`,
      name: "clockify_projects_list",
      arguments: {},
    }));
    const order: string[] = [];
    await executeReadsConcurrently(calls, scope(), deps, undefined, (call) => {
      order.push(call.id);
    });
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(order).toEqual(calls.map((call) => call.id));
  });
});
