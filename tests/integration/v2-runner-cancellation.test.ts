import { describe, expect, it, vi } from "vitest";
import { runAssistantV2 } from "../../src/assistant-v2/runner.js";
import { mockRunnerDeps, baseRunScope as scope } from "../helpers/v2-runner-deps.js";

describe("v2 runner cancellation", () => {
  it("stops before the model call when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const deps = mockRunnerDeps({
      modelClient: {
        complete: vi.fn(),
        completeWithTools: vi.fn(async () => ({ text: "nope", toolCalls: [] })),
      },
    });
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
