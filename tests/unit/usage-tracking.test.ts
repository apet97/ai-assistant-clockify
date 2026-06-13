import { describe, expect, it } from "vitest";
import { trackUsage } from "../../src/assistant/usage.js";
import type { ModelClient } from "../../src/assistant/model-client.js";

/** A stepping clock: each call advances by `stepMs`. */
function steppingNow(stepMs: number): () => Date {
  let t = 1_000_000;
  return () => {
    const d = new Date(t);
    t += stepMs;
    return d;
  };
}

describe("trackUsage", () => {
  it("counts calls, sums reported usage, and accumulates model wall-clock", async () => {
    const inner: ModelClient = {
      complete: async () => "{}",
      completeWithTools: async () => ({
        text: "",
        toolCalls: [],
        usage: { promptTokens: 100, completionTokens: 10 },
      }),
    };
    const tracked = trackUsage(inner, steppingNow(250));
    await tracked.client.completeWithTools!([], []);
    await tracked.client.completeWithTools!([], []);
    await tracked.client.complete([]);
    expect(tracked.usage.modelCalls).toBe(3);
    expect(tracked.usage.promptTokens).toBe(200);
    expect(tracked.usage.completionTokens).toBe(20);
    expect(tracked.usage.usageReported).toBe(true);
    expect(tracked.usage.modelMs).toBe(750); // 3 calls × one 250ms step each
  });

  it("a throwing call still counts (failures cost time too)", async () => {
    const inner: ModelClient = {
      complete: async () => {
        throw new Error("boom");
      },
    };
    const tracked = trackUsage(inner, steppingNow(100));
    await expect(tracked.client.complete([])).rejects.toThrow("boom");
    expect(tracked.usage.modelCalls).toBe(1);
    expect(tracked.usage.modelMs).toBe(100);
  });

  it("sums usage reported by complete() (JSON mode), not only completeWithTools", async () => {
    const inner: ModelClient = {
      complete: async (_messages, onUsage) => {
        onUsage?.({ promptTokens: 1234, completionTokens: 56 });
        return "{}";
      },
    };
    const tracked = trackUsage(inner, steppingNow(1));
    await tracked.client.complete([]);
    expect(tracked.usage.usageReported).toBe(true);
    expect(tracked.usage.promptTokens).toBe(1234);
    expect(tracked.usage.completionTokens).toBe(56);
  });

  it("keeps usageReported false when the backend reports no token counts", async () => {
    const inner: ModelClient = {
      complete: async () => "{}",
      completeWithTools: async () => ({ text: "", toolCalls: [] }),
    };
    const tracked = trackUsage(inner, steppingNow(1));
    await tracked.client.completeWithTools!([], []);
    expect(tracked.usage.usageReported).toBe(false);
    expect(tracked.usage.promptTokens).toBe(0);
  });

  it("NEVER materializes completeWithTools on a complete-only client (the route branches on its presence)", () => {
    const completeOnly: ModelClient = { complete: async () => "{}" };
    const tracked = trackUsage(completeOnly, steppingNow(1));
    expect(tracked.client.completeWithTools).toBeUndefined();
  });
});
