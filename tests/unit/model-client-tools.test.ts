import { describe, expect, it, vi } from "vitest";
import { createModelClient, type ModelMessage, type ToolDefinition } from "../../src/assistant/model-client.js";

const tools: ToolDefinition[] = [
  { name: "clockify_status", description: "timer status", parameters: { type: "object", properties: {} } },
];

function fakeFetch(payload: unknown, ok = true, captured?: { body?: string }): typeof fetch {
  return vi.fn(async (_url: unknown, init?: { body?: string }) => {
    if (captured) captured.body = init?.body;
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => payload,
    } as Response;
  }) as unknown as typeof fetch;
}

function client(payload: unknown, ok = true, captured?: { body?: string }) {
  return createModelClient({
    baseUrl: "https://api.test/v1",
    apiKey: "fake",
    model: "test-model",
    fetchImpl: fakeFetch(payload, ok, captured),
  });
}

describe("createModelClient.completeWithTools", () => {
  it("maps tool_calls to parsed ToolCall objects", async () => {
    const payload = {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: "call_1", function: { name: "clockify_start_timer", arguments: '{"description":"Deep Work"}' } },
            ],
          },
        },
      ],
    };
    const result = await client(payload).completeWithTools!([{ role: "user", content: "start a timer" }], tools);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({
      id: "call_1",
      name: "clockify_start_timer",
      arguments: { description: "Deep Work" },
    });
    expect(result.text).toBe("");
  });

  it("returns text with no tool calls when the model answers", async () => {
    const payload = { choices: [{ message: { content: "It is sunny.", tool_calls: [] } }] };
    const result = await client(payload).completeWithTools!([{ role: "user", content: "weather?" }], tools);
    expect(result.toolCalls).toEqual([]);
    expect(result.text).toBe("It is sunny.");
  });

  it("tolerates malformed tool-call arguments (returns empty args, never throws)", async () => {
    const payload = {
      choices: [{ message: { tool_calls: [{ function: { name: "clockify_status", arguments: "{bad json" } }] } }],
    };
    const result = await client(payload).completeWithTools!([{ role: "user", content: "x" }], tools);
    expect(result.toolCalls[0]).toEqual({ id: "call_0", name: "clockify_status", arguments: {} });
  });

  it("sends tools + tool_choice and does NOT force json_object response_format", async () => {
    const captured: { body?: string } = {};
    const payload = { choices: [{ message: { content: "ok", tool_calls: [] } }] };
    await client(payload, true, captured).completeWithTools!([{ role: "user", content: "x" }], tools);
    const body = JSON.parse(captured.body ?? "{}");
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools[0].type).toBe("function");
    expect(body.tools[0].function.name).toBe("clockify_status");
    expect(body.tool_choice).toBe("auto");
    expect(body.response_format).toBeUndefined();
  });

  it("throws on a non-ok response", async () => {
    await expect(
      client({}, false).completeWithTools!([{ role: "user", content: "x" }], tools),
    ).rejects.toThrow();
  });
});

describe("createModelClient — multi-turn tool messages (the agentic-loop foundation)", () => {
  it("threads the provider tool_call id into ToolCall.id", async () => {
    const payload = {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: "call_abc", function: { name: "clockify_clients_list", arguments: "{}" } }],
          },
        },
      ],
    };
    const result = await client(payload).completeWithTools!([{ role: "user", content: "list clients" }], tools);
    expect(result.toolCalls[0]).toEqual({ id: "call_abc", name: "clockify_clients_list", arguments: {} });
  });

  it("synthesizes a stable id when the provider omits the tool_call id", async () => {
    const payload = {
      choices: [{ message: { tool_calls: [{ function: { name: "clockify_status", arguments: "{}" } }] } }],
    };
    const result = await client(payload).completeWithTools!([{ role: "user", content: "x" }], tools);
    expect(result.toolCalls[0].id).toBe("call_0");
  });

  it("serializes an assistant tool-call turn and a tool-result message to OpenAI wire format", async () => {
    const captured: { body?: string } = {};
    const payload = { choices: [{ message: { content: "done", tool_calls: [] } }] };
    const transcript: ModelMessage[] = [
      { role: "user", content: "list clients then act" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "clockify_clients_list", arguments: {} }] },
      { role: "tool", toolCallId: "call_1", content: '{"clients":[{"id":"c1","name":"qwen"}]}' },
    ];
    await client(payload, true, captured).completeWithTools!(transcript, tools);
    const body = JSON.parse(captured.body ?? "{}");
    expect(body.messages[0]).toEqual({ role: "user", content: "list clients then act" });
    expect(body.messages[1].role).toBe("assistant");
    expect(body.messages[1].content).toBeNull();
    expect(body.messages[1].tool_calls[0]).toEqual({
      id: "call_1",
      type: "function",
      function: { name: "clockify_clients_list", arguments: "{}" },
    });
    expect(body.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: '{"clients":[{"id":"c1","name":"qwen"}]}',
    });
  });

  it("captures reasoning_content and passes it back verbatim (DeepSeek thinking-mode contract)", async () => {
    const payload = {
      choices: [
        {
          message: {
            content: null,
            reasoning_content: "I should delete urgent first.",
            tool_calls: [{ id: "c1", function: { name: "clockify_tags_delete", arguments: '{"name":"urgent"}' } }],
          },
        },
      ],
    };
    const result = await client(payload).completeWithTools!([{ role: "user", content: "delete both tags" }], tools);
    expect(result.reasoningContent).toBe("I should delete urgent first.");

    // The provider 400s a thinking-mode continuation that DROPS reasoning_content,
    // so the assistant turn must serialize it back verbatim.
    const captured: { body?: string } = {};
    const transcript: ModelMessage[] = [
      { role: "user", content: "delete both tags" },
      {
        role: "assistant",
        content: "",
        reasoningContent: "I should delete urgent first.",
        toolCalls: [{ id: "c1", name: "clockify_tags_delete", arguments: { name: "urgent" } }],
      },
      { role: "tool", toolCallId: "c1", content: '{"ok":true}' },
    ];
    await client({ choices: [{ message: { content: "done", tool_calls: [] } }] }, true, captured).completeWithTools!(
      transcript,
      tools,
    );
    const body = JSON.parse(captured.body ?? "{}");
    expect(body.messages[1].reasoning_content).toBe("I should delete urgent first.");
    // Turns without reasoningContent stay byte-identical (no key emitted).
    expect("reasoning_content" in body.messages[0]).toBe(false);
  });

  it("complete() still serializes plain messages identically (json mode unaffected)", async () => {
    const captured: { body?: string } = {};
    const payload = { choices: [{ message: { content: "{}" } }] };
    await client(payload, true, captured).complete([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
    const body = JSON.parse(captured.body ?? "{}");
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
    expect(body.response_format).toEqual({ type: "json_object" });
  });
});

describe("createModelClient request timeout", () => {
  function signalCapturingFetch(captured: { signals: Array<AbortSignal | undefined> }): typeof fetch {
    return vi.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => {
      captured.signals.push(init?.signal ?? undefined);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "{}" } }] }) } as Response;
    }) as unknown as typeof fetch;
  }

  it("passes an abort signal on BOTH complete and completeWithTools (a hung provider can't hang the turn)", async () => {
    const captured: { signals: Array<AbortSignal | undefined> } = { signals: [] };
    const c = createModelClient({
      baseUrl: "https://api.test/v1",
      apiKey: "fake",
      model: "test-model",
      fetchImpl: signalCapturingFetch(captured),
    });
    await c.complete([{ role: "user", content: "hi" }]);
    await c.completeWithTools!([{ role: "user", content: "hi" }], tools);
    expect(captured.signals).toHaveLength(2);
    for (const signal of captured.signals) expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("maps a timeout abort to a clean error naming the configured limit", async () => {
    const timeoutFetch = vi.fn(async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    const c = createModelClient({
      baseUrl: "https://api.test/v1",
      apiKey: "fake",
      model: "test-model",
      timeoutMs: 5,
      fetchImpl: timeoutFetch,
    });
    await expect(c.complete([{ role: "user", content: "hi" }])).rejects.toThrow(/timed out after 5ms/);
    await expect(c.completeWithTools!([{ role: "user", content: "hi" }], tools)).rejects.toThrow(
      /timed out after 5ms/,
    );
  });

  it("defaults the timeout to 120s and leaves non-abort errors untouched", async () => {
    const failFetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const c = createModelClient({ baseUrl: "https://api.test/v1", apiKey: "fake", model: "m", fetchImpl: failFetch });
    await expect(c.complete([{ role: "user", content: "hi" }])).rejects.toThrow(/ECONNREFUSED/);

    const timeoutFetch = vi.fn(async () => {
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    const d = createModelClient({ baseUrl: "https://api.test/v1", apiKey: "fake", model: "m", fetchImpl: timeoutFetch });
    await expect(d.complete([{ role: "user", content: "hi" }])).rejects.toThrow(/timed out after 120000ms/);
  });
});
