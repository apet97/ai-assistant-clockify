import { describe, expect, it, vi } from "vitest";
import { createModelClient, type ToolDefinition } from "../../src/assistant/model-client.js";

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
              { function: { name: "clockify_start_timer", arguments: '{"description":"Deep Work"}' } },
            ],
          },
        },
      ],
    };
    const result = await client(payload).completeWithTools!([{ role: "user", content: "start a timer" }], tools);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({ name: "clockify_start_timer", arguments: { description: "Deep Work" } });
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
    expect(result.toolCalls[0]).toEqual({ name: "clockify_status", arguments: {} });
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
