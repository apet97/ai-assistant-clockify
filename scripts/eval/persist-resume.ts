import {
  capAgentState,
  parseAgentState,
  resumeMessages,
  type AgentState,
} from "../../src/assistant/agent-state.js";
import type { ModelMessage } from "../../src/assistant/model-client.js";
import type { ErrorReceipt, SuccessReceipt } from "../../src/harness/receipts.js";

/**
 * The agentic eval's confirm round-trip, routed through the SAME suspension
 * boundary the product uses (routes/api.ts): `capAgentState` drops an oversized
 * state, the state is serialized to JSON and re-read (the `agent_state_json`
 * column write/read), `parseAgentState` validates the stored value against the
 * persistence schema, and only then does `resumeMessages` build the resumed
 * transcript.
 *
 * Routing the eval through here (instead of handing the live in-memory state
 * straight to `resumeMessages`) means any field that survives in memory but is
 * stripped or rejected by the `agent_state_json` schema (a Gemini
 * thoughtSignature, any future contract field) fails the eval BEFORE it ships —
 * the eval's confirm-resume is now the product's confirm-resume.
 *
 * Returns `undefined` when the production boundary would NOT resume (state too
 * large to persist, or rejected by the schema). The eval treats that as an
 * inability to continue the turn, not a silent in-memory resume.
 */
export function persistAndResume(
  state: AgentState,
  receipt: SuccessReceipt | ErrorReceipt,
): ModelMessage[] | undefined {
  const capped = capAgentState(state);
  if (!capped) return undefined;
  // Mirror the DB round-trip: agent_state_json is stored as a JSON string and
  // parsed back before validation — so a value that survives in memory but not
  // through JSON (or the schema) is caught here, exactly as in production.
  const persisted = parseAgentState(JSON.parse(JSON.stringify(capped)) as unknown);
  if (!persisted) return undefined;
  return resumeMessages(persisted, receipt);
}
