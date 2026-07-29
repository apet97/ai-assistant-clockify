import { BARE_AFFIRMATIVE, lastTurnCompletedAWrite, TYPED_CONSENT } from "./consent-guard.js";

/**
 * The three deterministic chat guards (whitespace-only → typed-consent → bare
 * affirmative after a completed write), shared by BOTH engines (closure-plan
 * PR 2 / F20). This module owns only the decision and the exact copy; each
 * caller persists the deterministic answer through its own settlement path.
 * The predicates read the store the same way for v1 and v2: pending
 * confirmations by session, and the prior assistant turn's hydrated
 * `payload.results` (action-result links hydrate into results, so a completed
 * v2 write is visible to `lastTurnCompletedAWrite` exactly like a v1 one).
 */

export interface DeterministicGuardStore {
  countPendingConfirmations(sessionId: string, nowIso: string): number;
  getRecentMessages(
    sessionId: string,
    limit: number,
    includePayload?: boolean,
  ): Array<{ role: string; content: string; payload?: unknown }>;
}

export const GUARD_EMPTY_MESSAGE_REPLY =
  "I didn't catch a message there — what would you like me to do?";
export const GUARD_CONSENT_PENDING_REPLY =
  "No action was taken from this message. Use the button on the pending preview, or Cancel to discard it.";
export const GUARD_COMPLETED_WRITE_REPLY =
  "No new action was taken. The previous completed change is recorded above.";
export const GUARD_CONSENT_IDLE_REPLY =
  "No action was taken. State the change you want in one fresh message.";

function priorTurnResults(store: DeterministicGuardStore, sessionId: string): unknown[] {
  const prior = store.getRecentMessages(sessionId, 2, true);
  const lastAssistant = [...prior].reverse().find((msg) => msg.role === "assistant");
  return (lastAssistant?.payload as { results?: unknown[] } | undefined)?.results ?? [];
}

/**
 * Returns the deterministic reply text when a guard fires, or `undefined` to
 * let the turn reach a model. Order and copy are pinned: whitespace →
 * typed-consent (pending / completed / idle) → bare-affirmative-after-write.
 */
export function deterministicGuardReply(
  store: DeterministicGuardStore,
  claims: { sessionId: string },
  message: string,
  nowIso: string,
): string | undefined {
  // A whitespace-only message is no input at all (finding new-6: a blank turn
  // sent the model guessing — it invoked clockify_review_day / clockify_status
  // unsolicited and fabricated a context). Treat it as empty and ask what the
  // admin wants, deterministically — never let it reach the planner.
  if (message.trim().length === 0) return GUARD_EMPTY_MESSAGE_REPLY;

  // SAFETY (live item 157): bare typed consent must never reach the planner —
  // live, "yes" made the model plan a NEW operation instead of pointing at the
  // button. Deterministic reply; only a button nonce can execute a pending
  // change, and without one no action is taken.
  if (TYPED_CONSENT.test(message)) {
    if (store.countPendingConfirmations(claims.sessionId, nowIso) > 0) {
      return GUARD_CONSENT_PENDING_REPLY;
    }
    return lastTurnCompletedAWrite(priorTurnResults(store, claims.sessionId))
      ? GUARD_COMPLETED_WRITE_REPLY
      : GUARD_CONSENT_IDLE_REPLY;
  }

  // SAFETY (finding new-2-affirmative-after-completed-safe): a bare affirmative
  // ("great", "perfect") right after a write ALREADY completed — with nothing
  // pending — must not re-plan another write. The model never sees the
  // affirmative, so it can't duplicate the action.
  if (BARE_AFFIRMATIVE.test(message) &&
    lastTurnCompletedAWrite(priorTurnResults(store, claims.sessionId))) {
    return GUARD_COMPLETED_WRITE_REPLY;
  }

  return undefined;
}
