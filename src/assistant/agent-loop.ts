/**
 * The durable, approval-gated agentic tool-loop.
 *
 * A vanilla agent loop runs a turn to completion; ours is interruptible because a
 * risky write must pause for a button-confirm that arrives as a SEPARATE HTTP
 * request. So this loop:
 *   - feeds reads + safe-write RECEIPTS back to the model and re-plans (the
 *     read-then-act capability the single-turn planner lacks), and
 *   - STOPS at the first risky write (a `preview` outcome), returning an
 *     `interrupt` the caller persists + resumes after confirmation.
 *
 * It is a PURE mechanism: it never touches the store, the Clockify client, audit,
 * undo, or the confirmation lifecycle. The caller injects `runAction` (which goes
 * through the harness trust boundary) and `onStep` (streaming). The harness — not
 * this loop — decides risk: a risky action can only ever return a `preview`, so a
 * risky write can NEVER auto-execute inside the loop.
 */
import type { ActionResult, ClarifyOption, ConfirmableOperation, PreviewCard } from "../harness/action.js";
import { hasChanges, type SuccessReceipt, type ErrorReceipt } from "../harness/receipts.js";
import type { ModelClient, ModelMessage, ToolCall, ToolCompletion, ToolDefinition } from "./model-client.js";
import { capToolResultForModel } from "./tool-results.js";

export { capToolResultForModel, TOOL_RESULT_MAX_BYTES } from "./tool-results.js";

/** Max model round-trips per turn before we stop and answer truthfully. */
export const DEFAULT_MAX_STEPS = 6;
/** Max tool calls honored from a single model turn (guards pathological output). */
const DEFAULT_MAX_TOOL_CALLS_PER_STEP = 8;

export const EXHAUSTED_TEXT =
  "I wasn't able to finish that within my step limit. Could you narrow it down or break it into smaller steps?";

/** One executed tool call + its harness result, surfaced for streaming. */
export interface AgentStep {
  call: ToolCall;
  result: ActionResult;
}

export type AgentTurnResult =
  | { kind: "final"; text: string; transcript: ModelMessage[] }
  | { kind: "clarify"; message: string; options?: ClarifyOption[]; transcript: ModelMessage[] }
  | { kind: "partial"; transcript: ModelMessage[] }
  | {
      kind: "interrupt";
      call: ToolCall;
      preview: PreviewCard;
      operation: ConfirmableOperation;
      transcript: ModelMessage[];
    }
  | { kind: "exhausted"; text: string; transcript: ModelMessage[] }
  // The client disconnected mid-turn (the route aborted the signal). The loop
  // stops at its next boundary so it issues no further model calls or writes for
  // a turn nobody is watching. The caller discards this (no reply is sent).
  | { kind: "aborted"; transcript: ModelMessage[] };

export interface RunAgentTurnInput {
  /** Must expose completeWithTools (the loop is native-tool-calling only). */
  modelClient: ModelClient;
  /** The starting transcript: typically [system, ...history, user]. */
  messages: ModelMessage[];
  tools: ToolDefinition[];
  /** Execute one proposed tool call through the harness trust boundary. */
  runAction: (call: ToolCall) => Promise<ActionResult>;
  /** Streaming hook: fired once per executed read/safe-write step (not for the terminal preview). */
  onStep?: (step: AgentStep) => void;
  maxSteps?: number;
  maxToolCallsPerStep?: number;
  /**
   * Cooperative cancellation. When this aborts (the route fires it on client
   * disconnect), the loop stops at its next boundary and returns `aborted` —
   * no further model calls, no further tool executions.
   */
  signal?: AbortSignal;
}

function assistantToolCallTurn(completion: ToolCompletion, calls: ToolCall[]): ModelMessage {
  return {
    role: "assistant",
    content: completion.text ?? "",
    toolCalls: calls,
    // Thinking-mode reasoning must survive into the transcript (and the persisted
    // suspension): the provider rejects a continuation that drops it.
    ...(completion.reasoningContent ? { reasoningContent: completion.reasoningContent } : {}),
  };
}

function toolResultTurn(toolCallId: string, receipt: SuccessReceipt | ErrorReceipt): ModelMessage {
  return { role: "tool", toolCallId, content: capToolResultForModel(receipt) };
}

/** Denials at these boundaries cannot be repaired by another provider turn.
 * Continuing would spend latency/tokens and lets model prose misrepresent a
 * fresh-request or policy requirement as typed confirmation. */
function isTerminalSafetyDenial(receipt: SuccessReceipt | ErrorReceipt): receipt is ErrorReceipt {
  if (receipt.ok !== false) return false;
  if (receipt.code === "policy_denied") return true;
  return receipt.code.startsWith("intent_capability_");
}

function canonicalToolArguments(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalToolArguments).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalToolArguments(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function toolCallSignature(call: ToolCall): string {
  return `${call.name}\0${canonicalToolArguments(call.arguments)}`;
}

/**
 * Run the agentic loop until the model answers, asks to clarify, hits the first
 * risky write (interrupt), or exhausts the step budget. Returns the running
 * transcript so the caller can persist it for a durable resume.
 */
export async function runAgentTurn(input: RunAgentTurnInput): Promise<AgentTurnResult> {
  if (typeof input.modelClient.completeWithTools !== "function") {
    throw new Error("runAgentTurn requires a model client that supports completeWithTools");
  }
  const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxCalls = input.maxToolCallsPerStep ?? DEFAULT_MAX_TOOL_CALLS_PER_STEP;
  const transcript: ModelMessage[] = [...input.messages];
  const completedReadSignatures = new Set<string>();

  for (let step = 0; step < maxSteps; step += 1) {
    // Client gone → stop BEFORE the next (paid) model call.
    if (input.signal?.aborted) return { kind: "aborted", transcript };
    let completion: ToolCompletion;
    try {
      completion = await input.modelClient.completeWithTools(transcript, input.tools, input.signal);
    } catch (error) {
      if (input.signal?.aborted) return { kind: "aborted", transcript };
      throw error;
    }
    const calls = completion.toolCalls.slice(0, maxCalls);

    if (calls.length === 0) {
      return { kind: "final", text: completion.text ?? "", transcript };
    }

    // We declare in the assistant turn ONLY the calls we honor in this transcript,
    // so every declared tool_call_id gets a tool reply (now, or on resume for the
    // risky one). Trailing calls after an interrupt/clarify are dropped — the model
    // re-decides on resume with the real result in hand.
    const honored: ToolCall[] = [];
    const toolResults: ModelMessage[] = [];

    for (const call of calls) {
      // Client gone → stop BEFORE running another action (e.g. a safe write).
      if (input.signal?.aborted) return { kind: "aborted", transcript };
      const signature = toolCallSignature(call);
      if (completedReadSignatures.has(signature)) {
        if (honored.length > 0) transcript.push(assistantToolCallTurn(completion, honored), ...toolResults);
        return {
          kind: "final",
          text: "The requested information is already recorded in the result above.",
          transcript,
        };
      }
      const result = await input.runAction(call);
      honored.push(call);

      if (result.kind === "preview") {
        // Risky write → suspend at the FIRST risky. The risky call's tool reply is
        // filled in on resume after the user confirms; nothing is committed here.
        transcript.push(assistantToolCallTurn(completion, honored), ...toolResults);
        return { kind: "interrupt", call, preview: result.preview, operation: result.operation, transcript };
      }

      input.onStep?.({ call, result });

      if (result.kind === "clarify") {
        // Ask the user; the next user message continues via normal chat history
        // (this transcript is not persisted/resumed).
        transcript.push(assistantToolCallTurn(completion, honored), ...toolResults);
        return { kind: "clarify", message: result.message, options: result.options, transcript };
      }

      if (result.kind === "partial") {
        transcript.push(assistantToolCallTurn(completion, honored), ...toolResults);
        return { kind: "partial", transcript };
      }

      // receipt (read or safe write; success or error) → feed back to the model.
      toolResults.push(toolResultTurn(call.id, result.receipt));
      if (result.receipt.ok && !hasChanges(result.receipt.changed)) completedReadSignatures.add(signature);
      else if (result.receipt.ok) completedReadSignatures.clear();
      if (isTerminalSafetyDenial(result.receipt)) {
        transcript.push(assistantToolCallTurn(completion, honored), ...toolResults);
        return { kind: "final", text: "", transcript };
      }
    }

    transcript.push(assistantToolCallTurn(completion, honored), ...toolResults);
  }

  return { kind: "exhausted", text: EXHAUSTED_TEXT, transcript };
}
