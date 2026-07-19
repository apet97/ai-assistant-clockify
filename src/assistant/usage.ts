import type { ModelClient, ModelMessage, TokenUsage, ToolDefinition } from "./model-client.js";

/**
 * Per-turn model telemetry, accumulated by {@link trackUsage}: how many model
 * calls a turn made, what they cost (when the provider reports usage), and the
 * wall-clock spent inside the model. `usageReported` distinguishes "this
 * backend reports no token counts" (gemini-cli) from a genuine zero — the HTTP
 * client surfaces usage on BOTH paths (tool-calling and JSON mode).
 */
export interface TurnUsage {
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  usageReported: boolean;
  /**
   * Prompt tokens that HIT the provider's cache (a cheaper subset of promptTokens),
   * summed across the turn's calls. `cachedPromptReported` distinguishes "the backend
   * reported no cache info" (stays 0) from a genuine zero-hit turn — observability into
   * how much of the (now subset-shrunk) prompt prefix the provider is caching.
   */
  cachedPromptTokens: number;
  cachedPromptReported: boolean;
  /** Wall-clock summed across model calls (failed calls count — they cost time too). */
  modelMs: number;
}

/**
 * Wrap a model client so every call accumulates into one {@link TurnUsage}.
 * CRITICAL: the wrapper defines `completeWithTools` ONLY when the inner client
 * has it — the chat route and resume path branch on its presence (a wrapper
 * that materializes it would silently flip gemini-cli into tool mode).
 */
export function trackUsage(client: ModelClient, now: () => Date): { client: ModelClient; usage: TurnUsage } {
  const usage: TurnUsage = {
    modelCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    usageReported: false,
    cachedPromptTokens: 0,
    cachedPromptReported: false,
    modelMs: 0,
  };

  const timed = async <T>(run: () => Promise<T>): Promise<T> => {
    usage.modelCalls += 1;
    const startMs = now().getTime();
    try {
      return await run();
    } finally {
      usage.modelMs += now().getTime() - startMs;
    }
  };

  const accumulate = (reported: TokenUsage): void => {
    usage.usageReported = true;
    usage.promptTokens += reported.promptTokens;
    usage.completionTokens += reported.completionTokens;
    // Cache hits are observability only and not every provider reports them — so a
    // missing field leaves the count at 0 AND keeps cachedPromptReported false
    // (honest absence), never fabricating a zero-hit turn.
    if (typeof reported.cachedPromptTokens === "number") {
      usage.cachedPromptReported = true;
      usage.cachedPromptTokens += reported.cachedPromptTokens;
    }
  };

  const wrapped: ModelClient = {
    // The inner sink fires only when the provider reported usage, so JSON-mode
    // turns now feed telemetry too (caller-supplied sinks are also honored).
    complete: (messages: ModelMessage[], onUsage, signal, options) =>
      timed(() =>
        client.complete(messages, (reported) => {
          accumulate(reported);
          onUsage?.(reported);
        }, signal, options),
      ),
  };
  if (typeof client.completeWithTools === "function") {
    wrapped.completeWithTools = (messages: ModelMessage[], tools: ToolDefinition[], signal, options) =>
      timed(async () => {
        const completion = await client.completeWithTools!(messages, tools, signal, options);
        if (completion.usage) accumulate(completion.usage);
        return completion;
      });
  }
  return { client: wrapped, usage };
}
