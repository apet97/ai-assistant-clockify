import { vi } from "vitest";
import type {
  ModelClient,
  ModelMessage,
  ToolCompletion,
  ToolDefinition,
} from "../../src/assistant/model-client.js";

export interface ScriptedToolModel extends ModelClient {
  completeWithTools: (messages: ModelMessage[], tools: ToolDefinition[]) => Promise<ToolCompletion>;
  /** A deep-cloned snapshot of the messages array passed to each completeWithTools call. */
  calls: Array<{ messages: ModelMessage[]; tools: ToolDefinition[] }>;
}

/**
 * A ModelClient whose `completeWithTools` returns a pre-scripted SEQUENCE of
 * completions — one per call — so a multi-step agentic loop can be driven
 * deterministically. When the loop runs past the script, the LAST completion is
 * repeated (useful for "model keeps proposing a tool call" / maxSteps tests).
 * Each call's incoming transcript is captured (deep-cloned) for assertions about
 * what the model saw — e.g. that a prior tool result was fed back.
 */
export function scriptedToolModel(completions: ToolCompletion[]): ScriptedToolModel {
  const calls: Array<{ messages: ModelMessage[]; tools: ToolDefinition[] }> = [];
  let index = 0;
  return {
    complete: vi.fn(async () => "{}"),
    completeWithTools: vi.fn(async (messages: ModelMessage[], tools: ToolDefinition[]) => {
      calls.push({ messages: JSON.parse(JSON.stringify(messages)) as ModelMessage[], tools });
      const completion = completions[Math.min(index, completions.length - 1)];
      index += 1;
      return completion;
    }),
    calls,
  };
}
