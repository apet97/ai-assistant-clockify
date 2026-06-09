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
  preview: { actionLabel: string; expectedChanges: string[]; reversibility: string; warnings: string[] };
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
  receipt?: { ok: boolean; action: string };
  resume?: { reply: { kind: string; text: string }; results: ChatResult[] };
}

export interface ConfirmHooks {
  onAssistant(text: string): void;
  onResults(results: ChatResult[]): void;
  onError(message: string): void;
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
      hooks.onError(typeof response?.message === "string" ? response.message : "Confirmation failed.");
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
