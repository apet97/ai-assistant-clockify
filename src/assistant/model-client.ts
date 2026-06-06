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

export interface ModelClient {
  complete(messages: ModelMessage[]): Promise<string>;
}

export interface ModelClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
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
  };
}
