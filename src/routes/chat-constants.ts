/**
 * Chat-turn tuning constants (extracted from api.ts, plan 007).
 *
 * Leaf module so BOTH api.ts (which re-exports them for existing importers) and
 * chat-pipeline.ts can import them without a cycle. Pure values, no behavior.
 */

/**
 * The LLM CONTEXT WINDOW: how many stored chat messages (user + assistant turns,
 * newest first) are sent to the MODEL each turn. The STORED history is complete —
 * this only bounds the model-visible window, so a marathon session (the live loop
 * stored 650 messages in one session) keeps a constant-size prompt. Distinct from
 * the UI restore count (`CHAT_HISTORY_RESTORE_LIMIT`, 50, routes/api.ts). Receipts/
 * payloads are never part of this history; the agent loop separately byte-caps tool
 * results (see TOOL_RESULT_MAX_BYTES).
 */
export const HISTORY_WINDOW_MESSAGES = 12;

/** Idempotency window: re-confirming the same intent within this is deduped. */
export const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000;
