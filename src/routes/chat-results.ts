/**
 * Pure chat-result transforms & result-guards (extracted from api.ts, plan 007).
 *
 * One cohesive, PURE unit: how a finished turn's `results[]` stream is mapped to
 * truthful reply text, redacted for storage, and sanitized for history replay.
 * These functions are safety-relevant (the truthful-preview override and the
 * F10 fabricated-completion guard live here) but have NO closure over
 * router/`deps` state — they take explicit args and use only string/array ops
 * plus the leaf helpers below. This module must NOT import from `./api.js`
 * (that would create a cycle); `api.ts` and `chat-pipeline.ts` import FROM here.
 */
import type { ActionContext, ActionResult, ConfirmableOperation, PreviewCard } from "../harness/action.js";
import { hasChanges, type SuccessReceipt, type ErrorReceipt } from "../harness/receipts.js";
import type { AgentStep, AgentTurnResult } from "../assistant/agent-loop.js";
import { capAgentState, type AgentState } from "../assistant/agent-state.js";
import type { ToolCall } from "../assistant/model-client.js";
import type { DurableResultLink } from "../db/store.js";
import {
  pruneHistoryResult,
  previewReplyText,
  failureReplyText,
  partialOutcomeReplyText,
  failedAttemptNote,
  claimsCompletedMutation,
  NO_CHANGE_MADE_REPLY,
} from "./history-sanitizer.js";

/** Session-scoping triple threaded through the turn pipeline. */
export type Claims = { sessionId: string; workspaceId: string; adminUserId: string };

/**
 * Per-turn execution machinery shared by the chat turn AND the confirm-time
 * resume: result collection/streaming plus the audited receipt, clarify, and
 * preview emitters. `emitPreviewFor` is the ONLY way a risky write leaves
 * either path — as a pending confirmation that the button-confirm route alone
 * can commit.
 */
export interface TurnMachinery {
  ctx: ActionContext;
  results: unknown[];
  resultLinks: DurableResultLink[];
  emit: (result: unknown, link: DurableResultLink) => void;
  auditAndEmitReceipt: (actionName: string, receipt: SuccessReceipt | ErrorReceipt, operationId?: string) => void;
  auditAndEmitPartial: (
    actionName: string,
    result: Extract<ActionResult, { kind: "partial" }>,
    operationId?: string,
  ) => void;
  emitPreviewFor: (preview: PreviewCard, operation: ConfirmableOperation, agentState?: AgentState) => void;
  runAction: (call: ToolCall) => Promise<ActionResult>;
  onStep: (step: AgentStep) => void;
}

// ARCH-05: narrow result objects through named guards once, instead of repeated
// inline `(r as { kind?: string }).kind === …` casts in each transform below.
type KindResult = { kind: string };
const hasKind = (r: unknown): r is KindResult =>
  typeof r === "object" && r !== null && "kind" in r;
const isPreviewResult = (r: unknown): r is { kind: "preview" } => hasKind(r) && r.kind === "preview";
const isReceiptResult = (r: unknown): r is { kind: "receipt"; receipt: SuccessReceipt | ErrorReceipt } =>
  hasKind(r) && r.kind === "receipt";
const isClarifyResult = (r: unknown): r is { kind: "clarify"; message?: string } =>
  hasKind(r) && r.kind === "clarify";
const isPartialResult = (r: unknown): r is { kind: "partial"; message?: string } =>
  hasKind(r) && r.kind === "partial";

/** Map a finished agent turn onto the result stream: an interrupt becomes a pending preview. */
export function settleAgentTurn(m: TurnMachinery, turn: AgentTurnResult): { replyKind: string; baseText: string } {
  if (turn.kind === "interrupt") {
    // capAgentState drops (never truncates) an oversized suspension — the
    // confirm still commits, it just won't resume (the pre-agentic behavior).
    m.emitPreviewFor(
      turn.preview,
      turn.operation,
      capAgentState({
        transcript: turn.transcript,
        call: { id: turn.call.id, name: turn.call.name },
      }),
    );
    // The truthful-preview override supplies the reply text for a pending preview.
    return { replyKind: "actions", baseText: "" };
  }
  // The clarify (with its grounded options) is ALREADY emitted as a result via
  // `onStep` before the loop returns, so leave `baseText` empty — echoing the
  // message into reply.text too would render it twice in the UI (the clarify
  // bubble AND the assistant reply bubble). fix-clarify-double-render.
  if (turn.kind === "clarify") return { replyKind: "clarify", baseText: "" };
  if (turn.kind === "partial") return { replyKind: "partial", baseText: "" };
  // The client disconnected mid-turn: no reply is sent (the socket is gone).
  if (turn.kind === "aborted") return { replyKind: "aborted", baseText: "" };
  // "final" and "exhausted" both carry truthful text from the loop.
  return { replyKind: "answer", baseText: turn.text };
}

// SAFETY (SPEC "never claim a risky action is done"): a risky action only
// executes on a button confirmation, never on the model's say-so. The model
// sometimes narrates a false "Done!/Confirmed" for a pending preview, so when
// the turn produced previews we REPLACE the model's text with a truthful,
// not-yet-applied instruction — and store THAT (not the false claim) so the
// model's own history can't convince it the action already happened.
export function truthfulReplyText(results: unknown[], baseText: string, replyKind: string): string {
  const partial = results.find(isPartialResult);
  if (partial) {
    return partial.message?.trim() || "The request stopped part-way through. Review the recorded changes before continuing.";
  }
  const pendingPreviews = results.filter(isPreviewResult).length;
  if (pendingPreviews > 0) {
    // Single source of truth (safety-invariants-02): the stored boilerplate and
    // the sanitizer's PREVIEW_BOILERPLATE both come from `previewReplyText`.
    // finding new-4: the loop can fail a tool call and then recover to THIS
    // preview in the same turn. Acknowledge those failed attempts after the
    // boilerplate (which stays first so PREVIEW_BOILERPLATE still anchors), so
    // the admin understands why a different/pivoted card appeared instead of a
    // wholesale replacement that erases the failure.
    const failedReceipts = results.filter(
      (r) => isReceiptResult(r) && (r as { receipt?: { ok?: boolean } }).receipt?.ok === false,
    ).length;
    return failedReceipts > 0
      ? `${previewReplyText(pendingPreviews)}${failedAttemptNote(failedReceipts)}`
      : previewReplyText(pendingPreviews);
  }
  // truthfulness-02: in the single-turn `actions` path `baseText` is the model's
  // narration written BEFORE any action ran, so an optimistic "Done!/I created…"
  // can survive failed safe writes. Replace that pre-execution claim with a
  // count-accurate line whenever ANY receipt failed — all-failed reports "nothing
  // was changed", a mixed batch reports the succeeded/failed split (else the
  // optimistic "Done!" overclaims a partial batch). The agentic loop's
  // "final"/"answer" text already follows its receipts, so leave it untouched.
  if (replyKind === "actions") {
    const receipts = results.filter(isReceiptResult);
    const failed = receipts.filter((r) => r.receipt.ok === false).length;
    if (receipts.length > 0 && failed > 0) {
      return failed === receipts.length
        ? failureReplyText(failed, receipts.length)
        : partialOutcomeReplyText(receipts.length - failed, receipts.length, failed);
    }
  }
  // truthfulness (F10): a completion claim ("Done! … deleted/created/renamed …")
  // is truthful only if THIS turn actually applied a mutation. A risky write
  // only ever reaches the host through the preview→button-confirm flow, and a
  // safe write leaves a SUCCESS receipt carrying a `changed` set. Live (tour
  // turn 30), the model answered "Done! … has been renamed …" for an unbacked
  // rename — telling the admin a write succeeded that never ran.
  //   The earlier guard checked `results.length === 0`, but a READ pushes a
  // {kind:"receipt"} result carrying `data` (not `changed`), so the common
  // read-then-fabricate shape left `results` non-empty and slipped a false
  // "Done!" through. Gate instead on whether any SUCCESSFUL MUTATION receipt was
  // produced: reads (and failed writes) no longer suppress the guard, while a
  // genuine safe-write completion still narrates normally. The replacement is
  // stored too, so it can't re-enter history as if it had happened.
  const appliedAnyChange = results.some(
    (r) => isReceiptResult(r) && r.receipt.ok === true && hasChanges((r.receipt as SuccessReceipt).changed),
  );
  // A FAILED receipt means the model is (truthfully) reporting an attempt that
  // didn't apply — e.g. "That tool isn't available; nothing was changed." Don't
  // second-guess that honest report (claimsCompletedMutation mis-reads the
  // past-tense "was changed"); only step in when the completion claim is backed
  // by NEITHER a successful mutation NOR a failed action to report — i.e. the
  // turn produced only reads (or nothing), the read-then-fabricate shape.
  const reportedFailure = results.some((r) => isReceiptResult(r) && r.receipt.ok === false);
  if (!appliedAnyChange && !reportedFailure && claimsCompletedMutation(baseText)) {
    return NO_CHANGE_MADE_REPLY;
  }
  return baseText;
}

// The raw one-use confirmation nonce belongs ONLY in the live HTTP
// response / page state (confirmations.ts: "only its hash is stored"). The
// live `results` carry it to the client, but the DURABLE copy in
// chat_messages.payload_json must not — strip it so the nonce is never
// write-only DB residue (nothing re-serves the persisted payload, and the
// model never sees it). Everything else about the preview is kept.
export function redactNonceForStorage(results: unknown[]): unknown[] {
  return results.map((r) => {
    if (isPreviewResult(r) && "nonce" in (r as object)) {
      const { nonce: _nonce, ...rest } = r as { nonce?: unknown };
      return rest;
    }
    return r;
  });
}

/**
 * The content to STORE for an assistant turn. Normally this is `replyText`.
 * But a clarify turn deliberately keeps `reply.text` EMPTY so the UI renders
 * the clarify ONCE (the grounded bubble rides in results[], not a second reply
 * bubble — fix-clarify-double-render). The side effect was a dead-end loop
 * (finding new-7): the model-visible history is built from this stored content,
 * so an empty clarify turn left the model with NO record of having asked. On the
 * next turn a one-word follow-up ("Acme Corp") had nothing to anchor to and the
 * model re-issued the same losing tool call, clarifying forever.
 *
 * Fix: when `replyText` is empty but the turn produced clarify result(s), store
 * the clarify QUESTION(S) as the assistant content. The model then sees what it
 * asked and can resolve the follow-up. The LIVE `reply.text` is untouched (still
 * empty) — only the durable, model-visible copy gains the question. (When a
 * preview is also pending, `replyText` is the non-empty truthful-preview
 * boilerplate, so this never overrides the preview-truthfulness invariant.)
 */
export function storedContentForReply(replyText: string, results: unknown[]): string {
  if (replyText.trim().length > 0) return replyText;
  const clarifyMessages = results
    .filter(isClarifyResult)
    .map((r) => (r.message ?? "").trim())
    .filter((m) => m.length > 0);
  return clarifyMessages.length > 0 ? clarifyMessages.join("\n\n") : replyText;
}

/**
 * Strip results for HISTORY replay: history is a record, not a control
 * surface. Preview-kind results are dropped (settled ones are inert; LIVE
 * ones are re-served in `pendingPreviews` with a freshly rotated nonce) and
 * `undo` handles are removed (one-use live-moment affordances with unknown
 * liveness after a reload).
 */
export function sanitizeResultsForHistory(results: unknown[]): unknown[] {
  return results
    .filter((r) => !isPreviewResult(r))
    .map((r) => {
      if (r && typeof r === "object" && "undo" in (r as object)) {
        const { undo: _undo, ...rest } = r as { undo?: unknown };
        return pruneHistoryResult(rest);
      }
      // Byte-backstop the count cap: a fat read-action receipt's `data` blob is
      // dropped with an honest note so a marathon session doesn't re-ship
      // megabytes on every reload (r2-new-session-restore-06).
      return pruneHistoryResult(r);
    });
}
