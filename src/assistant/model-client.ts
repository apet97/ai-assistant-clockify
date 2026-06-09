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
}

/** The result of a tool-calling completion: assistant text and/or tool calls. */
export interface ToolCompletion {
  text: string;
  toolCalls: ToolCall[];
  /** Thinking-mode reasoning to thread back on continuation (see ModelMessage). */
  reasoningContent?: string;
}

export interface ModelClient {
  complete(messages: ModelMessage[]): Promise<string>;
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
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

interface RawToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null; reasoning_content?: string | null; tool_calls?: RawToolCall[] };
  }>;
}

function parseToolCalls(rawCalls: RawToolCall[]): ToolCall[] {
  const calls: ToolCall[] = [];
  rawCalls.forEach((call, index) => {
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
    // Most OpenAI-compatible providers return an id; synthesize a stable one if not,
    // so the loop can always correlate a tool result back to its call.
    const id = typeof call.id === "string" && call.id ? call.id : `call_${index}`;
    calls.push({ id, name, arguments: args });
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
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: message.content || null,
      // Thinking mode: the provider rejects a continuation that drops the turn's
      // reasoning, so it is echoed back verbatim whenever we captured one.
      ...(message.reasoningContent ? { reasoning_content: message.reasoningContent } : {}),
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    };
  }
  if (message.role === "assistant" && message.reasoningContent) {
    return { role: "assistant", content: message.content, reasoning_content: message.reasoningContent };
  }
  return { role: message.role, content: message.content };
}

export function createModelClient(config: ModelClientConfig): ModelClient {
  const endpoint = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const doFetch = config.fetchImpl ?? fetch;

  return {
    async complete(messages: ModelMessage[]): Promise<string> {
      const response = await doFetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: messages.map(toWireMessage),
          temperature: 0,
          response_format: { type: "json_object" },
        }),
      });

      if (!response.ok) {
        throw new Error(`Model request failed with status ${response.status}`);
      }

      const data = (await response.json()) as ChatCompletionResponse;
      return data.choices?.[0]?.message?.content ?? "";
    },

    async completeWithTools(messages: ModelMessage[], tools: ToolDefinition[]): Promise<ToolCompletion> {
      const response = await doFetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: messages.map(toWireMessage),
          temperature: 0,
          tools: tools.map((tool) => ({
            type: "function",
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          })),
          tool_choice: "auto",
        }),
      });

      if (!response.ok) {
        throw new Error(`Model request failed with status ${response.status}`);
      }

      const data = (await response.json()) as ChatCompletionResponse;
      const message = data.choices?.[0]?.message;
      return {
        text: message?.content ?? "",
        toolCalls: parseToolCalls(message?.tool_calls ?? []),
        ...(message?.reasoning_content ? { reasoningContent: message.reasoning_content } : {}),
      };
    },
  };
}
