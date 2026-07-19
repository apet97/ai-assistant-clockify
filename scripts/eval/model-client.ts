import type { ModelClient } from "../../src/assistant/model-client.js";
import {
  selectModelClient,
  type ModelClientSelection,
} from "../../src/assistant/select-model-client.js";

/**
 * Build the production model client unless an eval-only DeepSeek thinking mode
 * is explicitly requested. Keeping the benchmark override under `scripts/`
 * prevents a release eval from depending on or mutating the deployed variable.
 */
export function selectEvalModelClient(selection: ModelClientSelection): ModelClient {
  const thinkingMode = process.env.EVAL_DEEPSEEK_THINKING_MODE;
  if (thinkingMode === undefined) return selectModelClient(selection);
  if (thinkingMode !== "enabled" && thinkingMode !== "disabled") {
    throw new Error("EVAL_DEEPSEEK_THINKING_MODE must be enabled or disabled");
  }
  if (selection.llmProvider !== "http") {
    throw new Error("The eval-only thinking toggle requires a configured HTTP model");
  }
  return selectModelClient({ ...selection, llmThinkingMode: thinkingMode });
}
