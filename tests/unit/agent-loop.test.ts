import { describe, expect, it, vi } from "vitest";
import { runAgentTurn, TOOL_RESULT_MAX_BYTES, type AgentTurnResult } from "../../src/assistant/agent-loop.js";
import type { ActionResult } from "../../src/harness/action.js";
import { successReceipt } from "../../src/harness/receipts.js";
import { scriptedToolModel } from "../helpers/scripted-model.js";
import type { ModelMessage } from "../../src/assistant/model-client.js";

const NO_TOOLS = [] as never[];

function userTurn(content: string): ModelMessage[] {
  return [{ role: "user", content }];
}

function previewResult(): Extract<ActionResult, { kind: "preview" }> {
  return {
    kind: "preview",
    preview: {
      actionLabel: "Delete client",
      featureGroup: "work_structure",
      riskLabels: ["high_risk_write"],
      targets: [{ type: "client", id: "c9", name: "qwen" }],
      expectedChanges: ["Delete client qwen"],
      reversibility: "Not reversible.",
      warnings: [],
    },
    operation: {
      operationId: "op-c9",
      actionName: "clockify_clients_delete",
      featureGroup: "work_structure",
      risks: ["high_risk_write"],
      payload: { id: "c9" },
    },
  };
}

describe("runAgentTurn — the durable agentic tool-loop", () => {
  it("returns final when the model answers with no tool calls", async () => {
    const model = scriptedToolModel([{ text: "All set.", toolCalls: [] }]);
    const runAction = vi.fn(async (): Promise<ActionResult> => ({ kind: "clarify", message: "unused" }));
    const result = await runAgentTurn({ modelClient: model, messages: userTurn("hi"), tools: NO_TOOLS, runAction });

    expect(result.kind).toBe("final");
    expect((result as Extract<AgentTurnResult, { kind: "final" }>).text).toBe("All set.");
    expect(runAction).not.toHaveBeenCalled();
    expect(model.completeWithTools).toHaveBeenCalledTimes(1);
  });

  it("chains a read then acts on the result, feeding receipts back to the model (the core fix)", async () => {
    const model = scriptedToolModel([
      { text: "", toolCalls: [{ id: "c1", name: "clockify_tags_list", arguments: {} }] },
      { text: "", toolCalls: [{ id: "c2", name: "clockify_tags_create", arguments: { name: "urgent-copy" } }] },
      { text: "Created the tag.", toolCalls: [] },
    ]);
    const runAction = vi.fn(async (call: { name: string }): Promise<ActionResult> => {
      if (call.name === "clockify_tags_list") {
        return {
          kind: "receipt",
          receipt: successReceipt({ action: "clockify_tags_list", data: { items: [{ id: "t1", name: "urgent" }] } }),
        };
      }
      return {
        kind: "receipt",
        receipt: successReceipt({
          action: "clockify_tags_create",
          changed: { created: [{ type: "tag", id: "t2", name: "urgent-copy" }] },
        }),
      };
    });

    const result = await runAgentTurn({ modelClient: model, messages: userTurn("copy the first tag"), tools: NO_TOOLS, runAction });

    expect(result.kind).toBe("final");
    expect((result as Extract<AgentTurnResult, { kind: "final" }>).text).toBe("Created the tag.");
    expect(runAction.mock.calls.map((c) => (c[0] as { name: string }).name)).toEqual([
      "clockify_tags_list",
      "clockify_tags_create",
    ]);
    // The model's SECOND call must have seen the first read's result fed back as a tool message.
    const secondCallMessages = model.calls[1].messages;
    const toolMsg = secondCallMessages.find((m) => m.role === "tool" && m.toolCallId === "c1");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.content).toContain("urgent");
    // And the assistant tool-call turn was recorded so the model sees its own call.
    expect(secondCallMessages.some((m) => m.role === "assistant" && (m.toolCalls?.[0]?.id ?? "") === "c1")).toBe(true);
  });

  it("interrupts at the first risky write and never executes a commit inline", async () => {
    const model = scriptedToolModel([
      { text: "", toolCalls: [{ id: "r1", name: "clockify_clients_delete", arguments: { name: "qwen" } }] },
    ]);
    const runAction = vi.fn(async (): Promise<ActionResult> => previewResult());

    const result = await runAgentTurn({ modelClient: model, messages: userTurn("delete qwen"), tools: NO_TOOLS, runAction });

    expect(result.kind).toBe("interrupt");
    const interrupt = result as Extract<AgentTurnResult, { kind: "interrupt" }>;
    expect(interrupt.call.id).toBe("r1");
    expect(interrupt.operation.actionName).toBe("clockify_clients_delete");
    expect(interrupt.preview.actionLabel).toBe("Delete client");
    // The model must NOT be re-planned after a risky interrupt, and runAction ran once.
    expect(model.completeWithTools).toHaveBeenCalledTimes(1);
    expect(runAction).toHaveBeenCalledTimes(1);
  });

  it("runs reads before the first risky in the same model turn, then interrupts at the risky one", async () => {
    const model = scriptedToolModel([
      {
        text: "",
        toolCalls: [
          { id: "a1", name: "clockify_clients_list", arguments: {} },
          { id: "a2", name: "clockify_clients_delete", arguments: { id: "c9" } },
          { id: "a3", name: "clockify_tags_list", arguments: {} },
        ],
      },
    ]);
    const runAction = vi.fn(async (call: { name: string }): Promise<ActionResult> => {
      if (call.name === "clockify_clients_delete") return previewResult();
      return { kind: "receipt", receipt: successReceipt({ action: call.name, data: { items: [] } }) };
    });

    const result = await runAgentTurn({ modelClient: model, messages: userTurn("clean up"), tools: NO_TOOLS, runAction });

    expect(result.kind).toBe("interrupt");
    // read a1 ran, risky a2 interrupted; a3 (after the risky) must NOT run.
    expect(runAction.mock.calls.map((c) => (c[0] as { name: string }).name)).toEqual([
      "clockify_clients_list",
      "clockify_clients_delete",
    ]);
    // The persisted transcript declares only the honored calls (a1, a2) so it stays
    // wire-valid once resume fills in a2's tool result.
    const interrupt = result as Extract<AgentTurnResult, { kind: "interrupt" }>;
    const assistant = interrupt.transcript.find((m) => m.role === "assistant" && m.toolCalls);
    expect(assistant?.toolCalls?.map((t) => t.id)).toEqual(["a1", "a2"]);
    expect(interrupt.transcript.some((m) => m.role === "tool" && m.toolCallId === "a1")).toBe(true);
    expect(interrupt.transcript.some((m) => m.role === "tool" && m.toolCallId === "a2")).toBe(false);
  });

  it("carries the model's reasoningContent into the transcript (thinking-mode continuations must not drop it)", async () => {
    const model = scriptedToolModel([
      {
        text: "",
        reasoningContent: "urgent first, then stale",
        toolCalls: [{ id: "r1", name: "clockify_clients_delete", arguments: { name: "qwen" } }],
      },
    ]);
    const runAction = vi.fn(async (): Promise<ActionResult> => previewResult());

    const result = await runAgentTurn({ modelClient: model, messages: userTurn("delete qwen"), tools: NO_TOOLS, runAction });

    expect(result.kind).toBe("interrupt");
    const interrupt = result as Extract<AgentTurnResult, { kind: "interrupt" }>;
    const assistant = interrupt.transcript.find((m) => m.role === "assistant" && m.toolCalls);
    expect(assistant?.reasoningContent).toBe("urgent first, then stale");
  });

  it("respects maxSteps and returns a truthful exhausted result", async () => {
    const model = scriptedToolModel([
      { text: "", toolCalls: [{ id: "x", name: "clockify_clients_list", arguments: {} }] },
    ]);
    const runAction = vi.fn(async (call: { name: string }): Promise<ActionResult> => ({
      kind: "receipt",
      receipt: successReceipt({ action: call.name, data: { items: [] } }),
    }));

    const result = await runAgentTurn({
      modelClient: model,
      messages: userTurn("loop forever"),
      tools: NO_TOOLS,
      runAction,
      maxSteps: 3,
    });

    expect(result.kind).toBe("exhausted");
    expect(model.completeWithTools).toHaveBeenCalledTimes(3);
    expect(runAction).toHaveBeenCalledTimes(3);
  });

  it("ends the loop on a clarify result", async () => {
    const model = scriptedToolModel([
      { text: "", toolCalls: [{ id: "c1", name: "clockify_clients_delete", arguments: { name: "amb" } }] },
    ]);
    const runAction = vi.fn(async (): Promise<ActionResult> => ({
      kind: "clarify",
      message: "Which client did you mean?",
      options: [{ id: "c1", label: "qwen A" }],
    }));

    const result = await runAgentTurn({ modelClient: model, messages: userTurn("delete amb"), tools: NO_TOOLS, runAction });

    expect(result.kind).toBe("clarify");
    expect((result as Extract<AgentTurnResult, { kind: "clarify" }>).message).toBe("Which client did you mean?");
    expect(model.completeWithTools).toHaveBeenCalledTimes(1);
  });

  it("streams each receipt step via onStep but never the terminal interrupt", async () => {
    const model = scriptedToolModel([
      {
        text: "",
        toolCalls: [
          { id: "s1", name: "clockify_clients_list", arguments: {} },
          { id: "s2", name: "clockify_clients_delete", arguments: { id: "c9" } },
        ],
      },
    ]);
    const runAction = vi.fn(async (call: { name: string }): Promise<ActionResult> => {
      if (call.name === "clockify_clients_delete") return previewResult();
      return { kind: "receipt", receipt: successReceipt({ action: call.name, data: { items: [] } }) };
    });
    const steps: string[] = [];
    const result = await runAgentTurn({
      modelClient: model,
      messages: userTurn("x"),
      tools: NO_TOOLS,
      runAction,
      onStep: (step) => steps.push(step.call.id),
    });

    expect(result.kind).toBe("interrupt");
    // Only the read step is emitted; the risky preview is returned, not streamed as a step.
    expect(steps).toEqual(["s1"]);
  });

  it("caps a huge tool-result receipt before it reaches the model transcript (live: a PDF-export receipt stalled the session)", async () => {
    const model = scriptedToolModel([
      { text: "", toolCalls: [{ id: "c1", name: "clockify_invoices_export", arguments: {} }] },
      { text: "Done.", toolCalls: [] },
    ]);
    const fat = successReceipt({
      action: "clockify_invoices_export",
      data: { base64: "A".repeat(400_000), contentType: "application/pdf" },
    });
    const runAction = vi.fn(async (): Promise<ActionResult> => ({ kind: "receipt", receipt: fat }));
    const result = await runAgentTurn({ modelClient: model, messages: userTurn("export it"), tools: NO_TOOLS, runAction });

    expect(result.kind).toBe("final");
    const toolMsg = model.calls[1].messages.find((m) => m.role === "tool");
    if (!toolMsg) throw new Error("expected a tool message in the second call's transcript");
    expect(Buffer.byteLength(toolMsg.content, "utf8")).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
    // Still valid JSON, still says what happened, and admits the truncation.
    const parsed = JSON.parse(toolMsg.content);
    expect(parsed.ok).toBe(true);
    expect(toolMsg.content).toContain("truncated");
  });

  it("prunes oversized list receipts to a head sample so read-then-act still works", async () => {
    const model = scriptedToolModel([
      { text: "", toolCalls: [{ id: "c1", name: "clockify_entries_list", arguments: {} }] },
      { text: "Done.", toolCalls: [] },
    ]);
    const items = Array.from({ length: 2_000 }, (_, i) => ({
      id: `e${i}`,
      description: `entry ${i} ${"x".repeat(50)}`,
    }));
    const runAction = vi.fn(async (): Promise<ActionResult> => ({
      kind: "receipt",
      receipt: successReceipt({ action: "clockify_entries_list", data: { count: items.length, items } }),
    }));
    const result = await runAgentTurn({ modelClient: model, messages: userTurn("list"), tools: NO_TOOLS, runAction });

    expect(result.kind).toBe("final");
    const toolMsg = model.calls[1].messages.find((m) => m.role === "tool");
    if (!toolMsg) throw new Error("expected a tool message");
    expect(Buffer.byteLength(toolMsg.content, "utf8")).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
    const parsed = JSON.parse(toolMsg.content);
    // The head of the list survives (the model can still pick ids), the count is intact.
    expect(parsed.data.items[0]).toMatchObject({ id: "e0" });
    expect(parsed.data.count).toBe(2_000);
  });

  it("leaves a small tool-result receipt byte-identical", async () => {
    const model = scriptedToolModel([
      { text: "", toolCalls: [{ id: "c1", name: "clockify_tags_list", arguments: {} }] },
      { text: "Done.", toolCalls: [] },
    ]);
    const small = successReceipt({ action: "clockify_tags_list", data: { items: [{ id: "t1", name: "urgent" }] } });
    const runAction = vi.fn(async (): Promise<ActionResult> => ({ kind: "receipt", receipt: small }));
    await runAgentTurn({ modelClient: model, messages: userTurn("list"), tools: NO_TOOLS, runAction });
    const toolMsg = model.calls[1].messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toBe(JSON.stringify(small));
  });

  it("truncates a step's tool calls to maxToolCallsPerStep, silently dropping the extras", async () => {
    // The loop slices each step's tool calls to maxCalls (input.maxToolCallsPerStep
    // ?? DEFAULT). A model that proposes MORE than the cap in one step must have the
    // surplus dropped: only the first `maxCalls` run, only they are declared in the
    // assistant turn, and the extras never reach runAction or the tool results.
    const model = scriptedToolModel([
      {
        text: "",
        toolCalls: [
          { id: "k1", name: "clockify_tags_list", arguments: {} },
          { id: "k2", name: "clockify_clients_list", arguments: {} },
          { id: "k3", name: "clockify_projects_list", arguments: {} }, // dropped (> cap)
          { id: "k4", name: "clockify_users_list", arguments: {} }, // dropped (> cap)
        ],
      },
      { text: "Done.", toolCalls: [] }, // ends the loop on the next step
    ]);
    const runAction = vi.fn(async (call: { id: string; name: string }): Promise<ActionResult> => ({
      kind: "receipt",
      receipt: successReceipt({ action: call.name, data: { items: [] } }),
    }));

    const result = await runAgentTurn({
      modelClient: model,
      messages: userTurn("list everything"),
      tools: NO_TOOLS,
      runAction,
      maxToolCallsPerStep: 2,
    });

    expect(result.kind).toBe("final");
    // Only the first two calls were honored — the extras (k3, k4) were dropped.
    expect(runAction).toHaveBeenCalledTimes(2);
    expect(runAction.mock.calls.map((c) => c[0].id)).toEqual(["k1", "k2"]);
    // The assistant tool-call turn declares ONLY the honored calls (so every
    // declared tool_call_id gets a reply); the dropped ids appear nowhere.
    const assistant = model.calls[1].messages.find((m) => m.role === "assistant" && m.toolCalls);
    expect(assistant?.toolCalls?.map((t) => t.id)).toEqual(["k1", "k2"]);
    const toolReplyIds = model.calls[1].messages.filter((m) => m.role === "tool").map((m) => m.toolCallId);
    expect(toolReplyIds).toEqual(["k1", "k2"]);
    // The extras are not present in the transcript the model sees on the next step.
    expect(model.calls[1].messages.some((m) => (m.toolCalls ?? []).some((t) => t.id === "k3" || t.id === "k4"))).toBe(false);
    expect(toolReplyIds).not.toContain("k3");
    expect(toolReplyIds).not.toContain("k4");
  });
});
