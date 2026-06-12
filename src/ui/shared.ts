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
}

/** One event from a streaming chat OR confirm endpoint (NDJSON, one per line). */
export interface StreamEvent {
  type: "result" | "reply" | "error" | "done" | "receipt" | string;
  result?: ChatResult;
  /** Only on a confirm stream's first `receipt` event: the committed receipt + undo handle. */
  receipt?: ReceiptResult["receipt"];
  undo?: { id: string };
  kind?: string;
  text?: string;
  code?: string;
  message?: string;
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
        hooks.onError(typeof event.message === "string" ? event.message : "The follow-up couldn't complete.");
      }
    });
  } catch {
    hooks.onError("Confirmation failed.");
  } finally {
    flush();
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
 */
export function historyRestoreItems(history: HistoryResponse): RestoreItem[] {
  const items: RestoreItem[] = [];
  for (const message of history.messages ?? []) {
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
  if (history.pendingPreviews?.length) {
    items.push({ kind: "results", results: history.pendingPreviews });
  }
  return items;
}
