import { describe, expect, it, vi } from "vitest";
import { planConversation, runAgentConversation } from "../../src/assistant/planner.js";
import type { ModelClient, ToolCompletion, ToolDefinition } from "../../src/assistant/model-client.js";
import type { ActionResult } from "../../src/harness/action.js";
import { successReceipt } from "../../src/harness/receipts.js";
import { catalogForModel } from "../../src/harness/catalog.js";
import { INTERNAL_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { scriptedToolModel } from "../helpers/scripted-model.js";

function toolModel(completion: ToolCompletion, spy?: { tools?: ToolDefinition[]; sawComplete?: boolean }): ModelClient {
  return {
    complete: vi.fn(async () => {
      if (spy) spy.sawComplete = true;
      return "{}";
    }),
    completeWithTools: vi.fn(async (_messages: unknown, tools: ToolDefinition[]) => {
      if (spy) spy.tools = tools;
      return completion;
    }),
  };
}

function input(modelClient: ModelClient, extra: Record<string, unknown> = {}) {
  return {
    modelClient,
    messages: [{ role: "user" as const, content: "start a timer" }],
    actionCatalog: catalogForModel(INTERNAL_ACTION_CATALOG),
    policy: defaultAdminPolicy(),
    ...extra,
  };
}

describe("planConversation — tool-calling branch", () => {
  it("maps tool calls to an actions plan when the client supports tools", async () => {
    const model = toolModel({
      text: "",
      toolCalls: [{ id: "c1", name: "clockify_start_timer", arguments: { description: "Deep Work" } }],
    });
    const plan = await planConversation(input(model));
    expect(plan.kind).toBe("actions");
    expect(plan.actions?.[0]).toEqual({ name: "clockify_start_timer", arguments: { description: "Deep Work" } });
    expect(model.completeWithTools).toHaveBeenCalledTimes(1);
    expect(model.complete).not.toHaveBeenCalled();
  });

  it("returns an answer when the model replies with text and no tool calls", async () => {
    const model = toolModel({ text: "It is sunny.", toolCalls: [] });
    const plan = await planConversation(input(model));
    expect(plan.kind).toBe("answer");
    expect(plan.text).toBe("It is sunny.");
  });

  it("passes the generated tool catalog to the client", async () => {
    const spy: { tools?: ToolDefinition[] } = {};
    const model = toolModel({ text: "", toolCalls: [{ id: "c1", name: "clockify_status", arguments: {} }] }, spy);
    await planConversation(input(model));
    expect((spy.tools ?? []).some((t) => t.name === "clockify_status")).toBe(true);
    expect((spy.tools ?? []).length).toBeGreaterThan(50);
  });

  it("falls back to JSON mode when useTools is false, even if the client supports tools", async () => {
    const model = toolModel({ text: "", toolCalls: [{ id: "c1", name: "clockify_status", arguments: {} }] });
    (model.complete as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      JSON.stringify({ kind: "answer", text: "hello" }),
    );
    const plan = await planConversation(input(model, { useTools: false }));
    expect(plan.kind).toBe("answer");
    expect(plan.text).toBe("hello");
    expect(model.completeWithTools).not.toHaveBeenCalled();
    expect(model.complete).toHaveBeenCalledTimes(1);
  });

  it("uses JSON mode when the client has no completeWithTools (unchanged behavior)", async () => {
    const jsonOnly: ModelClient = {
      complete: vi.fn(async () => JSON.stringify({ kind: "answer", text: "hi" })),
    };
    const plan = await planConversation(input(jsonOnly));
    expect(plan.kind).toBe("answer");
    expect(jsonOnly.complete).toHaveBeenCalledTimes(1);
  });

  it("passes the route abort signal through both tool and JSON planner calls", async () => {
    const controller = new AbortController();
    let toolSignal: AbortSignal | undefined;
    let jsonSignal: AbortSignal | undefined;
    const model: ModelClient = {
      async complete(_messages, _onUsage, signal) {
        jsonSignal = signal;
        return JSON.stringify({ kind: "answer", text: "json" });
      },
      async completeWithTools(_messages, _tools, signal) {
        toolSignal = signal;
        return { text: "tool", toolCalls: [] };
      },
    };

    await planConversation(input(model, { signal: controller.signal }));
    await planConversation(input(model, { signal: controller.signal, useTools: false }));
    expect(toolSignal).toBe(controller.signal);
    expect(jsonSignal).toBe(controller.signal);
  });
});

describe("runAgentConversation — the agentic planning entry", () => {
  it("prepends the tool system prompt and drives runAgentTurn to a final answer", async () => {
    const model = scriptedToolModel([
      { text: "", toolCalls: [{ id: "c1", name: "clockify_tags_list", arguments: {} }] },
      { text: "You have 1 tag: urgent.", toolCalls: [] },
    ]);
    const runAction = vi.fn(async (): Promise<ActionResult> => ({
      kind: "receipt",
      receipt: successReceipt({ action: "clockify_tags_list", data: { items: [{ id: "t1", name: "urgent" }] } }),
    }));

    const result = await runAgentConversation({
      modelClient: model,
      messages: [{ role: "user", content: "how many tags do I have?" }],
      policy: defaultAdminPolicy(),
      runAction,
    });

    expect(result.kind).toBe("final");
    // The system prompt is the tool prompt (security framing + permissions), prepended once.
    const first = model.calls[0].messages[0];
    expect(first.role).toBe("system");
    expect(first.content).toContain("You are an assistant embedded in Clockify");
    expect(model.calls[1].messages.filter((m) => m.role === "system")).toHaveLength(1);
    // The real tool catalog is passed by default.
    expect(model.calls[0].tools.some((t) => t.name === "clockify_tags_list")).toBe(true);
    // The read's receipt was fed back to the model on the second call.
    expect(model.calls[1].messages.some((m) => m.role === "tool" && m.toolCallId === "c1")).toBe(true);
  });
});
