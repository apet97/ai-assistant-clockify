/**
 * Dependency-free shared UI primitives (types + the pure `featureGroupRows`
 * helper) used by BOTH `main.ts` and `render.ts`. This is a leaf module so
 * `render.ts` can use them WITHOUT importing from `main.ts` (which imports
 * render's DOM builders) — that back-edge would be a circular dependency.
 * `main.ts` re-exports these, so the public/test import surface (e.g.
 * `import { featureGroupRows } from "./main.js"`) is unchanged.
 */

export interface PreviewRef {
  previewId: string;
  nonce: string;
}

export interface PolicyShape {
  version: number;
  groups: Record<string, string>;
}

export interface ChatController {
  send(message: string): Promise<unknown>;
  confirm(ref: PreviewRef): Promise<unknown>;
  /** Streaming single confirm: the committed receipt arrives first, then the resume streams. */
  confirmStream(ref: PreviewRef, onEvent: (event: StreamEvent) => void): Promise<void>;
  confirmAll(refs: PreviewRef[]): Promise<unknown[]>;
  cancel(previewId: string): Promise<unknown>;
  undo(id: string): Promise<unknown>;
  savePermissions(groups: Record<string, string>): Promise<unknown>;
  getPermissions(): Promise<unknown>;
}

export function featureGroupRows(policy: PolicyShape): Array<{ group: string; level: string }> {
  return Object.entries(policy.groups).map(([group, level]) => ({ group, level }));
}

export interface PreviewResult {
  kind: "preview";
  previewId: string;
  nonce: string;
  /** ISO expiry of the one-use nonce (advisory for the UI; the server enforces). */
  expiresAt?: string;
  preview: {
    actionLabel: string;
    expectedChanges: string[];
    reversibility: string;
    warnings: string[];
    featureGroup?: string;
    riskLabels?: string[];
    targets?: Array<{ type: string; id: string; name?: string }>;
  };
}

export interface ReceiptResult {
  kind: "receipt";
  receipt: { ok: boolean; action: string; message?: string; changed?: unknown; warnings?: Array<{ code?: string; message: string }> };
  /** Present when the action can be reversed (a one-use undo handle). */
  undo?: { id: string };
}

export interface ClarifyResult {
  kind: "clarify";
  message: string;
  options?: Array<{ id: string; label: string }>;
}

export type ChatResult = PreviewResult | ReceiptResult | ClarifyResult;

/** One response from POST /confirmations/:id/confirm — possibly carrying a resumed agentic turn. */
export interface ConfirmResponse {
  ok: boolean;
  code?: string;
  message?: string;
  receipt?: { ok: boolean; action: string; message?: string };
  resume?: { reply: { kind: string; text: string }; results: ChatResult[] };
}

export interface ConfirmHooks {
  onAssistant(text: string): void;
  onResults(results: ChatResult[]): void;
  onError(message: string): void;
  /** Latest progress label ("Starting the timer") — purely cosmetic, optional. */
  onStatus?(label: string): void;
  /**
   * The nonce this tab held was rotated out from under it — another restored tab
   * (or a session-history fetch) re-armed the SAME live pending with a fresh
   * one-use nonce, so this confirm 400s with code 'invalid_confirmation' even
   * though the preview is STILL pending. This is a re-armable retry, not a dead
   * end: the caller should re-fetch the live pending and re-render its card.
   * Falls back to `onError` when not supplied (existing callers are unchanged).
   */
  onStale?(message: string): void;
}

/**
 * The confirm route returns this code (`commitConfirmation` → `confirmPending`)
 * when the supplied nonce doesn't match a still-pending preview — the
 * cross-tab nonce-rotation race (r1-concurrency-races-02), distinct from an
 * expired/already-used/policy-denied confirm.
 */
export const STALE_NONCE_CODE = "invalid_confirmation";

/** One event from a streaming chat OR confirm endpoint (NDJSON, one per line). */
export interface StreamEvent {
  type: "result" | "reply" | "error" | "done" | "receipt" | "status" | string;
  result?: ChatResult;
  /** Only on a confirm stream's first `receipt` event: the committed receipt + undo handle. */
  receipt?: ReceiptResult["receipt"];
  undo?: { id: string };
  kind?: string;
  text?: string;
  code?: string;
  message?: string;
  /** Only on `status` events: the executing action + its human label. */
  action?: string;
  label?: string;
}

export interface ConfirmStreamApi {
  confirmStream(ref: PreviewRef, onEvent: (event: StreamEvent) => void): Promise<void>;
}

/**
 * Settle a STREAMED single confirm. The committed receipt arrives FIRST and is
 * rendered immediately, so the Confirm button never feels dead while a multi-step
 * resume runs (and the live stream keeps the connection alive, so a slow resume
 * can't surface as a "Confirmation failed" timeout). Resume receipts/clarifies
 * render as they arrive; a chained preview is buffered and flushed at the reply so
 * its single Confirm card stays intact. Never falls back to the generic "Confirmed."
 */
export async function submitConfirmStream(api: ConfirmStreamApi, ref: PreviewRef, hooks: ConfirmHooks): Promise<void> {
  const pendingPreviews: ChatResult[] = [];
  const flush = (): void => {
    if (pendingPreviews.length > 0) hooks.onResults(pendingPreviews.splice(0));
  };
  try {
    await api.confirmStream(ref, (event) => {
      if (event.type === "receipt" && event.receipt) {
        hooks.onResults([{ kind: "receipt", receipt: event.receipt, ...(event.undo ? { undo: event.undo } : {}) } as ReceiptResult]);
      } else if (event.type === "result" && event.result) {
        if (event.result.kind === "preview") pendingPreviews.push(event.result);
        else hooks.onResults([event.result]);
      } else if (event.type === "reply") {
        flush();
        if (event.text) hooks.onAssistant(event.text);
      } else if (event.type === "error") {
        const message = typeof event.message === "string" ? event.message : "The follow-up couldn't complete.";
        // A stale-nonce 400 (another tab rotated this preview's nonce) is a
        // RE-ARMABLE retry — route it to onStale so this tab can re-fetch + re-
        // render the still-live card, never a dead-end error. The preview is NOT
        // burned on this path (api.ts returns JSON BEFORE any commit), so the
        // freshly re-served nonce will validate.
        if (event.code === STALE_NONCE_CODE && hooks.onStale) hooks.onStale(message);
        else hooks.onError(message);
      } else if (event.type === "status") {
        if (typeof event.label === "string") hooks.onStatus?.(event.label);
      }
    });
  } catch {
    hooks.onError("Confirmation failed.");
  } finally {
    flush();
  }
}

/**
 * The "live" affordances a confirm-resume drives, injected by `mount` so the
 * (untested) DOM glue stays thin. Symmetric with the chat path's `ComposerHooks`
 * `onWorking`/`onStatus`: a confirmed risky write's durable resume can run
 * 30-120s, so the UI must show the working/typing affordance and announce the
 * per-step progress labels the loop streams — not run invisibly
 * (r1-ux-copy-a11y-03). `removeCard` retires the preview card exactly once, on
 * the FIRST real (non-stale) outcome — a stale-nonce 400 must keep the card so
 * `onStale` can re-arm it in place.
 */
export interface ConfirmStreamLive {
  onWorking(working: boolean): void;
  onStatus(label: string): void;
  removeCard(): void;
}

/**
 * Run a streamed single confirm WITH the working affordance (r1-ux-copy-a11y-03).
 * Mirrors the chat path's `submitStreaming`: `onWorking(true)` fires BEFORE the
 * stream (the typing bubble + "Assistant is working…" announcement) and is
 * ALWAYS cleared after (even on error/throw, via finally). Per-step `status`
 * labels the durable resume streams drive `onStatus` (previously dropped because
 * the confirm hooks carried no `onStatus`). The preview card is removed once, on
 * the first real outcome (receipt/result/reply/error), but NOT on a stale-nonce
 * re-arm — that keeps the card so `onStale` can re-render it in place.
 *
 * The base `hooks` keep their existing roles (render results / append the reply /
 * surface errors / re-arm on stale); this only ADDS the live affordances around
 * them, so the truthful-preview + stale-nonce contracts are unchanged.
 */
export async function runConfirmStreamLive(
  api: ConfirmStreamApi,
  ref: PreviewRef,
  hooks: ConfirmHooks,
  live: ConfirmStreamLive,
): Promise<void> {
  let removed = false;
  const removeOnce = (): void => {
    if (!removed) {
      removed = true;
      live.removeCard();
    }
  };
  const wrapped: ConfirmHooks = {
    onAssistant: (text) => { removeOnce(); hooks.onAssistant(text); },
    onResults: (results) => { removeOnce(); hooks.onResults(results); },
    onError: (message) => { removeOnce(); hooks.onError(message); },
    onStatus: (label) => live.onStatus(label),
    // A stale-nonce 400 keeps the card (no removeOnce) so the caller can re-arm
    // it in place; fall back to onError when the caller supplied no onStale.
    onStale: (message) => { if (hooks.onStale) hooks.onStale(message); else { removeOnce(); hooks.onError(message); } },
  };
  live.onWorking(true);
  try {
    await submitConfirmStream(api, ref, wrapped);
  } finally {
    live.onWorking(false);
  }
}

/**
 * Settle confirm responses TRUTHFULLY (Phase 4). A failed confirm surfaces the
 * server's message — never "Confirmed."; a committed preview whose agentic turn
 * RESUMED renders the loop's follow-up results (receipts, even a chained
 * preview with its own Confirm button) and the loop's truthful reply instead of
 * the generic message. Returns how many previews actually committed.
 */
export function settleConfirmOutcome(responses: ConfirmResponse[], hooks: ConfirmHooks): number {
  let committed = 0;
  let resumed = false;
  for (const response of responses) {
    if (!response?.ok) {
      // A failed COMMIT carries its reason on `receipt.message` (the route adds no
      // top-level `message` for it); pre-commit rejections carry a top-level one.
      const reason =
        typeof response?.message === "string"
          ? response.message
          : typeof response?.receipt?.message === "string"
            ? response.receipt.message
            : "Confirmation failed.";
      hooks.onError(reason);
      continue;
    }
    committed += 1;
    if (response.resume) {
      resumed = true;
      hooks.onResults(response.resume.results ?? []);
      if (response.resume.reply?.text) hooks.onAssistant(response.resume.reply.text);
    }
  }
  if (committed > 0 && !resumed) {
    hooks.onAssistant(
      committed === responses.length
        ? responses.length > 1
          ? "Batch confirmed."
          : "Confirmed."
        : `Confirmed ${committed} of ${responses.length} — the rest failed.`,
    );
  }
  return committed;
}

/**
 * The honest failure reason from an /api/undo response — the route's own copy
 * (top-level `message` for policy denials / not-found, `receipt.message` for a
 * failed reversal), never a generic "Undo failed." that throws the reason away.
 * Mirrors settleConfirmOutcome's extraction order.
 */
export function undoFailureMessage(
  res: { ok?: boolean; message?: string; receipt?: { message?: string } } | null | undefined,
): string {
  if (res && typeof res.message === "string") return res.message;
  if (res && typeof res.receipt?.message === "string") return res.receipt.message;
  return "Couldn't undo — please try again.";
}

/**
 * The truthful outcome of a cancel click. POST /confirmations/:id/cancel returns
 * `{ ok:false, code, message }` (NOT a throw — `json()` only throws on 401) when
 * the preview is no longer pending: a 409 because another tab CONFIRMED or
 * cancelled it (the risky change may already have COMMITTED), a 403 wrong-session,
 * or a 404 not-found. Those bodies must NOT be read as a successful cancel — the
 * card stays and the admin sees the server's verbatim reason, never a false
 * "Cancelled." (r1-ux-copy-a11y-01). Only when EVERY response is `ok:true` does
 * the card retire and "Cancelled." appear.
 */
export function cancelOutcome(
  responses: Array<{ ok?: boolean; code?: string; message?: string } | null | undefined>,
): { ok: true } | { ok: false; error: string } {
  for (const response of responses) {
    if (response?.ok === true) continue;
    const error = typeof response?.message === "string" ? response.message : "Couldn't cancel — it may have already been confirmed.";
    return { ok: false, error };
  }
  return { ok: true };
}

// --- Session restore (GET /api/chat/history) --------------------------------

export interface HistoryMessage {
  role: string;
  content: string;
  results?: ChatResult[];
}

export interface HistoryResponse {
  ok?: boolean;
  messages?: HistoryMessage[];
  pendingPreviews?: PreviewResult[];
}

export type RestoreItem =
  | { kind: "bubble"; role: "user" | "assistant"; text: string }
  | { kind: "results"; results: ChatResult[] };

/**
 * Flatten a history response into renderable restore items: a bubble per
 * non-empty message content, a results item per non-empty results list, and
 * the LIVE pending previews LAST (the actionable card belongs at the bottom).
 * Defensive even against an older server: preview-kind results and `undo`
 * handles inside stored messages are dropped here too — history is a record,
 * not a control surface; live previews arrive only via `pendingPreviews`.
 *
 * Each live pending is its OWN results item (server returns them created-at
 * ASC, so order is preserved) — NEVER one merged batch. A merged item would
 * render as a single "Confirm all" card spanning unrelated turns, violating
 * "Confirm all applies only to the exact previewed batch" AND routing agentic
 * pendings through the JSON confirmAll path (the streaming single-confirm path
 * resumes the suspended loop; confirmAll is single-turn only) — r1-new-session-
 * restore-02.
 */
export function historyRestoreItems(history: HistoryResponse | null | undefined): RestoreItem[] {
  const items: RestoreItem[] = [];
  // Shape-safe against an undefined/malformed response: a fresh load or a
  // transient non-OK GET resolves to `undefined` (json() only throws on 401),
  // and a missing `messages`/`pendingPreviews` must coerce to [] — never throw
  // (which would surface as an alarming red restore alert; plan 006).
  const safe = history ?? {};
  for (const message of safe.messages ?? []) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (message.content.trim().length > 0) {
      items.push({ kind: "bubble", role: message.role, text: message.content });
    }
    const results = (message.results ?? [])
      .filter((r) => r.kind !== "preview")
      .map((r) => {
        if (r.kind === "receipt" && "undo" in r) {
          const { undo: _undo, ...rest } = r;
          return rest as ChatResult;
        }
        return r;
      });
    if (results.length > 0) items.push({ kind: "results", results });
  }
  for (const pending of safe.pendingPreviews ?? []) {
    items.push({ kind: "results", results: [pending] });
  }
  return items;
}

/**
 * The re-served LIVE pending for `previewId` from a fresh GET /api/chat/history
 * — its nonce has been rotated, so it RE-ARMS the stale tab. Returns `undefined`
 * when the preview is no longer pending in the response (another tab confirmed
 * or cancelled it, or it expired): the stale card should then simply retire, not
 * re-render a card that would 404/already-used on its next Confirm.
 * Used by the onStale re-arm path (r1-concurrency-races-02).
 */
export function reservedPendingFor(history: HistoryResponse, previewId: string): PreviewResult | undefined {
  return (history.pendingPreviews ?? []).find((p) => p.previewId === previewId);
}

/**
 * A one-shot "restore is in flight" gate (r1-new-session-restore-04). The
 * composer goes live the moment `renderChat()` runs, but `restoreHistory()`
 * then awaits a same-origin GET before appending the replayed conversation. On
 * a slow round-trip (cold dyno) a message typed in that window would otherwise
 * append its live turn ABOVE the history that lands later — a scrambled
 * transcript in the one feature whose whole point is a faithful replay.
 *
 * A live send `await`s `waitUntilSettled()` before touching the log, and
 * `restoreHistory` calls `settle()` AFTER appending its items (in BOTH its
 * success and catch paths — restore is best-effort, so a failure must still
 * release the gate or the composer would wedge forever). `settle()` is
 * idempotent; a send started after settle resolves immediately.
 */
export interface RestoreGate {
  /** Resolves once restore has settled (resolved or rejected). */
  waitUntilSettled(): Promise<void>;
  /** Open the gate — idempotent; releases any pending `waitUntilSettled`. */
  settle(): void;
}

export function createRestoreGate(): RestoreGate {
  let release!: () => void;
  let settled = false;
  const settledPromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    waitUntilSettled: () => settledPromise,
    settle: () => {
      if (settled) return;
      settled = true;
      release();
    },
  };
}

/**
 * Remove a focused card AND return focus in lock-step (WCAG 2.4.3 Focus Order,
 * r1-ux-copy-a11y-04). When a Confirm/Cancel button is clicked, keyboard focus
 * sits on that button INSIDE the card. `card.remove()` would drop focus to
 * `document.body`, so the next Tab restarts from the page top — disorienting for
 * keyboard and AT users mid-conversation. This pairs the removal with a
 * `returnFocus` callback (mount points it at the composer input, mirroring the
 * post-turn `input.focus()` on main.ts's chat path) so focus always lands on a
 * stable, logical location. `returnFocus` runs AFTER the removal so the focus
 * target is settled by the time it fires; a throwing `returnFocus` never blocks
 * the removal (best-effort focus, the card is gone regardless).
 */
export function removeCardReturningFocus(remove: () => void, returnFocus: () => void): void {
  remove();
  try {
    returnFocus();
  } catch {
    /* focus return is best-effort — the card is already gone */
  }
}
