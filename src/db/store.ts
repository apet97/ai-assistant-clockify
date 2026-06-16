import Database from "better-sqlite3";
import { migrate } from "./schema.js";
import { decryptSecret, encryptSecret } from "./encryption.js";
import type {
  StoreContext,
  InstallationStatus,
  InstallationInput,
  Installation,
  InstallationEnv,
  ChatSession,
  NewSessionInput,
  SessionSummary,
  NewMessageInput,
  ChatMessage,
  AuditEventInput,
  UndoRecordInput,
  UndoRecord,
  EraseCounts,
} from "./store/context.js";
import { buildAdminPolicyStore } from "./store/admin-policies.js";
import { buildTelemetryStore } from "./store/telemetry.js";
import {
  actionOutcomesSql,
  boundedWorkspaceAdminParams,
  buildAuditMetricsStore,
} from "./store/audit-metrics.js";
import { buildMessageStore } from "./store/messages.js";
import { buildSessionStore } from "./store/sessions.js";
import { buildUndoStore } from "./store/undo.js";
import { buildInstallationStore } from "./store/installations.js";
import { buildConfirmationStore } from "./store/confirmations.js";
import { buildIdempotencyStore } from "./store/idempotency.js";
import { buildRetentionStore, IDEMPOTENCY_RETENTION_MS, type PruneCounts } from "./store/retention.js";
import type { AdminPolicy } from "../harness/permissions.js";
import type { PendingConfirmationRecord, PendingStatus } from "../harness/confirmations.js";
import type { SuccessReceipt } from "../harness/receipts.js";
import type { ClaimState } from "../harness/action.js";
import type { ActionOutcome, TurnTelemetry } from "../metrics/metrics.js";

/**
 * The single SQLite access module (backend rule: all DB access goes through
 * src/db/store.ts). Owns config/policy/installation, chat sessions and messages,
 * pending confirmations (with an ATOMIC one-use transition), and audit events.
 *
 * The shared data-shape types live in the leaf `./store/context.ts` (so the
 * per-concern builder modules can import them without a `store.ts ↔ concern`
 * cycle); they are re-exported here so every `../db/store.js` import is
 * byte-identical.
 */

export type {
  InstallationStatus,
  InstallationInput,
  Installation,
  InstallationEnv,
  ChatSession,
  NewSessionInput,
  SessionSummary,
  ChatRole,
  NewMessageInput,
  ChatMessage,
  AuditEventInput,
  UndoRecordInput,
  UndoRecord,
  EraseCounts,
} from "./store/context.js";

export interface StoreOptions {
  encryptionKey?: string;
  now?: () => Date;
  /** Retention (days) for chat_messages + audit_events; defaults to 90. */
  retentionDays?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Chat/audit retention (marketplace data-minimization). chat_messages and
 * audit_events used to be kept forever; they now age out on a configurable
 * window (default 90 days, env RETENTION_DAYS, floor 30). 90d is well above the
 * recap (24h default / 30d max) and metrics (30d default) read windows, so those
 * features keep their full data. The committed receipts also live in the audit
 * log within the window.
 */
const DEFAULT_RETENTION_DAYS = 90;

/**
 * Dead-claim TTL (r1-concurrency-races-01). The LIVE-vs-crashed threshold: an
 * atomic claim NOT heartbeated within this window is treated as crashed. Set
 * STRICTLY above the commit-latency ceiling (COMMIT_TIMEOUT_MS, 120s) so a LIVE
 * commit's claim is provably never mis-read as crashed, yet well below
 * IDEMPOTENCY_WINDOW_MS (10 min) and IDEMPOTENCY_RETENTION_MS (60 min).
 *
 * crash-before-fill residual: a crashed claim is NOT swept-and-re-won here (that
 * silently double-committed a money write whose commit died between the host
 * write and `fill`). Instead `claimIdempotency` returns `stale_unknown` for it
 * throughout the dedup window — the caller surfaces "verify in Clockify, don't
 * retry" — and it is only swept (by the next same-key claim AND by pruneExpired)
 * once past the dedup/retention window, after which a deliberate re-issue commits.
 */
export const CLAIM_TTL_MS = 5 * 60 * 1000;

// The retention windows + pruneExpired/explainPrunePlan live in the retention
// concern builder; re-exported so the public `../db/store.js` surface
// (IDEMPOTENCY_RETENTION_MS + the PruneCounts type) stays byte-identical.
export { IDEMPOTENCY_RETENTION_MS };
export type { PruneCounts };

export interface Store {
  getAdminPolicy(workspaceId: string, adminUserId: string): AdminPolicy | undefined;
  upsertAdminPolicy(workspaceId: string, adminUserId: string, policy: AdminPolicy): void;
  saveInstallation(input: InstallationInput): void;
  getInstallation(workspaceId: string): Installation | undefined;
  /** Refresh environment URLs from the latest token; only provided fields change. */
  updateInstallationEnv(workspaceId: string, env: InstallationEnv): void;
  setInstallationStatus(workspaceId: string, status: InstallationStatus): void;
  /**
   * Erase ALL of a workspace's stored data (GDPR / uninstall): deletes every
   * workspace-scoped row and tombstones the installation with the token wiped.
   * Atomic; safe to call on an unknown workspace (no-op zero counts).
   */
  eraseWorkspace(workspaceId: string): EraseCounts;

  createSession(input: NewSessionInput): ChatSession;
  getSession(id: string): ChatSession | undefined;
  /**
   * This admin's live (non-expired), non-empty chat sessions in THIS workspace,
   * newest-first (by last message). Each summary carries the first user message
   * as a title + the message count. Scoped by workspace + admin (tenant
   * isolation): never enumerates another tenant's sessions.
   */
  listSessions(workspaceId: string, adminUserId: string, nowIso: string): SessionSummary[];

  addMessage(input: NewMessageInput): void;
  /**
   * Loads the most recent `limit` messages, oldest-first. `payload` is omitted
   * unless `includePayload` is true — the model-visible window only needs
   * role + content, so the stored payload blob is not fetched/parsed by default.
   */
  getRecentMessages(sessionId: string, limit: number, includePayload?: boolean): ChatMessage[];

  savePendingConfirmation(record: PendingConfirmationRecord): void;
  getPendingConfirmation(id: string): PendingConfirmationRecord | undefined;
  /** This session's still-live pending previews (status pending, not expired), oldest-first. */
  listPendingConfirmations(sessionId: string, nowIso: string): PendingConfirmationRecord[];
  /** Atomically swap the nonce hash; true only while still pending (a concurrent confirm/cancel wins). */
  updateConfirmationNonceHash(id: string, nonceHash: string): boolean;
  /** Atomically transition pending → used. Returns true only for the caller
   *  that won the transition (closes the double-confirm TOCTOU). */
  markConfirmationUsed(id: string): boolean;
  /** Atomically transition pending → cancelled. */
  cancelConfirmation(id: string): boolean;
  setConfirmationResult(id: string, status: PendingStatus, result: unknown): void;
  /** This session's still-live pending previews (status pending, not expired). */
  countPendingConfirmations(sessionId: string, nowIso: string): number;

  /** Idempotency ledger (Phase 5): a committed success keyed by intent hash. */
  recordIdempotency(key: string, receipt: SuccessReceipt, committedAtEpochMs: number): void;
  lookupIdempotency(key: string, notBeforeEpochMs: number): SuccessReceipt | undefined;

  /**
   * Atomic-claim ledger (r1-concurrency-races-01). One synchronous
   * better-sqlite3 transaction: sweep a stale COMPLETED row (committed_at <
   * completedNotBefore) or a dead CLAIM (claimed_at < claimNotBefore), then
   * INSERT...ON CONFLICT DO NOTHING. Returns `'won'` for the single winner,
   * `'replay'` when an in-window completed row already exists, `'in_flight'`
   * when a live claim is held by another request.
   */
  claimIdempotency(
    key: string,
    claimedAtEpochMs: number,
    completedNotBeforeEpochMs: number,
    claimNotBeforeEpochMs: number,
  ): ClaimState;
  /** The completed receipt for a key the claim reported as `replay`. */
  claimIdempotencyReceipt(key: string): SuccessReceipt | undefined;
  /** Complete the OWN claim (guarded on receipt_json IS NULL — fills once). */
  fillIdempotency(key: string, receipt: SuccessReceipt, committedAtEpochMs: number): void;
  /** Release the OWN claim (guarded on receipt_json IS NULL — never drops a completed row). */
  releaseIdempotency(key: string): void;
  /**
   * Heartbeat a LIVE claim: refresh `claimed_at` so a long multi-call commit's
   * claim is never swept as dead while it is still in flight (a single
   * createInvoice commit issues POST+GET+PUT+tax+N items, whose summed latency
   * can exceed CLAIM_TTL_MS — only the per-call timeout bounds each one).
   * Guarded on receipt_json IS NULL — never touches a completed row, and a
   * missing key no-ops.
   */
  touchIdempotencyClaim(key: string, claimedAtEpochMs: number): void;

  /** Undo ledger (Phase 5b): a reversible action and its one-use status. */
  recordUndoable(input: UndoRecordInput): string;
  getUndoRecord(id: string): UndoRecord | undefined;
  /** Atomically transition available → undone. Returns true only for the winner. */
  markUndone(id: string): boolean;

  addAuditEvent(input: AuditEventInput): void;

  /** Operational metrics (Phase 7): audited action outcomes + confirmation
   *  statuses, scoped to a workspace + admin, optionally since an ISO timestamp. */
  listActionOutcomes(workspaceId: string, adminUserId: string, sinceIso?: string): ActionOutcome[];
  listConfirmationOutcomes(workspaceId: string, adminUserId: string, sinceIso?: string): string[];

  /** Per-turn model telemetry (cost + latency; see metrics.ts TurnTelemetry). */
  recordTurnTelemetry(input: {
    sessionId: string;
    workspaceId: string;
    adminUserId: string;
    kind: "chat" | "resume";
    modelCalls: number;
    promptTokens?: number;
    completionTokens?: number;
    /** Prompt tokens served from the provider's cache; omit when the backend reported none. */
    cachedPromptTokens?: number;
    turnMs: number;
    modelMs: number;
  }): void;
  listTurnTelemetry(workspaceId: string, adminUserId: string, sinceIso?: string): TurnTelemetry[];

  /** Delete operational rows + chat_messages/audit_events past their retention windows. */
  pruneExpired(nowIso: string): PruneCounts;

  /** Cheap liveness probe — runs a trivial query against the DB handle. THROWS if the
   *  handle is closed/locked/unusable, so a readiness endpoint can 503 a hung instance
   *  (the static /manifest healthcheck can't tell). Returns nothing on success. */
  healthCheck(): void;

  close(): void;
}

/**
 * Test-only extension of {@link Store}. The concrete object returned by
 * `createStore` implements these too, but they are intentionally absent from
 * the production-facing `Store` interface so that only tests reach for them.
 * Cast a `createStore(...)` result to `TestStore` when an assertion needs them.
 */
export interface TestStore extends Store {
  tables(): string[];
  rawAddonTokenForTest(workspaceId: string): string | undefined;
  /** EXPLAIN QUERY PLAN of the exact `listActionOutcomes` statement (for the
   *  index-seek regression test); `detail` lines only. */
  explainActionOutcomesPlan(workspaceId: string, adminUserId: string, sinceIso?: string): string[];
  /** EXPLAIN QUERY PLAN of each `pruneExpired` DELETE, keyed by table (for the
   *  retention index-seek regression test); joined `detail` lines per table. */
  explainPrunePlan(): Record<
    "pendingConfirmations" | "idempotencyKeys" | "undoRecords" | "turnTelemetry" | "chatMessages" | "auditEvents",
    string
  >;
}

export function createStore(databasePath: string, options: StoreOptions = {}): Store {
  const db = new Database(databasePath);
  migrate(db);

  const now = options.now ?? (() => new Date());
  const nowIso = (): string => now().toISOString();
  const encryptionKey = options.encryptionKey;
  const chatAuditRetentionMs = (options.retentionDays ?? DEFAULT_RETENTION_DAYS) * DAY_MS;

  const sealToken = (token: string): string =>
    encryptionKey ? encryptSecret(token, encryptionKey) : token;
  const openToken = (value: string): string =>
    encryptionKey ? decryptSecret(value, encryptionKey) : value;

  // The shared primitives each concern builder needs (Step 1). Built once here,
  // exactly as the inline methods used them.
  const ctx: StoreContext = { db, now, nowIso, sealToken, openToken };

  // Built as TestStore (the concrete object implements the test-only methods),
  // returned as the narrower Store so production callers never see them.
  const store: TestStore = {
    ...buildAdminPolicyStore(ctx),
    ...buildTelemetryStore(ctx),
    ...buildAuditMetricsStore(ctx),
    ...buildMessageStore(ctx),
    ...buildSessionStore(ctx),
    ...buildUndoStore(ctx),
    ...buildInstallationStore(ctx),
    ...buildConfirmationStore(ctx),
    ...buildIdempotencyStore(ctx),
    ...buildRetentionStore(ctx, { chatAuditRetentionMs }),

    tables() {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      return rows.map((r) => r.name);
    },

    rawAddonTokenForTest(workspaceId) {
      const row = db
        .prepare("SELECT addon_token_ciphertext FROM installations WHERE workspace_id = ?")
        .get(workspaceId) as { addon_token_ciphertext: string } | undefined;
      return row?.addon_token_ciphertext;
    },

    explainActionOutcomesPlan(workspaceId, adminUserId, sinceIso) {
      const sql = actionOutcomesSql(sinceIso !== undefined);
      const params = boundedWorkspaceAdminParams(workspaceId, adminUserId, sinceIso);
      const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
        detail: string;
      }>;
      return rows.map((r) => r.detail);
    },

    healthCheck() {
      // user_version is a near-free pragma; reading it proves the handle is open and
      // the file is reachable. A closed/locked/corrupt DB throws here.
      db.pragma("user_version");
    },

    close() {
      db.close();
    },
  };

  return store;
}
