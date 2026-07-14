/**
 * Model adapter (TECH_STACK "Model Adapter"). A thin, provider-isolated client
 * that returns the raw completion text; the planner owns JSON validation and the
 * single repair attempt. The LLM API key is sent only in the HTTP Authorization
 * header to the LLM endpoint — never inside the prompt/messages, and never logged.
 */
export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /**
   * Present on an assistant turn that invoked tools (an agentic-loop continuation).
   * Serialized to OpenAI `tool_calls`; the model needs to see its own prior calls
   * to make sense of the tool results that follow.
   */
  toolCalls?: ToolCall[];
  /**
   * Present on a `role: "tool"` message — the id of the assistant tool call this
   * message answers. Serialized to OpenAI `tool_call_id`.
   */
  toolCallId?: string;
  /**
   * Thinking-mode reasoning attached to an assistant turn (DeepSeek
   * `reasoning_content`). The provider REQUIRES it passed back verbatim when the
   * turn re-enters the transcript (a continuation that drops it is rejected with
   * a 400), so the loop must carry it. Never shown to the user.
   */
  reasoningContent?: string;
}

/** A provider-validated tool the model may call (native function-calling). */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments (generated from the action's Zod schema). */
  parameters: Record<string, unknown>;
}

/** One tool the model chose to call, with its (provider-validated) arguments. */
export interface ToolCall {
  /**
   * The provider's tool-call id (synthesized as `call_<index>` if the provider
   * omits it). Load-bearing for the agentic loop: a tool-result message must be
   * keyed back to the call it answers via this id.
   */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /**
   * Gemini 3.x attaches an opaque thought signature to each tool call and
   * REQUIRES it echoed back verbatim on continuation (400 otherwise) — the
   * same contract class as DeepSeek's reasoning_content. Absent elsewhere.
   */
  thoughtSignature?: string;
}

/** Token counts the provider reported for one completion (cost telemetry). */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  /**
   * Prompt tokens that HIT the provider's prompt cache, when reported — a subset of
   * `promptTokens` billed at a fraction of the price. DeepSeek reports it as
   * `prompt_cache_hit_tokens`; OpenAI-compatible backends as
   * `prompt_tokens_details.cached_tokens`. OMITTED when the provider reports no cache
   * info (absence ≠ a zero cache hit). Observability only — the request bytes are
   * unchanged; a stable prompt prefix (see toolsForModel + buildToolSystemPrompt) is
   * what makes these hits happen.
   */
  cachedPromptTokens?: number;
}

/**
 * Sink for usage reported by the JSON-mode {@link ModelClient.complete} path,
 * whose return type is a bare string (the planner only needs the text). The HTTP
 * client invokes it ONLY when the provider actually reported a usage block, so a
 * sink that never fires means "no counts" — never a fabricated zero. The
 * gemini-cli backend genuinely reports none and never calls it.
 */
export type UsageSink = (usage: TokenUsage) => void;

/** The result of a tool-calling completion: assistant text and/or tool calls. */
export interface ToolCompletion {
  text: string;
  toolCalls: ToolCall[];
  /** Thinking-mode reasoning to thread back on continuation (see ModelMessage). */
  reasoningContent?: string;
  /** Present only when the provider reported token counts (absence ≠ zero). */
  usage?: TokenUsage;
}

export interface ModelClient {
  /**
   * JSON-mode completion. Returns the raw text (the planner owns validation).
   * `onUsage` is an optional sink the implementation invokes when the provider
   * reported token counts — the bare-string return can't carry them, but cost
   * telemetry still needs them (see {@link UsageSink}).
   */
  complete(messages: ModelMessage[], onUsage?: UsageSink): Promise<string>;
  /**
   * Optional native tool-calling. When present, the planner prefers it: the model
   * calls typed tools whose args the provider validates against the JSON schema,
   * killing the arg-shape-guessing class at the source. Clients without it (e.g.
   * the gemini-cli backend) keep the JSON-mode path. The harness still re-validates
   * every proposed action against its Zod schema + risk/policy gate — provider
   * validation is a convenience, not the trust boundary.
   */
  completeWithTools?(messages: ModelMessage[], tools: ToolDefinition[]): Promise<ToolCompletion>;
}

export interface ModelClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * Per-request abort timeout. Without one a hung provider hangs the chat turn
   * forever (the route awaits this fetch). Default is generous — DeepSeek
   * thinking mode legitimately takes minutes on a long transcript.
   */
  timeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable backoff sleep for tests. */
  sleepImpl?: (ms: number) => Promise<void>;
  /**
   * Provider thinking control (OpenAI-compatible `reasoning_effort`; Gemini
   * maps it to thinking budgets — "none" disables thinking entirely). Omitted
   * from the wire when unset, so existing backends see byte-identical bodies.
   */
  reasoningEffort?: string;
  /**
   * Optional sampling seed (OpenAI-compatible `seed`). Providers that honor it make
   * temperature-0 runs more reproducible — an extra nudge toward run-to-run
   * consistency on weak models. Omitted from the wire when unset (byte-identical).
   */
  seed?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
/** Single retry on a transient provider failure (429/5xx), fixed backoff. */
const RETRY_BACKOFF_MS = 750;
function providerRequestId(response: Response): string {
  return response.headers?.get("x-request-id")
    ?? response.headers?.get("request-id")
    ?? response.headers?.get("cf-ray")
    ?? "unknown";
}

function providerFailure(category: string, response: Response): Error {
  return new Error(`${category} status=${response.status} request_id=${providerRequestId(response)}`);
}

interface RawToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
  extra_content?: { google?: { thought_signature?: string } };
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null; reasoning_content?: string | null; tool_calls?: RawToolCall[] };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** DeepSeek's prompt-cache hit count (cheaper tokens). */
    prompt_cache_hit_tokens?: number;
    /** OpenAI-compatible nesting for the same signal. */
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/** The cached-prompt-token count from either provider shape, or undefined if neither reported it. */
function parseCachedPromptTokens(usage: NonNullable<ChatCompletionResponse["usage"]>): number | undefined {
  if (typeof usage.prompt_cache_hit_tokens === "number") return usage.prompt_cache_hit_tokens;
  if (typeof usage.prompt_tokens_details?.cached_tokens === "number") return usage.prompt_tokens_details.cached_tokens;
  return undefined;
}

/** Map the provider's usage block to {@link TokenUsage}; undefined unless both counts are numbers. */
function parseUsage(usage: ChatCompletionResponse["usage"]): TokenUsage | undefined {
  if (typeof usage?.prompt_tokens === "number" && typeof usage.completion_tokens === "number") {
    const cachedPromptTokens = parseCachedPromptTokens(usage);
    return {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      // Omit when the provider reported no cache info (absence ≠ a zero cache hit).
      ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
    };
  }
  return undefined;
}

/**
 * Map raw tool calls to {@link ToolCall}, synthesizing an id for any backend
 * that omits one. `nextSyntheticSeq` is a per-client monotonic allocator: the
 * tool_call_id is load-bearing (a tool result keys back to the call it answers,
 * and the agentic resume keys the committed receipt purely on it), so a
 * synthesized id must be unique across the WHOLE transcript, not just within one
 * completion's array — an id-omitting OpenAI-compatible backend (e.g. some
 * Gemini compat layers) on a multi-step turn would otherwise emit "call_0" on
 * every step, yielding duplicate, ambiguous keys. Providers that supply ids are
 * untouched (the allocator never advances for them).
 */
function parseToolCalls(rawCalls: RawToolCall[], nextSyntheticSeq: () => number): ToolCall[] {
  const calls: ToolCall[] = [];
  rawCalls.forEach((call) => {
    const name = call?.function?.name;
    if (!name) return;
    let args: Record<string, unknown> = {};
    const raw = call?.function?.arguments;
    if (typeof raw === "string" && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
      } catch {
        args = {};
      }
    }
    // Most OpenAI-compatible providers return an id; synthesize a transcript-unique
    // one if not, so the loop can always correlate a tool result back to its call.
    const id = typeof call.id === "string" && call.id ? call.id : `call_${nextSyntheticSeq()}`;
    const thoughtSignature = call.extra_content?.google?.thought_signature;
    calls.push({ id, name, arguments: args, ...(thoughtSignature ? { thoughtSignature } : {}) });
  });
  return calls;
}

/**
 * Map an internal {@link ModelMessage} to the OpenAI chat-completion wire shape.
 * Plain system/user/assistant turns pass through as `{ role, content }` (byte-identical
 * to the previous verbatim serialization). The loop's two extra shapes are mapped:
 *   - an assistant turn carrying tool calls → `{ role, content, tool_calls: [...] }`
 *     (arguments are re-stringified, since the wire format expects a JSON string), and
 *   - a tool-result turn → `{ role: "tool", tool_call_id, content }`.
 */
function toWireMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
  const hasToolCalls = message.role === "assistant" && !!message.toolCalls && message.toolCalls.length > 0;
  // An assistant turn carrying tool calls and/or thinking-mode reasoning is
  // serialized as one object; a plain assistant/system/user turn falls through.
  if (message.role === "assistant" && (hasToolCalls || message.reasoningContent)) {
    return {
      role: "assistant",
      // A tool-call turn nulls empty content (OpenAI shape); a reasoning-only
      // turn keeps the original content verbatim.
      content: hasToolCalls ? message.content || null : message.content,
      // Thinking mode: the provider rejects a continuation that drops the turn's
      // reasoning, so it is echoed back verbatim whenever we captured one.
      ...(message.reasoningContent ? { reasoning_content: message.reasoningContent } : {}),
      ...(hasToolCalls
        ? {
            tool_calls: message.toolCalls!.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              // Gemini 3.x continuation contract: echo the opaque signature verbatim
              // or the provider 400s; emit nothing for signature-less backends.
              ...(call.thoughtSignature
                ? { extra_content: { google: { thought_signature: call.thoughtSignature } } }
                : {}),
            })),
          }
        : {}),
    };
  }
  return { role: message.role, content: message.content };
}

export function createModelClient(config: ModelClientConfig): ModelClient {
  const endpoint = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const doFetch = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = config.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retryable = (status: number): boolean => status === 429 || status >= 500;
  // Per-client monotonic counter for SYNTHESIZED tool-call ids (id-omitting
  // backends only). Spans every completion this client makes, so a multi-step
  // turn never reuses "call_0"; first synthesized id stays "call_0".
  let syntheticSeq = 0;
  const nextSyntheticSeq = (): number => syntheticSeq++;

  /**
   * POST one chat-completion body with the abort timeout (the signal also
   * bounds a stuck body read). A transient provider failure (429/5xx) retries
   * ONCE — chat completions have no server-side effect, so the retry is safe.
   * A timeout never retries (the 120s budget is already spent); the provider
   * error is reduced to a stable category/status/provider request id. Provider
   * bodies can echo prompts or tool results and must never enter production logs.
   */
  async function postChat(body: Record<string, unknown>): Promise<ChatCompletionResponse> {
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
          model: config.model,
          temperature: 0,
          ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
          ...(config.seed !== undefined ? { seed: config.seed } : {}),
          ...body,
        }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const name = (error as { name?: string } | null)?.name;
        if (name === "TimeoutError" || name === "AbortError") {
          throw new Error(`Model request timed out after ${timeoutMs}ms`);
        }
        throw error;
      }

      if (response.ok) {
        // The body read shares the request's abort signal (undici aborts a
        // stuck read on timeout), so map that abort to the SAME clean message
        // the fetch-level catch produces — and turn a malformed 2xx body into
        // a diagnosable error naming the status + a body snippet, matching the
        // non-2xx treatment instead of a context-free parser error.
        try {
          return (await response.json()) as ChatCompletionResponse;
        } catch (error) {
          const name = (error as { name?: string } | null)?.name;
          if (name === "TimeoutError" || name === "AbortError") {
            throw new Error(`Model request timed out after ${timeoutMs}ms`);
          }
          throw providerFailure("provider_malformed_response", response);
        }
      }

      await response.body?.cancel().catch(() => undefined);
      const willRetry = attempt === 0 && retryable(response.status);
      console.warn(
        `provider_http_error status=${response.status} request_id=${providerRequestId(response)}${willRetry ? " retry=1" : ""}`,
      );
      if (willRetry) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      throw providerFailure("provider_http_error", response);
    }
  }

  return {
    async complete(messages: ModelMessage[], onUsage?: UsageSink): Promise<string> {
      const data = await postChat({
        messages: messages.map(toWireMessage),
        response_format: { type: "json_object" },
      });
      const usage = parseUsage(data.usage);
      if (usage) onUsage?.(usage);
      return data.choices?.[0]?.message?.content ?? "";
    },

    async completeWithTools(messages: ModelMessage[], tools: ToolDefinition[]): Promise<ToolCompletion> {
      const data = await postChat({
        messages: messages.map(toWireMessage),
        tools: tools.map((tool) => ({
          type: "function",
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        })),
        tool_choice: "auto",
      });
      const message = data.choices?.[0]?.message;
      const usage = parseUsage(data.usage);
      return {
        text: message?.content ?? "",
        toolCalls: parseToolCalls(message?.tool_calls ?? [], nextSyntheticSeq),
        ...(message?.reasoning_content ? { reasoningContent: message.reasoning_content } : {}),
        ...(usage ? { usage } : {}),
      };
    },
  };
}
