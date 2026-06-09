import { describe, expect, it, vi } from "vitest";
import { planConversation } from "../../src/assistant/planner.js";
import type { ModelClient, ToolCompletion, ToolDefinition } from "../../src/assistant/model-client.js";
import { catalogForModel } from "../../src/harness/catalog.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";

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
    actionCatalog: catalogForModel(),
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
});
