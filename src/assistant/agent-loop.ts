/**
 * The durable, approval-gated agentic tool-loop (NEXT_SESSION_PLAN Phase 2/3).
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
import type { SuccessReceipt, ErrorReceipt } from "../harness/receipts.js";
import type { ModelClient, ModelMessage, ToolCall, ToolCompletion, ToolDefinition } from "./model-client.js";

/** Max model round-trips per turn before we stop and answer truthfully. */
export const DEFAULT_MAX_STEPS = 6;
/** Max tool calls honored from a single model turn (guards pathological output). */
const DEFAULT_MAX_TOOL_CALLS_PER_STEP = 8;
/**
 * Byte budget for ONE tool result fed back to the model. Receipts are unbounded
 * (a PDF export carries base64; a list receipt grows with the workspace; a
 * report can be 200KB) and the live 322-prompt loop stalled the session with
 * 60s+ no-replies once fat receipts hit the transcript. The admin still sees
 * the FULL receipt — only the model-visible copy is pruned.
 */
export const TOOL_RESULT_MAX_BYTES = 24_000;

/** Longest string leaf kept verbatim when a receipt must be pruned. */
const PRUNED_STRING_CHARS = 2_000;
/** Longest array kept when a receipt must be pruned (head sample — ids survive). */
const PRUNED_ARRAY_ITEMS = 25;

function pruneValue(value: unknown): unknown {
  if (typeof value === "string" && value.length > PRUNED_STRING_CHARS) {
    return `${value.slice(0, PRUNED_STRING_CHARS)}…[truncated ${value.length - PRUNED_STRING_CHARS} chars]`;
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, PRUNED_ARRAY_ITEMS).map(pruneValue);
    if (value.length > PRUNED_ARRAY_ITEMS) {
      head.push(`…truncated: ${value.length - PRUNED_ARRAY_ITEMS} more item(s) omitted for the model; ask a narrower query for the rest`);
    }
    return head;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, pruneValue(v)]));
  }
  return value;
}

/**
 * Serialize a receipt for the model, byte-capped. A small receipt passes through
 * byte-identical; an oversized one is pruned (string leaves clipped, arrays cut
 * to a head sample so read-then-act can still pick ids) and, if still over the
 * budget, its `data` is replaced wholesale with an honest note.
 */
export function capToolResultForModel(receipt: SuccessReceipt | ErrorReceipt): string {
  const full = JSON.stringify(receipt);
  if (Buffer.byteLength(full, "utf8") <= TOOL_RESULT_MAX_BYTES) return full;

  const pruned = JSON.stringify({ ...(pruneValue(receipt) as object), truncatedForModel: true });
  if (Buffer.byteLength(pruned, "utf8") <= TOOL_RESULT_MAX_BYTES) return pruned;

  const { data: _data, ...rest } = receipt as unknown as { data?: unknown } & Record<string, unknown>;
  return JSON.stringify({
    ...rest,
    truncatedForModel: true,
    data: {
      note: `result too large to show the model (${Buffer.byteLength(full, "utf8")} bytes); the admin saw the full result — ask a narrower query if you need the details`,
    },
  });
}

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

  for (let step = 0; step < maxSteps; step += 1) {
    // Client gone → stop BEFORE the next (paid) model call.
    if (input.signal?.aborted) return { kind: "aborted", transcript };
    const completion = await input.modelClient.completeWithTools(transcript, input.tools);
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

      // receipt (read or safe write; success or error) → feed back to the model.
      toolResults.push(toolResultTurn(call.id, result.receipt));
    }

    transcript.push(assistantToolCallTurn(completion, honored), ...toolResults);
  }

  return { kind: "exhausted", text: EXHAUSTED_TEXT, transcript };
}
