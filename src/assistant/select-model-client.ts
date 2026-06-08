import { createModelClient } from "./model-client.js";
import { createGeminiCliModelClient } from "./gemini-cli-client.js";
import type { ModelClient } from "./model-client.js";

/**
 * Shared planner-backend selection (`LLM_PROVIDER`). Extracted so the live server
 * (`server.ts`) and the opt-in planner eval (`scripts/eval-planner.ts`) build the
 * model client exactly the same way — the eval must exercise the same backend the
 * product uses. `gemini-cli` carries its own OAuth session (no HTTP creds and it
 * does not spawn the CLI until `complete()` is called).
 */
export interface ModelClientSelection {
  llmProvider: "http" | "gemini-cli";
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  geminiModel?: string;
}

export function selectModelClient(config: ModelClientSelection): ModelClient {
  if (config.llmProvider === "gemini-cli") {
    return createGeminiCliModelClient({ model: config.geminiModel });
  }
  if (!config.llmBaseUrl || !config.llmApiKey || !config.llmModel) {
    throw new Error("LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL are required when LLM_PROVIDER=http");
  }
  return createModelClient({
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey,
    model: config.llmModel,
  });
}
