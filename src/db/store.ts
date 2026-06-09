import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { migrate } from "./schema.js";
import { decryptSecret, encryptSecret } from "./encryption.js";
import { adminPolicySchema, defaultAdminPolicy, type AdminPolicy } from "../harness/permissions.js";
import type { RiskLabel } from "../harness/risk.js";
import type { PendingConfirmationRecord, PendingStatus } from "../harness/confirmations.js";
import type { SuccessReceipt, ErrorReceipt } from "../harness/receipts.js";

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

export interface StoreOptions {
  encryptionKey?: string;
  now?: () => Date;
}

const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

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
  getRecentMessages(sessionId: string, limit: number): ChatMessage[];

  savePendingConfirmation(record: PendingConfirmationRecord): void;
  getPendingConfirmation(id: string): PendingConfirmationRecord | undefined;
  /** Atomically transition pending → used. Returns true only for the caller
   *  that won the transition (closes the double-confirm TOCTOU). */
  markConfirmationUsed(id: string): boolean;
  /** Atomically transition pending → cancelled. */
  cancelConfirmation(id: string): boolean;
  setConfirmationResult(id: string, status: PendingStatus, result: unknown): void;

  /** Idempotency ledger (Phase 5): a committed success keyed by intent hash. */
  recordIdempotency(key: string, receipt: SuccessReceipt, committedAtEpochMs: number): void;
  lookupIdempotency(key: string, notBeforeEpochMs: number): SuccessReceipt | undefined;

  addAuditEvent(input: AuditEventInput): void;

  tables(): string[];
  rawAddonTokenForTest(workspaceId: string): string | undefined;
  close(): void;
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

  return {
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

    getRecentMessages(sessionId, limit) {
      const rows = db
        .prepare(
          "SELECT role, content, payload_json FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
        )
        .all(sessionId, limit) as Array<{
        role: ChatRole;
        content: string;
        payload_json: string | null;
      }>;
      return rows
        .reverse()
        .map((r) => ({
          role: r.role,
          content: r.content,
          payload: r.payload_json ? JSON.parse(r.payload_json) : undefined,
        }));
    },

    savePendingConfirmation(record) {
      db.prepare(
        `INSERT INTO pending_confirmations (
           id, session_id, workspace_id, admin_user_id, status, risk_json, preview_json,
           operation_json, operation_hash, nonce_hash, expires_at, created_at, used_at, result_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    },

    getPendingConfirmation(id) {
      const row = db.prepare("SELECT * FROM pending_confirmations WHERE id = ?").get(id) as
        | PendingRow
        | undefined;
      if (!row) return undefined;
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
      };
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

    recordIdempotency(key, receipt, committedAtEpochMs) {
      db.prepare(
        `INSERT INTO idempotency_keys (key, receipt_json, committed_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET receipt_json = excluded.receipt_json, committed_at = excluded.committed_at`,
      ).run(key, JSON.stringify(receipt), committedAtEpochMs);
    },

    lookupIdempotency(key, notBeforeEpochMs) {
      const row = db
        .prepare("SELECT receipt_json FROM idempotency_keys WHERE key = ? AND committed_at >= ?")
        .get(key, notBeforeEpochMs) as { receipt_json: string } | undefined;
      return row ? (JSON.parse(row.receipt_json) as SuccessReceipt) : undefined;
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

    close() {
      db.close();
    },
  };
}
