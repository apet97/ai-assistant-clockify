/** Cross-boundary product contracts shared by the server and framework-free UI. */

import type {
  DoneFrame,
  JsonValue,
  PresentedResult,
  PresentedResultEnvelope,
  RunEventAttachment,
  RunEventFrame,
  RunEventView,
  SequencedRunEvent,
} from "../assistant-v2/events.js";

export type {
  JsonValue,
  PresentedResult,
  PresentedResultEnvelope,
  RunEventAttachment,
  RunEventFrame,
  RunEventView,
  DoneFrame,
  SequencedRunEvent,
};

export type UiTheme = "system" | "light" | "dark";

export interface UiPreferences {
  theme: UiTheme;
  /** Verified Clockify timezone when available; omitted rather than guessed. */
  timeZone?: string;
}

export interface ArtifactDescriptor {
  downloadUrl: string;
  filename: string;
  expiresAt: string;
}

/**
 * Complete cross-boundary NDJSON contract. Payload generics let the server keep
 * its canonical action-result types while the browser substitutes its decoded
 * render types; neither side can invent or silently accept another event kind.
 */
export type ChatEvent<TResult = unknown, TReceipt = unknown> =
  | { type: "result"; result: TResult; persistenceDegraded?: boolean }
  | { type: "receipt"; receipt: TReceipt; undo?: { id: string }; persistenceDegraded?: boolean }
  | {
      type: "reply";
      text: string;
      kind?: string;
      /**
       * Structured per-item batch outcome (T13). `text` stays human-readable
       * prose; this carries the same counts/ids the non-stream JSON response
       * exposes so nothing is lost by making `text` readable.
       */
      batch?: {
        batchId: string;
        status: string;
        items: Array<{ confirmationId: string; status: string; replayed: boolean }>;
        persistenceDegraded?: boolean;
      };
    }
  | { type: "error"; message: string; code?: string }
  | { type: "status"; label: string; action?: string }
  | RunEventFrame
  | DoneFrame
  | { type: "done" };

export interface PublicProductLinks {
  privacy: string;
  support: string;
  security: string;
}

// ---------------------------------------------------------------------------
// T16-A frozen service DTOs (type-only — this module must never export runtime
// code: the UI bundle compiles against these types and tsc erases them).
// Security-scoping fields are always REQUIRED; a view DTO never carries a
// nonce, token hash, or raw header. Ids are server-minted UUIDs.
// ---------------------------------------------------------------------------

import type { AdminPolicy, FeatureGroup, PermissionLevel } from "../harness/permissions.js";
import type { MetricsReport, UsageMetrics } from "../metrics/metrics.js";

export type { AdminPolicy, FeatureGroup, PermissionLevel };

/** GET /api/permissions */
export interface PermissionsView {
  policy: AdminPolicy;
  firstRun: boolean;
  featureGroups: readonly FeatureGroup[];
}

/** POST /api/permissions/preview — the ONLY input the confirm step accepts is
 * the returned `previewToken` (five-minute, scope/version/patch-hash-bound).
 * Confirm never takes a replacement groups object (T16-E). */
export interface PermissionsPreviewView {
  current: AdminPolicy;
  next: AdminPolicy;
  changedGroups: FeatureGroup[];
  previewToken: string;
  expiresAt: string;
}

/** POST /api/permissions/confirm — the saved policy the UI re-renders from. */
export interface PermissionsSaveView {
  policy: AdminPolicy;
}

/** GET /api/metrics — caller-scoped aggregates only. */
export interface MetricsView {
  /** `runs` is the additive T17-E v2 run-metrics block; v1 fields are unchanged. */
  metrics: MetricsReport & { usage: UsageMetrics; runs: import("../metrics/run-metrics.js").RunMetrics };
}

/** One restored still-live preview card (GET /api/chat/history). The nonce is
 * the freshly ROTATED plaintext minted for this response only. */
export interface HistoryPendingPreview {
  kind: "preview";
  previewId: string;
  nonce: string;
  expiresAt: string;
  preview: unknown;
}

/** GET /api/chat/history — a restored transcript view, never a control surface:
 * stored results arrive sanitized (no undo handles, no nonce material). */
export interface HistoryView {
  messages: Array<{ role: "user" | "assistant"; content: string; results: unknown[] }>;
  pendingPreviews: HistoryPendingPreview[];
  operationRuns?: unknown[];
  activeRun?: { runId: string; phase: string; lastSequence: number; updatedAt: string };
}

/** GET /api/chat/sessions — the store's `SessionSummary` plus the
 * server-decided `current` flag (the UI can't read its HttpOnly cookie). */
export interface SessionListView {
  sessions: Array<{
    id: string;
    title: string;
    messageCount: number;
    lastMessageAt: string;
    createdAt: string;
    current: boolean;
  }>;
}

/** POST /api/undo/:id */
export interface UndoView {
  receipt: unknown;
  persistenceDegraded?: boolean;
}

/** POST /api/clarifications/:id/resolve request body. */
export interface ClarificationResolveRequest {
  optionId: string;
}

/** POST /api/confirmations/:id/confirm request body. */
export interface ConfirmRequest {
  nonce: string;
}

/** POST /api/confirmation-batches/:id/confirm request body. `nonce` is omitted
 * only on a replay of an already-settled item (replay validates nonce solely
 * for still-pending items). */
export interface ConfirmBatchRequest {
  items: Array<{ confirmationId: string; nonce?: string }>;
}
