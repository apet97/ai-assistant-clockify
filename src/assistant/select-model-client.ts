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
  /** Per-request abort timeout (ms) for the HTTP client; defaults to 120s. */
  llmTimeoutMs?: number;
  /** Provider thinking control (e.g. "none" disables Gemini thinking). */
  llmReasoningEffort?: string;
  geminiModel?: string;
}

/** Factory seam (defaults to the real builders) so tests can observe what is wired. */
export interface ModelClientFactories {
  createGeminiCli?: typeof createGeminiCliModelClient;
}

export function selectModelClient(
  config: ModelClientSelection,
  factories: ModelClientFactories = {},
): ModelClient {
  if (config.llmProvider === "gemini-cli") {
    // `LLM_TIMEOUT_MS` applies to the dev CLI's subprocess kill timer too; forward it
    // (the CLI default stands in when unset). `LLM_REASONING_EFFORT` has no `gemini`
    // CLI flag, so it is intentionally not threaded here.
    const createGeminiCli = factories.createGeminiCli ?? createGeminiCliModelClient;
    return createGeminiCli({ model: config.geminiModel, timeoutMs: config.llmTimeoutMs });
  }
  if (!config.llmBaseUrl || !config.llmApiKey || !config.llmModel) {
    throw new Error("LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL are required when LLM_PROVIDER=http");
  }
  return createModelClient({
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey,
    model: config.llmModel,
    timeoutMs: config.llmTimeoutMs,
    reasoningEffort: config.llmReasoningEffort,
  });
}
