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
