import { describe, expect, it, vi } from "vitest";
import { executeReadsConcurrently } from "../../src/assistant-v2/runner.js";
import { mockRunnerDeps, baseRunScope as scope } from "../helpers/v2-runner-deps.js";

describe("v2 runner read concurrency integration", () => {
  it("preserves provider order while capping simultaneous reads at four", async () => {
    let active = 0;
    let maxActive = 0;
    const deps = mockRunnerDeps({
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
    });
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
