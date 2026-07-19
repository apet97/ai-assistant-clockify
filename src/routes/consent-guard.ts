/**
 * Typed-consent guard (extracted from api.ts — plan 005 Phase 1). Pure regex
 * vocabulary + one pure predicate, closing over no router or `deps` state. The
 * route uses these to keep a bare "yes"/"confirm" from ever reaching the planner.
 * Typed consent never executes anything; only the button nonce does when a
 * preview is pending.
*/
import { hasChanges } from "../harness/receipts.js";

/**
 * A bare typed consent ("yes", "confirm", "do it", …) OR a consent-adjacent
 * "apply the pending change" imperative ("just do it already", "execute it
 * now", "apply the change", "run it", "please go ahead and apply the pending
 * change"). This must never reach the planner (live
 * item 157: "yes" planned a NEW operation; finding new-5: the narrow whitelist
 * let consent-adjacent phrases through, re-running the risky action and
 * stacking a SECOND duplicate preview) — typed consent never executes anything;
 * only the button nonce does.
 *
 * Built from three anchored, whole-message shapes so anything carrying a NEW
 * instruction falls through to the planner:
 *  - an affirmation word + optional polite/consent filler ("yes", "sure",
 *    "yes please go ahead");
 *  - an apply/execute/run-shaped imperative whose ONLY object is a
 *    self-reference to the pending change ("apply the change", "run it",
 *    "execute it now") — naming a NEW entity ("apply the discount to invoice 5",
 *    "run the report") falls outside the closed object set and is NOT swallowed;
 *  - the two shapes joined ("please go ahead and apply the pending change").
 */
// Whole-message approval words/idioms (no new instruction). "go for it",
// "make it so", "ship it" etc. are pure consent; anything naming a NEW entity
// ("approve the discount on invoice 5") falls outside the closed filler set below.
export const CONSENT_AFFIRMATION =
  "(?:yes|yep|yeah|yup|ok|okay|sure|do it|go ahead|go for it|proceed|approve(?:d)?|apply|make it so|ship it|send it|confirm(?:ed)?)";
// Polite/connective filler that carries no new instruction. "all"/"everything"
// cover batch consent ("confirm all" — a literal UI button label — "approve
// all"); they only match TRAILING (a new noun like "approve all expenses" still
// falls through to the planner).
export const CONSENT_FILLER = "(?:please|just|now|already|then|and|all|everything|go ahead|do it|proceed|for me|that|it)";
// Imperative verb that means "apply the thing you previewed".
export const CONSENT_APPLY_VERB = "(?:apply|execute|run|do|perform|commit|approve|go ahead with|proceed with|confirm)";
// The ONLY allowed object — a self-reference to the pending change, never a new entity.
export const CONSENT_PENDING_OBJECT =
  "(?:it|this|that|them|those|the (?:change|changes|edit|update|action|operation|thing|pending (?:change|changes|edit|update|action|operation)))";
// An apply-verb whose pending-OBJECT is OPTIONAL. Used ONLY as the trailing chain
// (Shape C) after an affirmation already established consent — so a bare
// "yes please confirm" / "yes confirm" / "ok do it" hits the guard. As a STANDALONE
// imperative the object stays mandatory (Shape B) so "run the report" /
// "apply the discount to invoice 5" still fall through to the planner.
export const CONSENT_APPLY_CLAUSE = `${CONSENT_APPLY_VERB}(?:\\s+${CONSENT_PENDING_OBJECT})?`;
export const TYPED_CONSENT = new RegExp(
  "^\\s*" +
    "(?:please\\s+|just\\s+)*" +
    "(?:" +
    // Shape A: affirmation-led, optional polite/consent filler.
    `${CONSENT_AFFIRMATION}(?:[\\s,.!-]+${CONSENT_FILLER})*` +
    "|" +
    // Shape B: apply/execute/run an object that is the pending change.
    `${CONSENT_APPLY_VERB}\\s+${CONSENT_PENDING_OBJECT}(?:[\\s,.!-]+${CONSENT_FILLER})*` +
    ")" +
    // Shape C: optionally chain "… and apply the pending change" (object optional
    // here only, since an affirmation already established consent).
    `(?:[\\s,.!-]+(?:and\\s+|then\\s+)?${CONSENT_APPLY_CLAUSE})*` +
    "\\s*[.!]*\\s*$",
  "i",
);

/**
 * A bare standalone affirmative ("great", "perfect", "sounds good", …) used
 * ONLY by the post-completed-write guard
 * (finding new-2-affirmative-after-completed-safe). It is intentionally broader
 * than TYPED_CONSENT: it includes acknowledgment-only phrases such as "great"
 * that are not typed approval. It remains affirmation-shaped: a leading word
 * optionally followed by
 * polite/consent filler ("please", "go ahead", "proceed", "thanks", …) and
 * nothing else. Anything carrying a NEW instruction falls through to the
 * planner. The guard that uses it also requires a just-finished write, so a
 * broader match here never blocks a legitimate first-turn "yes".
 */
export const BARE_AFFIRMATIVE =
  /^\s*(?:yes|yep|yeah|yup|ok|okay|sure|great|perfect|cool|nice|awesome|sounds good|do it|go ahead|proceed|confirm(?:ed)?|apply)(?:[\s,.!-]+(?:please|thanks|thank you|go ahead|do it|proceed|that|sounds good))*\s*[.!]*\s*$/i;

/**
 * finding new-2-affirmative-after-completed-safe: did the MOST RECENT assistant
 * turn already complete a write? A safe write executes immediately and leaves no
 * pending confirmation, so a broader affirmative not covered by TYPED_CONSENT
 * still cannot re-plan a SECOND identical write (live, that duplicated a time
 * entry). We detect the finished
 * write from the prior assistant turn's persisted results: at least one
 * successful receipt and NO pending preview (a preview is the awaiting-confirm
 * path, handled by the TYPED_CONSENT guard). `results` is the redacted payload
 * persisted by `persistAssistantReply`.
 */
export function lastTurnCompletedAWrite(results: unknown[]): boolean {
  let sawSuccessfulReceipt = false;
  for (const r of results) {
    const item = r as { kind?: string; receipt?: { ok?: boolean; changed?: Parameters<typeof hasChanges>[0] } };
    if (item.kind === "preview") return false;
    if (item.kind === "receipt" && item.receipt?.ok === true && hasChanges(item.receipt.changed)) {
      sawSuccessfulReceipt = true;
    }
  }
  return sawSuccessfulReceipt;
}
