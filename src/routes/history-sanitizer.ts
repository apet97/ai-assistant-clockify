/**
 * History-sanitizer & truthful-preview text helpers (extracted from api.ts).
 *
 * One cohesive, PURE unit: how chat history is sanitized for the model and the
 * deterministic truthful-preview reply text. These functions are safety-relevant
 * (they decide what is rewritten/dropped from the model-visible chat history —
 * pinned by "safety-invariants-02") and have no closure over router/`deps` state;
 * they use only `Buffer`/`RegExp`/string ops. This module must NOT import from
 * `./api.js` (that would create a cycle).
 */

/**
 * Per-replayed-result byte budget for GET /api/chat/history. The 50-message
 * COUNT cap (CHAT_HISTORY_RESTORE_LIMIT) bounds how MANY turns replay, not how big each
 * one is — a read-action receipt carries its entire `data` blob (a summary
 * report or a 1000-row list), so 50 fat reads still ship megabytes on every
 * iframe reload (r2-new-session-restore-06). This backstops the count cap by
 * BYTES: a replayed receipt over budget has its bulky read `data` dropped with
 * an honest note (mirroring capToolResultForModel's model-side cap), keeping the
 * human record (status/changed/warnings). The admin already consumed the data
 * live — restore re-anchors the conversation, not the payload.
 */
export const HISTORY_RESULT_MAX_BYTES = 24_000;

/**
 * Backstop one replayed history result by BYTES. Non-receipts and small receipts
 * pass through byte-identical; an over-budget receipt has its read `data` blob
 * replaced wholesale with an honest note (the data was admin-visible live and is
 * a record, not a control surface). Mutation receipts (no `data`, just `changed`)
 * and error receipts are typically small and pass through; if one is still over
 * budget without a `data` field it is left as-is (nothing safe to drop).
 */
export function pruneHistoryResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const item = result as { kind?: string; receipt?: unknown };
  if (item.kind !== "receipt" || !item.receipt || typeof item.receipt !== "object") return result;
  const full = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (full <= HISTORY_RESULT_MAX_BYTES) return result;
  const receipt = item.receipt as { data?: unknown } & Record<string, unknown>;
  if (!("data" in receipt)) return result; // nothing bulky to drop
  const { data: _data, ...rest } = receipt;
  return {
    ...item,
    receipt: {
      ...rest,
      data: {
        note: `result too large to replay on reload (${full} bytes); you saw the full result when it ran — re-run the query if you need the details again`,
      },
    },
  };
}

/**
 * The deterministic truthful-preview reply this route STORES for a turn that
 * leaves `count` pending previews. A session saturated with them taught the
 * model to parrot the boilerplate as its own answer with zero tool calls
 * (live item 318) — so the model-visible history rewrites them into a neutral
 * factual note (`sanitizeStoredReplyForModel`). The stored history (what the
 * admin saw) is never changed.
 *
 * SINGLE SOURCE OF TRUTH (safety-invariants-02): this builder is the ONE place
 * the boilerplate text lives. `truthfulReplyText` produces it and
 * `PREVIEW_BOILERPLATE` is DERIVED from it — so any reword stays sanitized
 * automatically, with no second literal to keep in sync.
 */
export function previewReplyText(count: number): string {
  const lead =
    count > 1
      ? `I've prepared ${count} changes — review them below and click "Confirm all" to apply.`
      : `Review the change below and click "Confirm" to apply it.`;
  return `${lead} Nothing has been changed yet.`;
}

/**
 * Deterministic honest text when a single-turn `actions` turn produced failed
 * receipts and no pending preview (truthfulness-02). The model narrates the
 * outcome BEFORE the action runs, so a "Done!/I created…" claim can survive a
 * failed safe write — mirror the truthful-preview override and replace that
 * pre-execution claim with the actual failure count. The full receipt card with
 * the error code/recovery hint is always shown alongside this text.
 */
export function failureReplyText(failed: number, total: number): string {
  const subject = failed === 1 ? "action" : "actions";
  return `${failed} of ${total} ${subject} failed and nothing was changed — see the receipt below for the reason.`;
}

/**
 * Deterministic honest note for a turn that left a pending preview AFTER one or
 * more failed tool calls (finding new-4-failed-tool-call-receipt-silently-hidden).
 * The agentic loop can attempt a tool call that fails (e.g. invalid_args) and then
 * recover with a DIFFERENT, successful preview in the same turn — but the
 * truthful-preview override replaced reply.text wholesale, erasing every trace of
 * the failed attempt. The admin then saw a Confirm card for a pivoted action with
 * no explanation. This sentence is APPENDED after the preview boilerplate so the
 * failed attempt is acknowledged on the conversational surface (the failed
 * receipts also ride in results[]). The boilerplate stays FIRST so the leading
 * `^`-anchored PREVIEW_BOILERPLATE still matches and the model-visible sanitizer
 * still rewrites the whole reply to its neutral note (no live-318 parrot leak).
 */
export function failedAttemptNote(failed: number): string {
  const subject = failed === 1 ? "attempt" : "attempts";
  return ` (${failed} earlier ${subject} failed — see the receipts below.)`;
}

/**
 * Past-tense / passive completion of a write verb. The vocabulary covers the
 * mutations the harness can perform (rename/delete/create/update/add/remove/
 * archive/log/start/stop/assign/grant/revoke/schedule/submit/approve/deny …),
 * each in its committed form. Built from a closed verb set so a bare future or
 * conditional ("I can rename", "should I delete") never matches.
 */
const COMPLETED_WRITE_VERB =
  "(?:renamed|deleted|removed|created|added|updated|changed|modified|edited|archived|unarchived|logged|started|stopped|set|assigned|unassigned|granted|revoked|scheduled|unscheduled|submitted|resubmitted|approved|denied|cancelled|canceled|applied|moved|merged|saved|recorded|imported|exported|generated|sent|marked|completed|reverted|restored|enabled|disabled)";

/**
 * A claim that a mutation has ALREADY happened. Two anchored shapes:
 *  - a "Done"/"Successfully"/"All set"-style completion lead, or
 *  - a past-tense / passive framing of a write verb ("has been renamed",
 *    "was deleted", "I've created", "I created", "successfully updated").
 * Future / conditional framing ("I can rename", "would you like me to delete",
 * "I'll create", "should I update") is deliberately NOT matched — those verbs
 * carry no completion auxiliary.
 *
 * truthfulness (F10): used ONLY when a turn produced ZERO results (no receipt,
 * no preview, no clarify) — i.e. the model ran no tool calls, so nothing could
 * possibly have changed. A risky write reaches the host only via the
 * preview→button-confirm flow; a plain-answer turn that ran no action can never
 * have mutated anything, so such a "Done!/renamed" claim is always fabricated.
 */
const COMPLETED_MUTATION_CLAIM = new RegExp(
  "(?:" +
    // A "Done"/"All set"-style completion OPENER (anchored to the reply start so a
    // stray "done" mid-sentence — e.g. a tag literally NAMED "done" — never trips it).
    "^\\s*(?:done|all set|all done)\\b" +
    "|" +
    // "successfully <verb-ed>" — the adverb is a completion marker on the verb.
    `\\bsuccessfully\\s+(?:just\\s+|now\\s+)*${COMPLETED_WRITE_VERB}\\b` +
    "|" +
    // Passive completion: "has/have/had/was/were/been/is now/are now … <verb-ed>".
    `\\b(?:has|have|had|was|were|been|is now|are now)\\b[^.!?\\n]{0,40}?\\b${COMPLETED_WRITE_VERB}\\b` +
    "|" +
    // First-person completion: "I('ve)/we('ve) (just/now/successfully) <verb-ed>".
    `\\b(?:i|i've|i have|we|we've|we have)\\b\\s+(?:just\\s+|now\\s+|successfully\\s+)*${COMPLETED_WRITE_VERB}\\b` +
    ")",
  "i",
);

/**
 * Does this plain-answer text assert a completed mutation? See
 * COMPLETED_MUTATION_CLAIM. The caller gates this on a turn that produced no
 * results, so a `true` here means the model fabricated a success claim with no
 * backing action.
 */
export function claimsCompletedMutation(text: string): boolean {
  return COMPLETED_MUTATION_CLAIM.test(text);
}

/**
 * Deterministic, neutral reply for a turn that produced NO actions yet whose
 * model text claimed a completed mutation (truthfulness F10). It replaces the
 * fabricated "Done!/renamed" claim — and is stored as the turn's assistant
 * content — so the false success can never reach the admin OR re-enter the
 * model-visible history as if it had happened.
 */
export const NO_CHANGE_MADE_REPLY =
  "I didn't actually make any changes there — nothing ran. Could you tell me again exactly what you'd like me to do?";

/** Escape a literal string for safe embedding in a RegExp source. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches the leading boilerplate of any reply `previewReplyText` can emit.
 * Built FROM the builder (not a second hand-written literal): the singular form
 * verbatim, plus the plural form with its concrete count turned into `\d+`. If
 * the builder's wording changes, this regex changes with it — the linkage is
 * pinned end-to-end by an integration test (the real produce-then-sanitize round
 * trip in tests/integration/agentic-chat.test.ts).
 */
const PREVIEW_BOILERPLATE = (() => {
  const singular = escapeRegExp(previewReplyText(1));
  // Build the plural form around a sentinel count so escaping can't collide with
  // a real digit; then swap the (escaped) sentinel for a digit class.
  const COUNT_SENTINEL = "__COUNT_SENTINEL__";
  const pluralSource = previewReplyText(2).replace("2", COUNT_SENTINEL);
  const plural = escapeRegExp(pluralSource).replace(escapeRegExp(COUNT_SENTINEL), "\\d+");
  return new RegExp(`^(${singular}|${plural})`);
})();

export function sanitizeStoredReplyForModel(content: string): string {
  if (!PREVIEW_BOILERPLATE.test(content)) return content;
  return "[I prepared a pending change here; it awaited the admin's button confirmation and had not been applied at that point.]";
}

/**
 * A transient model/transport failure is persisted as a role=assistant row with
 * `payload.kind === "error"` (see `modelUnavailable`) only so the turn isn't lost
 * mid-session — but it is an OUT-OF-BAND notice the admin already saw live (the
 * 502 the client surfaced), NOT a genuine assistant reply
 * (finding r2-new-session-restore-05). It must be dropped from BOTH:
 *  - the model window (re-feeding the model its own "I'm unavailable" turn can
 *    degrade subsequent planning — the model "remembers" claiming unavailability);
 *  - the GET /chat/history restore replay (else every iframe reload resurrects a
 *    stale "temporarily unavailable" bubble against an already-answered question).
 * Identifying it by payload kind keeps the check robust to any reword of the text.
 */
export function isTransientErrorMessage(message: { payload?: unknown }): boolean {
  const payload = message.payload;
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { kind?: unknown }).kind === "error"
  );
}
