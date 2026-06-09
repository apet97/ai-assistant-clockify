/**
 * Model adapter (TECH_STACK "Model Adapter"). A thin, provider-isolated client
 * that returns the raw completion text; the planner owns JSON validation and the
 * single repair attempt. The LLM API key is sent only in the HTTP Authorization
 * header to the LLM endpoint — never inside the prompt/messages, and never logged.
 */
export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
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
  name: string;
  arguments: Record<string, unknown>;
}

/** The result of a tool-calling completion: assistant text and/or tool calls. */
export interface ToolCompletion {
  text: string;
  toolCalls: ToolCall[];
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
  function?: { name?: string; arguments?: string };
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: RawToolCall[] } }>;
}

function parseToolCalls(rawCalls: RawToolCall[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const call of rawCalls) {
    const name = call?.function?.name;
    if (!name) continue;
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
    calls.push({ name, arguments: args });
  }
  return calls;
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
          messages,
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
          messages,
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
      };
    },
  };
}
