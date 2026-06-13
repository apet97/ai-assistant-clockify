import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { migrate } from "./schema.js";
import { decryptSecret, encryptSecret } from "./encryption.js";
import { adminPolicySchema, defaultAdminPolicy, type AdminPolicy } from "../harness/permissions.js";
import type { RiskLabel } from "../harness/risk.js";
import type { PendingConfirmationRecord, PendingStatus } from "../harness/confirmations.js";
import type { SuccessReceipt, ErrorReceipt, EntityRef } from "../harness/receipts.js";
import type { ClaimState } from "../harness/action.js";
import type { ActionOutcome, TurnTelemetry } from "../metrics/metrics.js";

/**
 * The single SQLite access module (backend rule: all DB access goes through
 * src/db/store.ts). Owns config/policy/installation, chat sessions and messages,
 * pending confirmations (with an ATOMIC one-use transition), and audit events.
 */

export type InstallationStatus = "active" | "inactive" | "deleted";

export interface InstallationInput {
  workspaceId: string;
  addonId: string;
  addonUserId: string;
  addonToken: string;
  apiUrl?: string;
  backendUrl?: string;
  reportsUrl?: string;
  status?: InstallationStatus;
  installedByUserId?: string;
}

export interface Installation {
  workspaceId: string;
  addonId: string;
  addonUserId: string;
  addonToken: string;
  apiUrl?: string;
  backendUrl?: string;
  reportsUrl?: string;
  status: InstallationStatus;
  installedByUserId?: string;
  installedAt: string;
  updatedAt: string;
}

/** Environment URLs refreshed from the latest verified token (component load). */
export interface InstallationEnv {
  apiUrl?: string;
  backendUrl?: string;
  reportsUrl?: string;
}

export interface ChatSession {
  id: string;
  workspaceId: string;
  adminUserId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export interface NewSessionInput {
  workspaceId: string;
  adminUserId: string;
  ttlMs?: number;
}

export type ChatRole = "user" | "assistant" | "system";

export interface NewMessageInput {
  sessionId: string;
  workspaceId: string;
  adminUserId: string;
  role: ChatRole;
  content: string;
  payload?: unknown;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  payload?: unknown;
}

export interface AuditEventInput {
  workspaceId: string;
  adminUserId: string;
  sessionId?: string;
  actionName: string;
  risk: RiskLabel[];
  receipt: SuccessReceipt | ErrorReceipt | Record<string, unknown>;
}

export interface UndoRecordInput {
  sessionId: string;
  workspaceId: string;
  adminUserId: string;
  actionName: string;
  reversal: EntityRef[];
}

export interface UndoRecord extends UndoRecordInput {
  id: string;
  status: "available" | "undone";
  createdAt: string;
  undoneAt?: string;
}

export interface StoreOptions {
  encryptionKey?: string;
  now?: () => Date;
}

const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * Operational-table retention. audit_events and chat_messages are NEVER pruned
 * (the audit log and durable history are product features). Settled/expired
 * confirmations age out on a 30d clock so listConfirmationOutcomes metrics
 * keep a generous recent window; the committed receipts live forever in
 * audit_events regardless.
 */
const CONFIRMATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const UNDO_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Must stay comfortably above routes/api.ts IDEMPOTENCY_WINDOW_MS (10 min). */
export const IDEMPOTENCY_RETENTION_MS = 60 * 60 * 1000;
/**
 * Dead-claim TTL (r1-concurrency-races-01). An atomic claim older than this is
 * treated as crashed and swept (by the next same-key claim AND by pruneExpired).
 * Set STRICTLY above the commit-latency ceiling (COMMIT_TIMEOUT_MS, 120s) so a
 * LIVE commit's claim is provably never swept, yet well below
 * IDEMPOTENCY_WINDOW_MS (10 min) and IDEMPOTENCY_RETENTION_MS (60 min). A crash
 * mid-commit thus blocks that key's retries for at most CLAIM_TTL_MS.
 */
export const CLAIM_TTL_MS = 5 * 60 * 1000;

export interface PruneCounts {
  pendingConfirmations: number;
  idempotencyKeys: number;
  undoRecords: number;
  turnTelemetry: number;
}

/** Turn telemetry rows older than this are pruned (cost review needs weeks, not forever). */
const TELEMETRY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface Store {
  getAdminPolicy(workspaceId: string, adminUserId: string): AdminPolicy | undefined;
  upsertAdminPolicy(workspaceId: string, adminUserId: string, policy: AdminPolicy): void;
  saveInstallation(input: InstallationInput): void;
  getInstallation(workspaceId: string): Installation | undefined;
  /** Refresh environment URLs from the latest token; only provided fields change. */
  updateInstallationEnv(workspaceId: string, env: InstallationEnv): void;
  setInstallationStatus(workspaceId: string, status: InstallationStatus): void;

  createSession(input: NewSessionInput): ChatSession;
  getSession(id: string): ChatSession | undefined;

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
    turnMs: number;
    modelMs: number;
  }): void;
  listTurnTelemetry(workspaceId: string, adminUserId: string, sinceIso?: string): TurnTelemetry[];

  /** Delete operational rows past retention. NEVER touches audit_events/chat_messages. */
  pruneExpired(nowIso: string): PruneCounts;

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
}

interface InstallationRow {
  workspace_id: string;
  addon_id: string;
  addon_user_id: string;
  addon_token_ciphertext: string;
  api_url: string | null;
  backend_url: string | null;
  reports_url: string | null;
  status: InstallationStatus;
  installed_by_user_id: string | null;
  installed_at: string;
  updated_at: string;
}

interface PendingRow {
  id: string;
  session_id: string;
  workspace_id: string;
  admin_user_id: string;
  status: PendingStatus;
  risk_json: string;
  preview_json: string;
  operation_json: string;
  operation_hash: string;
  nonce_hash: string;
  expires_at: string;
  created_at: string;
  used_at: string | null;
  result_json: string | null;
  agent_state_json: string | null;
}

/**
 * Parse the persisted agentic suspension defensively. A truncated/corrupt
 * agent_state_json must never throw out of getPendingConfirmation — the
 * confirm/cancel routes call that getter with no try/catch, so a raw JSON.parse
 * SyntaxError would escape as an unhandled rejection and leave the preview
 * permanently unconfirmable AND uncancellable. Returning undefined honours the
 * agentic-loop invariant ("agent_state_json … malformed ⇒ no resume"): the
 * confirm commits the receipt with no resume, the same fate parseAgentState
 * gives a structurally-malformed (but parseable) value. Only this column is
 * tolerant; risk/preview/operation stay strict because corrupting them is an
 * integrity failure, not a lost resume.
 */
function parseStoredAgentState(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * Map a pending_confirmations row to its record — shared by the single getter
 * and the per-session list. Fail-soft ONLY for the agentic suspension column
 * (see {@link parseStoredAgentState}); risk/preview/operation parse strictly
 * because corrupting them is a real integrity failure, not a lost resume.
 */
function pendingRowToRecord(row: PendingRow): PendingConfirmationRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    adminUserId: row.admin_user_id,
    status: row.status,
    risk: JSON.parse(row.risk_json) as RiskLabel[],
    preview: JSON.parse(row.preview_json),
    operation: JSON.parse(row.operation_json),
    operationHash: row.operation_hash,
    nonceHash: row.nonce_hash,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    usedAt: row.used_at ?? undefined,
    result: row.result_json ? JSON.parse(row.result_json) : undefined,
    agentState: parseStoredAgentState(row.agent_state_json),
  };
}

/**
 * SQL for {@link Store.listActionOutcomes}. The `created_at >= ?` predicate is
 * appended ONLY when a `since` bound is supplied. The previous
 * `(? IS NULL OR created_at >= ?)` form silently disabled the range column of
 * `idx_audit_events_workspace_admin_created` (the optimizer can't use a range
 * seek behind an OR on a bind param), turning every since-bounded recap/metrics
 * read into a workspace+admin partial-index SCAN. `json_extract` pulls the two
 * scalars the caller reads (`ok`, `code`) so SQLite never materializes the full
 * multi-KB receipt as a JS document just to read a boolean and a code string.
 * Single source of truth for both the query and the test-only EXPLAIN helper.
 */
function actionOutcomesSql(bounded: boolean): string {
  return `SELECT action_name,
            json_extract(receipt_json, '$.ok') AS ok,
            json_extract(receipt_json, '$.code') AS code
          FROM audit_events
          WHERE workspace_id = ? AND admin_user_id = ?${bounded ? " AND created_at >= ?" : ""}`;
}

/** SQL for {@link Store.listConfirmationOutcomes}; same conditional-bound shape. */
function confirmationOutcomesSql(bounded: boolean): string {
  return `SELECT status, expires_at FROM pending_confirmations
          WHERE workspace_id = ? AND admin_user_id = ?${bounded ? " AND created_at >= ?" : ""}`;
}

export function createStore(databasePath: string, options: StoreOptions = {}): Store {
  const db = new Database(databasePath);
  migrate(db);

  const now = options.now ?? (() => new Date());
  const nowIso = (): string => now().toISOString();
  const encryptionKey = options.encryptionKey;

  const sealToken = (token: string): string =>
    encryptionKey ? encryptSecret(token, encryptionKey) : token;
  const openToken = (value: string): string =>
    encryptionKey ? decryptSecret(value, encryptionKey) : value;

  // Built as TestStore (the concrete object implements the test-only methods),
  // returned as the narrower Store so production callers never see them.
  const store: TestStore = {
    getAdminPolicy(workspaceId, adminUserId) {
      const row = db
        .prepare(
          "SELECT policy_json FROM admin_policies WHERE workspace_id = ? AND admin_user_id = ?",
        )
        .get(workspaceId, adminUserId) as { policy_json: string } | undefined;
      if (!row) return undefined;
      // Back-compat migration: feature groups added after this policy was written
      // are absent from the stored JSON, but `adminPolicySchema` is `.strict()`
      // and requires every current group. Fill any missing key with the locked
      // full-access default (`read_write`) before validating, preserving any
      // non-default values the admin set on the groups that were stored.
      const stored = JSON.parse(row.policy_json) as {
        version?: number;
        groups?: Record<string, unknown>;
      };
      const merged = {
        version: stored.version ?? 1,
        groups: { ...defaultAdminPolicy().groups, ...(stored.groups ?? {}) },
      };
      return adminPolicySchema.parse(merged);
    },

    upsertAdminPolicy(workspaceId, adminUserId, policy) {
      const validated = adminPolicySchema.parse(policy);
      const timestamp = nowIso();
      db.prepare(
        `INSERT INTO admin_policies (id, workspace_id, admin_user_id, policy_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, admin_user_id)
         DO UPDATE SET policy_json = excluded.policy_json, updated_at = excluded.updated_at`,
      ).run(randomUUID(), workspaceId, adminUserId, JSON.stringify(validated), timestamp, timestamp);
    },

    saveInstallation(input) {
      const timestamp = nowIso();
      db.prepare(
        `INSERT INTO installations (
           workspace_id, addon_id, addon_user_id, addon_token_ciphertext,
           api_url, backend_url, reports_url, status, installed_by_user_id, installed_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET
           addon_id = excluded.addon_id,
           addon_user_id = excluded.addon_user_id,
           addon_token_ciphertext = excluded.addon_token_ciphertext,
           api_url = excluded.api_url,
           backend_url = excluded.backend_url,
           reports_url = COALESCE(excluded.reports_url, installations.reports_url),
           status = excluded.status,
           installed_by_user_id = excluded.installed_by_user_id,
           updated_at = excluded.updated_at`,
      ).run(
        input.workspaceId,
        input.addonId,
        input.addonUserId,
        sealToken(input.addonToken),
        input.apiUrl ?? null,
        input.backendUrl ?? null,
        input.reportsUrl ?? null,
        input.status ?? "active",
        input.installedByUserId ?? null,
        timestamp,
        timestamp,
      );
    },

    updateInstallationEnv(workspaceId, env) {
      db.prepare(
        `UPDATE installations SET
           api_url = COALESCE(?, api_url),
           backend_url = COALESCE(?, backend_url),
           reports_url = COALESCE(?, reports_url),
           updated_at = ?
         WHERE workspace_id = ?`,
      ).run(
        env.apiUrl ?? null,
        env.backendUrl ?? null,
        env.reportsUrl ?? null,
        nowIso(),
        workspaceId,
      );
    },

    getInstallation(workspaceId) {
      const row = db
        .prepare("SELECT * FROM installations WHERE workspace_id = ?")
        .get(workspaceId) as InstallationRow | undefined;
      if (!row) return undefined;
      return {
        workspaceId: row.workspace_id,
        addonId: row.addon_id,
        addonUserId: row.addon_user_id,
        addonToken: openToken(row.addon_token_ciphertext),
        apiUrl: row.api_url ?? undefined,
        backendUrl: row.backend_url ?? undefined,
        reportsUrl: row.reports_url ?? undefined,
        status: row.status,
        installedByUserId: row.installed_by_user_id ?? undefined,
        installedAt: row.installed_at,
        updatedAt: row.updated_at,
      };
    },

    setInstallationStatus(workspaceId, status) {
      db.prepare("UPDATE installations SET status = ?, updated_at = ? WHERE workspace_id = ?").run(
        status,
        nowIso(),
        workspaceId,
      );
    },

    createSession(input) {
      const timestamp = nowIso();
      const expiresAt = new Date(
        now().getTime() + (input.ttlMs ?? DEFAULT_SESSION_TTL_MS),
      ).toISOString();
      const session: ChatSession = {
        id: randomUUID(),
        workspaceId: input.workspaceId,
        adminUserId: input.adminUserId,
        createdAt: timestamp,
        lastSeenAt: timestamp,
        expiresAt,
      };
      db.prepare(
        `INSERT INTO chat_sessions (id, workspace_id, admin_user_id, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        session.id,
        session.workspaceId,
        session.adminUserId,
        session.createdAt,
        session.lastSeenAt,
        session.expiresAt,
      );
      return session;
    },

    getSession(id) {
      const row = db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(id) as
        | {
            id: string;
            workspace_id: string;
            admin_user_id: string;
            created_at: string;
            last_seen_at: string;
            expires_at: string;
          }
        | undefined;
      if (!row) return undefined;
      if (new Date(row.expires_at).getTime() <= now().getTime()) return undefined;
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        adminUserId: row.admin_user_id,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: row.expires_at,
      };
    },

    addMessage(input) {
      db.prepare(
        `INSERT INTO chat_messages (id, session_id, workspace_id, admin_user_id, role, content, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        input.sessionId,
        input.workspaceId,
        input.adminUserId,
        input.role,
        input.content,
        input.payload === undefined ? null : JSON.stringify(input.payload),
        nowIso(),
      );
    },

    getRecentMessages(sessionId, limit, includePayload = false) {
      // The model-visible window (the sole request-path consumer) needs only
      // role + content; the stored payload can be a fat list/report receipt
      // (100KB+), so fetching + JSON.parsing it per windowed row is wasted work.
      // It is loaded only when a caller explicitly opts in.
      const columns = includePayload ? "role, content, payload_json" : "role, content";
      const rows = db
        .prepare(
          `SELECT ${columns} FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .all(sessionId, limit) as Array<{
        role: ChatRole;
        content: string;
        payload_json?: string | null;
      }>;
      return rows.reverse().map((r) =>
        includePayload
          ? {
              role: r.role,
              content: r.content,
              payload: r.payload_json ? JSON.parse(r.payload_json) : undefined,
            }
          : { role: r.role, content: r.content },
      );
    },

    savePendingConfirmation(record) {
      db.prepare(
        `INSERT INTO pending_confirmations (
           id, session_id, workspace_id, admin_user_id, status, risk_json, preview_json,
           operation_json, operation_hash, nonce_hash, expires_at, created_at, used_at, result_json,
           agent_state_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.sessionId,
        record.workspaceId,
        record.adminUserId,
        record.status,
        JSON.stringify(record.risk),
        JSON.stringify(record.preview),
        JSON.stringify(record.operation),
        record.operationHash,
        record.nonceHash,
        record.expiresAt,
        record.createdAt,
        record.usedAt ?? null,
        record.result === undefined ? null : JSON.stringify(record.result),
        record.agentState === undefined ? null : JSON.stringify(record.agentState),
      );
    },

    getPendingConfirmation(id) {
      const row = db.prepare("SELECT * FROM pending_confirmations WHERE id = ?").get(id) as
        | PendingRow
        | undefined;
      if (!row) return undefined;
      return pendingRowToRecord(row);
    },

    listPendingConfirmations(sessionId, nowIsoArg) {
      // Rides idx_pending_confirmations_session(session_id, status, expires_at).
      const rows = db
        .prepare(
          `SELECT * FROM pending_confirmations
            WHERE session_id = ? AND status = 'pending' AND expires_at > ?
            ORDER BY created_at ASC`,
        )
        .all(sessionId, nowIsoArg) as PendingRow[];
      return rows.map(pendingRowToRecord);
    },

    updateConfirmationNonceHash(id, nonceHash) {
      const info = db
        .prepare("UPDATE pending_confirmations SET nonce_hash = ? WHERE id = ? AND status = 'pending'")
        .run(nonceHash, id);
      return info.changes === 1;
    },

    markConfirmationUsed(id) {
      const info = db
        .prepare(
          "UPDATE pending_confirmations SET status = 'used', used_at = ? WHERE id = ? AND status = 'pending'",
        )
        .run(nowIso(), id);
      return info.changes === 1;
    },

    cancelConfirmation(id) {
      const info = db
        .prepare(
          "UPDATE pending_confirmations SET status = 'cancelled', used_at = ? WHERE id = ? AND status = 'pending'",
        )
        .run(nowIso(), id);
      return info.changes === 1;
    },

    setConfirmationResult(id, status, result) {
      db.prepare("UPDATE pending_confirmations SET status = ?, result_json = ? WHERE id = ?").run(
        status,
        result === undefined ? null : JSON.stringify(result),
        id,
      );
    },

    countPendingConfirmations(sessionId, nowIso) {
      const row = db
        .prepare(
          "SELECT COUNT(*) AS n FROM pending_confirmations WHERE session_id = ? AND status = 'pending' AND expires_at > ?",
        )
        .get(sessionId, nowIso) as { n: number };
      return row.n;
    },

    addAuditEvent(input) {
      db.prepare(
        `INSERT INTO audit_events (id, workspace_id, admin_user_id, session_id, action_name, risk_json, receipt_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        input.workspaceId,
        input.adminUserId,
        input.sessionId ?? null,
        input.actionName,
        JSON.stringify(input.risk),
        JSON.stringify(input.receipt),
        nowIso(),
      );
    },

    listActionOutcomes(workspaceId, adminUserId, sinceIso) {
      const sql = actionOutcomesSql(sinceIso !== undefined);
      const params = sinceIso !== undefined ? [workspaceId, adminUserId, sinceIso] : [workspaceId, adminUserId];
      const rows = db.prepare(sql).all(...params) as Array<{
        action_name: string;
        // SQLite json_extract returns the JSON value as a native scalar: 1/0 for
        // booleans, a string (or NULL) for code. Extracting the two scalars in
        // SQLite avoids JSON.parse'ing the (potentially multi-KB) receipt per row.
        ok: number | null;
        code: string | null;
      }>;
      return rows.map((row) => {
        const outcome: ActionOutcome = { actionName: row.action_name, ok: row.ok === 1 };
        if (!outcome.ok && typeof row.code === "string") outcome.code = row.code;
        return outcome;
      });
    },

    listConfirmationOutcomes(workspaceId, adminUserId, sinceIso) {
      const sql = confirmationOutcomesSql(sinceIso !== undefined);
      const params = sinceIso !== undefined ? [workspaceId, adminUserId, sinceIso] : [workspaceId, adminUserId];
      const rows = db.prepare(sql).all(...params) as Array<{
        status: string;
        expires_at: string;
      }>;
      // A preview never gets an 'expired' status written to the DB (the safety
      // paths read expires_at directly); derive it here so metrics/recaps don't
      // report a lapsed preview as eternally pending.
      const nowMs = now().getTime();
      return rows.map((row) =>
        row.status === "pending" && new Date(row.expires_at).getTime() <= nowMs
          ? "expired"
          : row.status,
      );
    },

    recordIdempotency(key, receipt, committedAtEpochMs) {
      // Legacy/best-effort path (non-atomic ledger). Stamp claimed_at too so the
      // row is prune-able by BOTH prune arms.
      db.prepare(
        `INSERT INTO idempotency_keys (key, receipt_json, committed_at, claimed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET receipt_json = excluded.receipt_json, committed_at = excluded.committed_at, claimed_at = excluded.claimed_at`,
      ).run(key, JSON.stringify(receipt), committedAtEpochMs, committedAtEpochMs);
    },

    lookupIdempotency(key, notBeforeEpochMs) {
      // `receipt_json IS NOT NULL` so an in-flight CLAIM is never returned as a
      // completed receipt (it also can't JSON.parse).
      const row = db
        .prepare(
          "SELECT receipt_json FROM idempotency_keys WHERE key = ? AND committed_at >= ? AND receipt_json IS NOT NULL",
        )
        .get(key, notBeforeEpochMs) as { receipt_json: string } | undefined;
      return row ? (JSON.parse(row.receipt_json) as SuccessReceipt) : undefined;
    },

    claimIdempotency(key, claimedAtEpochMs, completedNotBeforeEpochMs, claimNotBeforeEpochMs) {
      // ONE synchronous transaction (better-sqlite3 is sync, so no JS
      // interleaving): sweep a stale-completed OR dead-claim row, then race the
      // INSERT. ON CONFLICT DO NOTHING gives changes===1 to exactly one winner.
      return db.transaction((): ClaimState => {
        db.prepare(
          `DELETE FROM idempotency_keys
             WHERE key = ?
               AND ((receipt_json IS NOT NULL AND committed_at < ?)
                 OR (receipt_json IS NULL AND claimed_at < ?))`,
        ).run(key, completedNotBeforeEpochMs, claimNotBeforeEpochMs);
        const ins = db
          .prepare(
            `INSERT INTO idempotency_keys (key, receipt_json, committed_at, claimed_at)
               VALUES (?, NULL, NULL, ?) ON CONFLICT(key) DO NOTHING`,
          )
          .run(key, claimedAtEpochMs);
        if (ins.changes === 1) return "won";
        const row = db
          .prepare("SELECT receipt_json FROM idempotency_keys WHERE key = ?")
          .get(key) as { receipt_json: string | null } | undefined;
        // The row vanished mid-transaction (a concurrent release won the row):
        // the key is free again, so report a fresh win — the caller commits.
        if (!row) return "won";
        return row.receipt_json !== null ? "replay" : "in_flight";
      })();
    },

    claimIdempotencyReceipt(key) {
      const row = db
        .prepare("SELECT receipt_json FROM idempotency_keys WHERE key = ? AND receipt_json IS NOT NULL")
        .get(key) as { receipt_json: string } | undefined;
      return row ? (JSON.parse(row.receipt_json) as SuccessReceipt) : undefined;
    },

    fillIdempotency(key, receipt, committedAtEpochMs) {
      // Guarded on receipt_json IS NULL: fills only the OWN (still-claimed) row;
      // a re-fill or a fill of an already-completed row no-ops.
      db.prepare(
        "UPDATE idempotency_keys SET receipt_json = ?, committed_at = ? WHERE key = ? AND receipt_json IS NULL",
      ).run(JSON.stringify(receipt), committedAtEpochMs, key);
    },

    releaseIdempotency(key) {
      // Guarded on receipt_json IS NULL: a release can NEVER drop a COMPLETED row.
      db.prepare("DELETE FROM idempotency_keys WHERE key = ? AND receipt_json IS NULL").run(key);
    },

    recordUndoable(input) {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO undo_records (id, session_id, workspace_id, admin_user_id, action_name, reversal_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'available', ?)`,
      ).run(
        id,
        input.sessionId,
        input.workspaceId,
        input.adminUserId,
        input.actionName,
        JSON.stringify(input.reversal),
        nowIso(),
      );
      return id;
    },

    getUndoRecord(id) {
      const row = db.prepare("SELECT * FROM undo_records WHERE id = ?").get(id) as
        | {
            id: string;
            session_id: string;
            workspace_id: string;
            admin_user_id: string;
            action_name: string;
            reversal_json: string;
            status: "available" | "undone";
            created_at: string;
            undone_at: string | null;
          }
        | undefined;
      if (!row) return undefined;
      return {
        id: row.id,
        sessionId: row.session_id,
        workspaceId: row.workspace_id,
        adminUserId: row.admin_user_id,
        actionName: row.action_name,
        reversal: JSON.parse(row.reversal_json) as EntityRef[],
        status: row.status,
        createdAt: row.created_at,
        undoneAt: row.undone_at ?? undefined,
      };
    },

    markUndone(id) {
      const info = db
        .prepare("UPDATE undo_records SET status = 'undone', undone_at = ? WHERE id = ? AND status = 'available'")
        .run(nowIso(), id);
      return info.changes > 0;
    },

    recordTurnTelemetry(input) {
      db.prepare(
        `INSERT INTO turn_telemetry (
           id, session_id, workspace_id, admin_user_id, kind, model_calls,
           prompt_tokens, completion_tokens, turn_ms, model_ms, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        input.sessionId,
        input.workspaceId,
        input.adminUserId,
        input.kind,
        input.modelCalls,
        input.promptTokens ?? null,
        input.completionTokens ?? null,
        input.turnMs,
        input.modelMs,
        nowIso(),
      );
    },

    listTurnTelemetry(workspaceId, adminUserId, sinceIso) {
      // Conditional bound, same shape as actionOutcomesSql: appending the range
      // predicate only when bounded keeps the index seek (see that comment).
      const bounded = sinceIso !== undefined;
      const rows = db
        .prepare(
          `SELECT kind, model_calls, prompt_tokens, completion_tokens, turn_ms, model_ms, created_at
             FROM turn_telemetry
            WHERE workspace_id = ? AND admin_user_id = ?${bounded ? " AND created_at >= ?" : ""}
            ORDER BY created_at ASC`,
        )
        .all(...(bounded ? [workspaceId, adminUserId, sinceIso] : [workspaceId, adminUserId])) as Array<{
        kind: "chat" | "resume";
        model_calls: number;
        prompt_tokens: number | null;
        completion_tokens: number | null;
        turn_ms: number;
        model_ms: number;
        created_at: string;
      }>;
      return rows.map((row) => ({
        kind: row.kind,
        modelCalls: row.model_calls,
        promptTokens: row.prompt_tokens ?? undefined,
        completionTokens: row.completion_tokens ?? undefined,
        turnMs: row.turn_ms,
        modelMs: row.model_ms,
        createdAt: row.created_at,
      }));
    },

    pruneExpired(nowIsoArg) {
      const nowMs = Date.parse(nowIsoArg);
      const confirmationCutoff = new Date(nowMs - CONFIRMATION_RETENTION_MS).toISOString();
      const undoCutoff = new Date(nowMs - UNDO_RETENTION_MS).toISOString();
      const telemetryCutoff = new Date(nowMs - TELEMETRY_RETENTION_MS).toISOString();
      const idempotencyCutoff = nowMs - IDEMPOTENCY_RETENTION_MS;
      // Crashed-claim backstop (r1-concurrency-races-01): a NULL-receipt claim
      // for a key that never recurs would leak forever — the committed_at-only
      // prune NEVER matches it (NULL < n is NULL/falsy in SQLite, proven by
      // execution). Sweep dead claims independently on the CLAIM_TTL clock.
      const claimCutoff = nowMs - CLAIM_TTL_MS;
      // One transaction — operational tables ONLY. ISO-string comparison is
      // safe: every writer stamps via toISOString().
      const run = db.transaction((): PruneCounts => {
        const confirmations = db
          .prepare(
            `DELETE FROM pending_confirmations
              WHERE (status != 'pending' AND created_at < ?)
                 OR (status  = 'pending' AND expires_at < ?)`,
          )
          .run(confirmationCutoff, confirmationCutoff).changes;
        const idempotency = db
          .prepare(
            `DELETE FROM idempotency_keys
               WHERE (committed_at IS NOT NULL AND committed_at < ?)
                  OR (receipt_json IS NULL AND claimed_at < ?)`,
          )
          .run(idempotencyCutoff, claimCutoff).changes;
        const undo = db
          .prepare("DELETE FROM undo_records WHERE status = 'undone' AND undone_at IS NOT NULL AND undone_at < ?")
          .run(undoCutoff).changes;
        const telemetry = db
          .prepare("DELETE FROM turn_telemetry WHERE created_at < ?")
          .run(telemetryCutoff).changes;
        return { pendingConfirmations: confirmations, idempotencyKeys: idempotency, undoRecords: undo, turnTelemetry: telemetry };
      });
      return run();
    },

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
      const params = sinceIso !== undefined ? [workspaceId, adminUserId, sinceIso] : [workspaceId, adminUserId];
      const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
        detail: string;
      }>;
      return rows.map((r) => r.detail);
    },

    close() {
      db.close();
    },
  };

  return store;
}
