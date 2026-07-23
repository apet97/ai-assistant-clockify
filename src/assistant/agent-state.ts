import { z } from "zod";
import type { ErrorReceipt, SuccessReceipt } from "../harness/receipts.js";
import { capToolResultForModel } from "./tool-results.js";
export { capToolResultForModel } from "./tool-results.js";
import type { ModelMessage } from "./model-client.js";

/**
 * The durable suspension of an agentic turn across the risky-write confirm
 * round-trip (Phase 3). When the loop interrupts on a risky preview, the running
 * transcript + the risky tool call are persisted on the pending confirmation
 * (`agent_state_json`); after the button-confirm commits, the committed receipt
 * is appended as that call's tool result and the loop re-enters. The state holds
 * MODEL-VISIBLE data only (prompt, chat turns, receipts) — never tokens/secrets.
 */
export interface AgentState {
  transcript: ModelMessage[];
  /** The risky tool call awaiting its tool result (filled by the commit receipt). */
  call: { id: string; name: string };
  /** Admin-authored request context used for deterministic tool selection. It
   *  survives terse clarification follow-ups and the confirmation round-trip. */
  selectionContext?: string;
  /** Durable operation binding used to reload (never redeclare) the original
   * admin-authored capability before a confirm-time model resume. */
  intentCapability?: {
    operationId: string;
    id: string;
    hash: string;
  };
}

const modelMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  toolCalls: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        arguments: z.record(z.string(), z.unknown()),
        // Gemini 3.x requires extra_content.google.thought_signature echoed back
        // verbatim on the continuation — same contract class as reasoningContent.
        // Stripping it here silently 400s every risky-write resume on a Gemini backend.
        thoughtSignature: z.string().min(1).optional(),
      }),
    )
    .optional(),
  toolCallId: z.string().optional(),
  // Thinking-mode reasoning must survive the suspension round-trip — the
  // provider requires it back verbatim on resume (rejecting it here would
  // silently disable resume for any turn the model "thought" on).
  reasoningContent: z.string().optional(),
});

const agentStateSchema = z.object({
  transcript: z.array(modelMessageSchema).min(1),
  call: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  selectionContext: z.string().min(1).max(8_000).optional(),
  intentCapability: z.object({
    operationId: z.string().min(1),
    id: z.string().min(1),
    hash: z.string().length(64),
  }).optional(),
});

/**
 * Validate a stored `agent_state_json` value. Legacy rows (no state) and any
 * malformed/foreign value yield undefined — the confirm then behaves exactly as
 * before Phase 3 (commit the receipt, no resume).
 */
export function parseAgentState(value: unknown): AgentState | undefined {
  const parsed = agentStateSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Ceiling on the persisted suspension. Chained resumes accumulate the
 * transcript in `agent_state_json`, and nothing else bounds it — a runaway
 * model emitting huge tool args could grow rows without limit (a DoS class,
 * not a security gap). Roomy: a heavy turn with several receipts is tens of KB.
 */
const MAX_AGENT_STATE_BYTES = 256 * 1024;

/**
 * Drop (never truncate) a state too large to persist: removing messages would
 * corrupt the tool-call pairing the provider validates, while dropping the
 * whole state falls back to the established no-resume confirm path.
 */
export function capAgentState(state: AgentState): AgentState | undefined {
  return Buffer.byteLength(JSON.stringify(state), "utf8") <= MAX_AGENT_STATE_BYTES ? state : undefined;
}

/**
 * The resumed transcript: the suspension plus the committed receipt as the risky
 * call's tool result. The committed receipt is a tool result entering the same
 * agent loop, so it obeys the SAME per-tool-result byte cap as in-loop results
 * (`capToolResultForModel`) — a fat commit receipt (bulk ops, compose, a
 * many-item invoice doc) is pruned with the honest truncation marker rather than
 * blowing the provider request budget and silently dropping the resume. The
 * admin still sees the full receipt; only the model-visible copy is capped.
 */
export function resumeMessages(state: AgentState, receipt: SuccessReceipt | ErrorReceipt): ModelMessage[] {
  return [...state.transcript, { role: "tool", toolCallId: state.call.id, content: capToolResultForModel(receipt) }];
}
