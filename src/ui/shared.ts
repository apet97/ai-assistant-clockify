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
  confirm(ref: PreviewRef): Promise<ConfirmResponse>;
  /** Streaming single confirm: a clean receipt or truthful partial arrives first. */
  confirmStream(ref: PreviewRef, onEvent: (event: StreamEvent) => void): Promise<void>;
  confirmAll(refs: PreviewRef[]): Promise<ConfirmResponse[]>;
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

export interface PartialResult {
  kind: "partial";
  receipt: ReceiptResult["receipt"];
  message: string;
  options?: ClarifyResult["options"];
  recovery: { hint: string; retryable?: boolean };
  undo?: { id: string };
}

export type ChatResult = PreviewResult | ReceiptResult | PartialResult | ClarifyResult;

/** One response from POST /confirmations/:id/confirm — possibly carrying a resumed agentic turn. */
export interface ConfirmResponse {
  ok: boolean;
  code?: string;
  message?: string;
  receipt?: { ok: boolean; action: string; message?: string };
  /** A truthfully partial confirmed commit; never flatten to receipt success. */
  result?: PartialResult;
  /** Undo handle returned beside a JSON partial/receipt response. */
  undo?: { id: string };
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
  /** Only on a clean confirm stream's first `receipt` event. Partials use `result`. */
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
 * The hook surface a streamed turn dispatches into. Both `ComposerHooks` (chat
 * stream) and `ConfirmHooks` (confirm-resume stream) are structurally assignable
 * to it — `onStale` is optional, so the chat path (which has none) just falls
 * through to `onError`, byte-identical to its old inline handler.
 */
export interface StreamDispatchHooks {
  onAssistant(text: string): void;
  onResults(results: ChatResult[]): void;
  onError(message: string): void;
  onStatus?(label: string): void;
  onStale?(message: string): void;
}

/**
 * A small buffer that holds streamed PREVIEW results until the reply (or the end
 * of the stream) so a batch keeps its single "Confirm all" card. Receipts and
 * clarifies render as they arrive; previews accumulate here and flush together —
 * the flush-at-reply + flush-in-finally invariant both the chat stream and the
 * confirm-resume stream depend on (pinned by ui-streaming + ui-confirm).
 */
export class PreviewBuffer {
  private readonly pending: ChatResult[] = [];
  constructor(private readonly onResults: (results: ChatResult[]) => void) {}
  push(result: ChatResult): void {
    this.pending.push(result);
  }
  /** Emit the buffered previews as ONE batch (no-op when empty). */
  flush(): void {
    if (this.pending.length > 0) this.onResults(this.pending.splice(0));
  }
}

/**
 * Dispatch ONE streamed NDJSON event into the hook surface, buffering previews so
 * a batch keeps its single Confirm-all card. Shared by the chat stream
 * (`submitStreaming`) and the confirm-resume stream (`submitConfirmStream`); the
 * latter handles a leading clean `receipt` itself, while a partial commit arrives
 * here as one truthful `result` event (including its undo handle).
 *
 * Truth contract preserved: `result`/`preview` → buffer; other `result` kinds →
 * `onResults`; `reply` → flush the buffer THEN append the (truthful) reply text;
 * `error` routes a stale-nonce 400 to `onStale` when present (re-armable retry,
 * the preview was NOT burned) else `onError` with the caller's fallback; `status`
 * drives the optional label hook; unknown types are ignored.
 */
export function dispatchStreamEvent(
  event: StreamEvent,
  hooks: StreamDispatchHooks,
  buffer: PreviewBuffer,
  errorFallback: string,
): void {
  if (event.type === "result" && event.result) {
    if (event.result.kind === "preview") buffer.push(event.result);
    else hooks.onResults([event.result]);
  } else if (event.type === "reply") {
    buffer.flush();
    if (event.text) hooks.onAssistant(event.text);
  } else if (event.type === "error") {
    const message = typeof event.message === "string" ? event.message : errorFallback;
    // A stale-nonce 400 (another tab rotated this preview's nonce) is a
    // RE-ARMABLE retry — route it to onStale so this tab can re-fetch + re-render
    // the still-live card, never a dead-end error. The preview is NOT burned on
    // this path (api.ts returns JSON BEFORE any commit), so the freshly re-served
    // nonce will validate. The chat stream has no onStale, so it falls to onError.
    if (event.code === STALE_NONCE_CODE && hooks.onStale) hooks.onStale(message);
    else hooks.onError(message);
  } else if (event.type === "status") {
    if (typeof event.label === "string") hooks.onStatus?.(event.label);
  }
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
  const buffer = new PreviewBuffer((results) => hooks.onResults(results));
  try {
    await api.confirmStream(ref, (event) => {
      // The confirm-resume stream's extra leading event: the committed receipt
      // must render FIRST (the button never feels dead) — everything after is the
      // ordinary streamed-turn dispatch.
      if (event.type === "receipt" && event.receipt) {
        hooks.onResults([{ kind: "receipt", receipt: event.receipt, ...(event.undo ? { undo: event.undo } : {}) } as ReceiptResult]);
        return;
      }
      dispatchStreamEvent(event, hooks, buffer, "The follow-up couldn't complete.");
    });
  } catch {
    hooks.onError("Confirmation failed.");
  } finally {
    buffer.flush();
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
  let presentedDetailedOutcome = false;
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
    if (response.result?.kind === "partial") {
      presentedDetailedOutcome = true;
      hooks.onResults([{
        ...response.result,
        ...(response.result.undo
          ? { undo: response.result.undo }
          : response.undo
            ? { undo: response.undo }
            : {}),
      }]);
      continue;
    }
    if (response.resume) {
      presentedDetailedOutcome = true;
      hooks.onResults(response.resume.results ?? []);
      if (response.resume.reply?.text) hooks.onAssistant(response.resume.reply.text);
    }
  }
  if (committed > 0 && !presentedDetailedOutcome) {
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
  operationRuns?: OperationCardData[];
}

export interface OperationCardData {
  id: string;
  actionName: string;
  status: "prepared" | "executing" | "succeeded" | "partial" | "definitive_failed" | "outcome_unknown" | "unknown";
  steps?: Array<{ planStepId: string; name: string; status: string }>;
  stepsTruncated?: boolean;
  reconciliation?: { authoritative?: boolean; reason?: string };
  createdAt?: string;
  updatedAt?: string;
}

export type RestoreItem =
  | { kind: "bubble"; role: "user" | "assistant"; text: string }
  | { kind: "results"; results: ChatResult[] }
  | { kind: "operation"; operation: OperationCardData };

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
  for (const operation of safe.operationRuns ?? []) {
    if (operation && typeof operation.id === "string" && typeof operation.actionName === "string") {
      const operationStatuses = new Set(["prepared", "executing", "succeeded", "partial", "definitive_failed", "outcome_unknown"]);
      const stepStatuses = new Set([
        "prepared", "executing", "succeeded", "definitive_failed", "outcome_unknown",
        "compensating", "compensated", "compensation_failed", "skipped",
      ]);
      items.push({
        kind: "operation",
        operation: {
          id: operation.id.slice(0, 256),
          actionName: operation.actionName.slice(0, 256),
          status: operationStatuses.has(operation.status) ? operation.status : "unknown",
          steps: (Array.isArray(operation.steps) ? operation.steps : []).slice(0, 50).map((step) => ({
            planStepId: typeof step?.planStepId === "string" ? step.planStepId.slice(0, 256) : "unknown",
            name: typeof step?.name === "string" ? step.name.slice(0, 256) : "unknown",
            status: typeof step?.status === "string" && stepStatuses.has(step.status) ? step.status : "unknown",
          })),
          ...(operation.stepsTruncated || (operation.steps?.length ?? 0) > 50 ? { stepsTruncated: true } : {}),
          ...(operation.reconciliation
            ? {
                reconciliation: {
                  ...(typeof operation.reconciliation.authoritative === "boolean"
                    ? { authoritative: operation.reconciliation.authoritative }
                    : {}),
                  ...(typeof operation.reconciliation.reason === "string"
                    ? { reason: operation.reconciliation.reason.slice(0, 256) }
                    : {}),
                },
              }
            : {}),
          ...(typeof operation.createdAt === "string" ? { createdAt: operation.createdAt } : {}),
          ...(typeof operation.updatedAt === "string" ? { updatedAt: operation.updatedAt } : {}),
        },
      });
    }
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
