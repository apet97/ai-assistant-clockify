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
      status: ok ? 200 : 400, // 400 = non-retryable, so single-shot tests stay single-shot
      json: async () => payload,
      text: async () => JSON.stringify(payload),
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
  it("rejects unsafe base URLs and blocks credential-bearing redirects", async () => {
    for (const unsafe of [
      "http://api.test/v1",
      "https://user:pass@api.test/v1",
      "https://api.test/v1?destination=elsewhere",
      "https://api.test/v1#fragment",
    ] as const) {
      expect(() => createModelClient({ baseUrl: unsafe, apiKey: "fake", model: "test-model" }))
        .toThrow(/model endpoint/u);
    }

    const captured: { redirect?: RequestRedirect; url?: string } = {};
    const c = createModelClient({
      baseUrl: "https://api.test/v1/",
      apiKey: "fake",
      model: "test-model",
      fetchImpl: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        captured.url = String(url);
        captured.redirect = init?.redirect;
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    });
    await c.complete([{ role: "user", content: "hello" }]);
    expect(captured.url).toBe("https://api.test/v1/chat/completions");
    expect(captured.redirect).toBe("error");
  });

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

  it("synthesizes UNIQUE ids across a multi-step turn when an id-less backend omits them on every step", async () => {
    // tool_call_id is load-bearing: a tool result must key back to the call it
    // answers. A per-completion counter would emit "call_0" on every step, so a
    // multi-step turn on an id-omitting OpenAI-compatible backend produces
    // duplicate ids in one transcript — ambiguous resume/correlation keys.
    const payload = {
      choices: [{ message: { tool_calls: [{ function: { name: "clockify_status", arguments: "{}" } }] } }],
    };
    const c = client(payload);
    const first = await c.completeWithTools!([{ role: "user", content: "x" }], tools);
    const second = await c.completeWithTools!([{ role: "user", content: "x" }], tools);
    expect(first.toolCalls[0].id).not.toBe(second.toolCalls[0].id);
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

describe("createModelClient thought signatures (Gemini 3.x continuation contract)", () => {
  it("captures per-tool-call thought_signature from the response", async () => {
    const payload = {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "c1",
                function: { name: "clockify_status", arguments: "{}" },
                extra_content: { google: { thought_signature: "SIG_ABC" } },
              },
            ],
          },
        },
      ],
    };
    const result = await client(payload).completeWithTools!([{ role: "user", content: "x" }], tools);
    expect(result.toolCalls[0].thoughtSignature).toBe("SIG_ABC");
  });

  it("echoes the signature back on continuation tool_calls (Gemini 400s without it) and omits it when absent", async () => {
    const captured: { body?: string } = {};
    const payload = { choices: [{ message: { content: "ok", tool_calls: [] } }] };
    await client(payload, true, captured).completeWithTools!(
      [
        { role: "user", content: "do it" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "clockify_status", arguments: {}, thoughtSignature: "SIG_ABC" }],
        },
        { role: "tool", toolCallId: "c1", content: "{}" },
      ],
      tools,
    );
    const body = JSON.parse(captured.body ?? "{}");
    expect(body.messages[1].tool_calls[0].extra_content).toEqual({ google: { thought_signature: "SIG_ABC" } });

    // A signature-less call (DeepSeek et al.) emits NO extra_content key.
    await client(payload, true, captured).completeWithTools!(
      [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "clockify_status", arguments: {} }],
        },
        { role: "tool", toolCallId: "c1", content: "{}" },
      ],
      tools,
    );
    expect("extra_content" in JSON.parse(captured.body ?? "{}").messages[0].tool_calls[0]).toBe(false);
  });
});

describe("createModelClient reasoning effort", () => {
  it("sends reasoning_effort on BOTH paths when configured, omits it otherwise", async () => {
    const captured: { body?: string } = {};
    const payload = { choices: [{ message: { content: "{}", tool_calls: [] } }] };
    const c = createModelClient({
      baseUrl: "https://api.test/v1",
      apiKey: "fake",
      model: "m",
      reasoningEffort: "none",
      fetchImpl: fakeFetch(payload, true, captured),
    });
    await c.complete([{ role: "user", content: "hi" }]);
    expect(JSON.parse(captured.body ?? "{}").reasoning_effort).toBe("none");
    await c.completeWithTools!([{ role: "user", content: "hi" }], tools);
    expect(JSON.parse(captured.body ?? "{}").reasoning_effort).toBe("none");

    const plain = createModelClient({
      baseUrl: "https://api.test/v1",
      apiKey: "fake",
      model: "m",
      fetchImpl: fakeFetch(payload, true, captured),
    });
    await plain.complete([{ role: "user", content: "hi" }]);
    expect("reasoning_effort" in JSON.parse(captured.body ?? "{}")).toBe(false);
  });
});

describe("createModelClient thinking mode", () => {
  it("keeps the default request body byte-compatible and emits the exact field only when configured", async () => {
    const captured: { body?: string } = {};
    const payload = { choices: [{ message: { content: "{}", tool_calls: [] } }] };
    const plain = createModelClient({
      baseUrl: "https://api.test/v1",
      apiKey: "fake",
      model: "m",
      fetchImpl: fakeFetch(payload, true, captured),
    });
    await plain.complete([{ role: "user", content: "hi" }]);
    expect(captured.body).toBe(
      '{"model":"m","temperature":0,"messages":[{"role":"user","content":"hi"}],"response_format":{"type":"json_object"}}',
    );

    const disabled = createModelClient({
      baseUrl: "https://api.test/v1",
      apiKey: "fake",
      model: "m",
      thinkingMode: "disabled",
      fetchImpl: fakeFetch(payload, true, captured),
    });
    await disabled.complete([{ role: "user", content: "hi" }]);
    expect(JSON.parse(captured.body ?? "{}").thinking).toEqual({ type: "disabled" });
    await disabled.completeWithTools!([{ role: "user", content: "hi" }], tools);
    expect(JSON.parse(captured.body ?? "{}").thinking).toEqual({ type: "disabled" });
  });
});

describe("createModelClient seed", () => {
  it("sends seed on BOTH paths when configured, omits it otherwise", async () => {
    const captured: { body?: string } = {};
    const payload = { choices: [{ message: { content: "{}", tool_calls: [] } }] };
    const c = createModelClient({
      baseUrl: "https://api.test/v1",
      apiKey: "fake",
      model: "m",
      seed: 7,
      fetchImpl: fakeFetch(payload, true, captured),
    });
    await c.complete([{ role: "user", content: "hi" }]);
    expect(JSON.parse(captured.body ?? "{}").seed).toBe(7);
    await c.completeWithTools!([{ role: "user", content: "hi" }], tools);
    expect(JSON.parse(captured.body ?? "{}").seed).toBe(7);

    const plain = createModelClient({
      baseUrl: "https://api.test/v1",
      apiKey: "fake",
      model: "m",
      fetchImpl: fakeFetch(payload, true, captured),
    });
    await plain.complete([{ role: "user", content: "hi" }]);
    expect("seed" in JSON.parse(captured.body ?? "{}")).toBe(false);
  });

  it("sends seed 0 (a falsy-but-valid seed must not be dropped)", async () => {
    const captured: { body?: string } = {};
    const payload = { choices: [{ message: { content: "{}", tool_calls: [] } }] };
    const c = createModelClient({
      baseUrl: "https://api.test/v1",
      apiKey: "fake",
      model: "m",
      seed: 0,
      fetchImpl: fakeFetch(payload, true, captured),
    });
    await c.complete([{ role: "user", content: "hi" }]);
    expect(JSON.parse(captured.body ?? "{}").seed).toBe(0);
  });
});

describe("createModelClient token usage", () => {
  it("maps the provider's usage onto the completion (and omits it when absent)", async () => {
    const withUsage = {
      choices: [{ message: { content: "hi", tool_calls: [] } }],
      usage: { prompt_tokens: 1200, completion_tokens: 88 },
    };
    const reported = await client(withUsage).completeWithTools!([{ role: "user", content: "x" }], tools);
    expect(reported.usage).toEqual({ promptTokens: 1200, completionTokens: 88 });

    const noUsage = { choices: [{ message: { content: "hi", tool_calls: [] } }] };
    const absent = await client(noUsage).completeWithTools!([{ role: "user", content: "x" }], tools);
    expect(absent.usage).toBeUndefined();
  });

  it("reports JSON-mode (complete) usage through the onUsage sink", async () => {
    const withUsage = {
      choices: [{ message: { content: "{}" } }],
      usage: { prompt_tokens: 1234, completion_tokens: 56 },
    };
    let seen: { promptTokens: number; completionTokens: number } | undefined;
    await client(withUsage).complete([{ role: "user", content: "x" }], (u) => {
      seen = u;
    });
    expect(seen).toEqual({ promptTokens: 1234, completionTokens: 56 });

    const noUsage = { choices: [{ message: { content: "{}" } }] };
    let calls = 0;
    await client(noUsage).complete([{ role: "user", content: "x" }], () => {
      calls += 1;
    });
    expect(calls).toBe(0); // absence ≠ zero: the sink never fires without a usage block
  });

  it("captures cached prompt tokens from BOTH the DeepSeek and the OpenAI-compat shapes (and omits when absent)", async () => {
    // DeepSeek reports a hit/miss split on the usage block.
    const deepseek = {
      choices: [{ message: { content: "hi", tool_calls: [] } }],
      usage: { prompt_tokens: 1200, completion_tokens: 88, prompt_cache_hit_tokens: 1024, prompt_cache_miss_tokens: 176 },
    };
    const r1 = await client(deepseek).completeWithTools!([{ role: "user", content: "x" }], tools);
    expect(r1.usage).toEqual({ promptTokens: 1200, completionTokens: 88, cachedPromptTokens: 1024 });

    // OpenAI-compatible backends nest it under prompt_tokens_details.cached_tokens.
    const compat = {
      choices: [{ message: { content: "hi", tool_calls: [] } }],
      usage: { prompt_tokens: 900, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 512 } },
    };
    const r2 = await client(compat).completeWithTools!([{ role: "user", content: "x" }], tools);
    expect(r2.usage).toEqual({ promptTokens: 900, completionTokens: 40, cachedPromptTokens: 512 });

    // No cache field → the key is OMITTED (absence ≠ a zero cache hit).
    const plain = {
      choices: [{ message: { content: "hi", tool_calls: [] } }],
      usage: { prompt_tokens: 100, completion_tokens: 5 },
    };
    const r3 = await client(plain).completeWithTools!([{ role: "user", content: "x" }], tools);
    expect(r3.usage).toEqual({ promptTokens: 100, completionTokens: 5 });

    // The JSON-mode sink also carries the cached count.
    const sinkPayload = {
      choices: [{ message: { content: "{}" } }],
      usage: { prompt_tokens: 700, completion_tokens: 12, prompt_cache_hit_tokens: 640 },
    };
    let seen: { cachedPromptTokens?: number } | undefined;
    await client(sinkPayload).complete([{ role: "user", content: "x" }], (u) => {
      seen = u;
    });
    expect(seen?.cachedPromptTokens).toBe(640);
  });
});

describe("createModelClient retry + provider error detail", () => {
  /** Queue of responses; each call shifts the next one. */
  function sequencedFetch(responses: Array<{ status: number; body?: string; payload?: unknown }>): {
    impl: typeof fetch;
    calls: () => number;
  } {
    let n = 0;
    const impl = vi.fn(async () => {
      const next = responses[Math.min(n, responses.length - 1)];
      n += 1;
      return {
        ok: next.status < 400,
        status: next.status,
        json: async () => next.payload ?? { choices: [{ message: { content: "ok" } }] },
        text: async () => next.body ?? "",
      } as Response;
    }) as unknown as typeof fetch;
    return { impl, calls: () => n };
  }

  function retryClient(fetchImpl: typeof fetch, sleeps: number[]) {
    return createModelClient({
      baseUrl: "https://api.test/v1",
      apiKey: "fake",
      model: "m",
      fetchImpl,
      sleepImpl: async (ms: number) => {
        sleeps.push(ms);
      },
    });
  }

  it("retries ONCE on 429 with a backoff sleep, then succeeds", async () => {
    const sleeps: number[] = [];
    const seq = sequencedFetch([{ status: 429, body: "rate limited" }, { status: 200 }]);
    const text = await retryClient(seq.impl, sleeps).complete([{ role: "user", content: "hi" }]);
    expect(text).toBe("ok");
    expect(seq.calls()).toBe(2);
    expect(sleeps).toHaveLength(1);
  });

  it("retries once on 5xx then throws only stable status/request metadata", async () => {
    const sleeps: number[] = [];
    const seq = sequencedFetch([{ status: 503, body: '{"error":"overloaded"}' }]);
    await expect(retryClient(seq.impl, sleeps).complete([{ role: "user", content: "hi" }])).rejects.toThrow(
      /provider_http_error status=503 request_id=unknown/,
    );
    expect(seq.calls()).toBe(2);
  });

  it("does NOT retry a 4xx (other than 429) and does not expose its body", async () => {
    const sleeps: number[] = [];
    const seq = sequencedFetch([{ status: 400, body: "bad request shape" }]);
    await expect(retryClient(seq.impl, sleeps).complete([{ role: "user", content: "hi" }])).rejects.toThrow(
      /provider_http_error status=400 request_id=unknown/,
    );
    expect(seq.calls()).toBe(1);
    expect(sleeps).toHaveLength(0);
  });

  it("clamps a huge provider body to a short snippet", async () => {
    const seq = sequencedFetch([{ status: 400, body: "x".repeat(1000) }]);
    const error = await retryClient(seq.impl, [])
      .complete([{ role: "user", content: "hi" }])
      .then(() => undefined)
      .catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message.length).toBeLessThan(300);
  });

  it("a timeout abort is NOT retried (the budget is already spent)", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const timeoutFetch = vi.fn(async () => {
      calls += 1;
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    const c = createModelClient({
      baseUrl: "https://api.test/v1",
      apiKey: "fake",
      model: "m",
      timeoutMs: 5,
      fetchImpl: timeoutFetch,
      sleepImpl: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    await expect(c.complete([{ role: "user", content: "hi" }])).rejects.toThrow(/timed out after 5ms/);
    expect(calls).toBe(1);
    expect(sleeps).toHaveLength(0);
  });

  it("a caller abort during retry backoff performs no provider retry", async () => {
    const controller = new AbortController();
    const calls: number[] = [];
    const c = createModelClient({
      baseUrl: "https://api.test/v1",
      apiKey: "fake",
      model: "m",
      fetchImpl: vi.fn(async () => {
        calls.push(1);
        return new Response("", { status: 503 });
      }) as unknown as typeof fetch,
      sleepImpl: async () => {
        controller.abort();
      },
    });

    await expect(
      c.complete([{ role: "user", content: "hi" }], undefined, controller.signal),
    ).rejects.toThrow(/aborted/i);
    expect(calls).toHaveLength(1);
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

  it("combines the caller signal with the timeout signal on both model methods", async () => {
    const captured: { signals: Array<AbortSignal | undefined> } = { signals: [] };
    const caller = new AbortController();
    const c = createModelClient({
      baseUrl: "https://api.test/v1",
      apiKey: "fake",
      model: "test-model",
      fetchImpl: signalCapturingFetch(captured),
    });
    await c.complete([{ role: "user", content: "hi" }], undefined, caller.signal);
    await c.completeWithTools!([{ role: "user", content: "hi" }], tools, caller.signal);

    caller.abort();
    expect(captured.signals).toHaveLength(2);
    for (const signal of captured.signals) expect(signal?.aborted).toBe(true);
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

  it("maps a timeout abort DURING the success-path body read to the clean error (undici aborts the body on the same signal)", async () => {
    const bodyTimeoutFetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
        },
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const c = createModelClient({
      baseUrl: "https://api.test/v1",
      apiKey: "fake",
      model: "test-model",
      timeoutMs: 5,
      fetchImpl: bodyTimeoutFetch,
    });
    await expect(c.complete([{ role: "user", content: "hi" }])).rejects.toThrow(/timed out after 5ms/);
    await expect(c.completeWithTools!([{ role: "user", content: "hi" }], tools)).rejects.toThrow(
      /timed out after 5ms/,
    );
  });

  it("a malformed 200 body throws stable metadata without exposing the body", async () => {
    const malformedFetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError(`Unexpected token '<', "<html>gateway"... is not valid JSON`);
        },
        text: async () => "<html>gateway error</html>",
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const c = createModelClient({
      baseUrl: "https://api.test/v1",
      apiKey: "fake",
      model: "test-model",
      fetchImpl: malformedFetch,
    });
    await expect(c.complete([{ role: "user", content: "hi" }])).rejects.toThrow(
      /provider_malformed_response status=200 request_id=unknown/,
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
