import { describe, expect, it } from "vitest";
import { runAgentTurn } from "../../src/assistant/agent-loop.js";
import type { ModelClient, ToolCompletion } from "../../src/assistant/model-client.js";
import type { ActionResult } from "../../src/harness/action.js";

// A model that would keep calling a read tool forever (so the loop only stops
// when something else stops it — here, the abort signal).
function loopingModel(): { client: ModelClient; calls: () => number } {
  let calls = 0;
  const client: ModelClient = {
    async complete() {
      return "";
    },
    async completeWithTools(): Promise<ToolCompletion> {
      calls += 1;
      return { text: "", toolCalls: [{ id: `c${calls}`, name: "clockify_tags_list", arguments: {} }] };
    },
  };
  return { client, calls: () => calls };
}

const okRead: ActionResult = {
  kind: "receipt",
  receipt: { ok: true, action: "clockify_tags_list", entity: "tag", data: { tags: [] } },
};

describe("agent loop cooperative cancellation (client disconnect)", () => {
  it("returns kind:'aborted' and makes NO model call when the signal is already aborted", async () => {
    const { client, calls } = loopingModel();
    const controller = new AbortController();
    controller.abort();
    const result = await runAgentTurn({
      modelClient: client,
      messages: [{ role: "user", content: "list tags forever" }],
      tools: [],
      runAction: async () => okRead,
      signal: controller.signal,
    });
    expect(result.kind).toBe("aborted");
    expect(calls()).toBe(0); // the loop never called the model
  });

  it("stops after the in-flight step when the signal aborts mid-turn (no runaway)", async () => {
    const { client, calls } = loopingModel();
    const controller = new AbortController();
    let actions = 0;
    const result = await runAgentTurn({
      modelClient: client,
      messages: [{ role: "user", content: "list tags forever" }],
      tools: [],
      runAction: async () => {
        actions += 1;
        controller.abort(); // the client disconnects during the first tool execution
        return okRead;
      },
      signal: controller.signal,
    });
    expect(result.kind).toBe("aborted");
    // Without the guard this model loops to DEFAULT_MAX_STEPS (6). With it, the
    // loop stops at the next boundary: at most one extra model call, far below 6.
    expect(calls()).toBeLessThan(3);
    expect(actions).toBe(1);
  });

  it("an unset signal is a no-op (the loop completes normally)", async () => {
    // A model that calls a tool once, then answers.
    let step = 0;
    const client: ModelClient = {
      async complete() {
        return "";
      },
      async completeWithTools(): Promise<ToolCompletion> {
        step += 1;
        return step === 1
          ? { text: "", toolCalls: [{ id: "c1", name: "clockify_tags_list", arguments: {} }] }
          : { text: "Here are your tags.", toolCalls: [] };
      },
    };
    const result = await runAgentTurn({
      modelClient: client,
      messages: [{ role: "user", content: "list tags" }],
      tools: [],
      runAction: async () => okRead,
    });
    expect(result.kind).toBe("final");
  });
});
