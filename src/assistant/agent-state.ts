import { z } from "zod";
import type { ErrorReceipt, SuccessReceipt } from "../harness/receipts.js";
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
}

const modelMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  toolCalls: z
    .array(z.object({ id: z.string().min(1), name: z.string().min(1), arguments: z.record(z.string(), z.unknown()) }))
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

/** The resumed transcript: the suspension plus the committed receipt as the risky call's tool result. */
export function resumeMessages(state: AgentState, receipt: SuccessReceipt | ErrorReceipt): ModelMessage[] {
  return [...state.transcript, { role: "tool", toolCallId: state.call.id, content: JSON.stringify(receipt) }];
}
