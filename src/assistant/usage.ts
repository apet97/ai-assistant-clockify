import type { ModelClient, ModelMessage, ToolDefinition } from "./model-client.js";

/**
 * Per-turn model telemetry, accumulated by {@link trackUsage}: how many model
 * calls a turn made, what they cost (when the provider reports usage), and the
 * wall-clock spent inside the model. `usageReported` distinguishes "this
 * backend reports no token counts" (gemini-cli, JSON mode) from a genuine zero.
 */
export interface TurnUsage {
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  usageReported: boolean;
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
  const usage: TurnUsage = { modelCalls: 0, promptTokens: 0, completionTokens: 0, usageReported: false, modelMs: 0 };

  const timed = async <T>(run: () => Promise<T>): Promise<T> => {
    usage.modelCalls += 1;
    const startMs = now().getTime();
    try {
      return await run();
    } finally {
      usage.modelMs += now().getTime() - startMs;
    }
  };

  const wrapped: ModelClient = {
    complete: (messages: ModelMessage[]) => timed(() => client.complete(messages)),
  };
  if (typeof client.completeWithTools === "function") {
    wrapped.completeWithTools = (messages: ModelMessage[], tools: ToolDefinition[]) =>
      timed(async () => {
        const completion = await client.completeWithTools!(messages, tools);
        if (completion.usage) {
          usage.usageReported = true;
          usage.promptTokens += completion.usage.promptTokens;
          usage.completionTokens += completion.usage.completionTokens;
        }
        return completion;
      });
  }
  return { client: wrapped, usage };
}
