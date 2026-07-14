import type { RiskLabel } from "../../harness/risk.js";
import type { PendingConfirmationRecord, PendingStatus } from "../../harness/confirmations.js";
import type { StoreContext } from "./context.js";
import { randomUUID } from "node:crypto";

interface PendingRow {
  id: string;
  operation_id: string;
  session_id: string;
  workspace_id: string;
  admin_user_id: string;
  status: PendingStatus;
  risk_json: string;
  preview_json: string;
  operation_json: string;
  operation_hash: string;
  target_fingerprints_json: string;
  action_fingerprint: string;
  catalog_hash: string;
  nonce_hash: string;
  expires_at: string;
  created_at: string;
  used_at: string | null;
  result_json: string | null;
  agent_state_json: string | null;
  action_result_id: string | null;
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
    operationId: row.operation_id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    adminUserId: row.admin_user_id,
    status: row.status,
    risk: JSON.parse(row.risk_json) as RiskLabel[],
    preview: JSON.parse(row.preview_json),
    operation: JSON.parse(row.operation_json),
    operationHash: row.operation_hash,
    targetFingerprints: JSON.parse(row.target_fingerprints_json) as string[],
    actionFingerprint: row.action_fingerprint,
    catalogHash: row.catalog_hash,
    nonceHash: row.nonce_hash,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    usedAt: row.used_at ?? undefined,
    result: row.result_json ? JSON.parse(row.result_json) : undefined,
    agentState: parseStoredAgentState(row.agent_state_json),
    actionResultId: row.action_result_id ?? undefined,
  };
}

/**
 * Pending-confirmation concern: persist a preview + the ATOMIC one-use status
 * transitions (the confirm/cancel TOCTOU guards) + the per-session live list.
 */
export function buildConfirmationStore(ctx: StoreContext): {
  savePendingConfirmation(record: PendingConfirmationRecord): void;
  getPendingConfirmation(id: string): PendingConfirmationRecord | undefined;
  listPendingConfirmations(sessionId: string, nowIso: string): PendingConfirmationRecord[];
  updateConfirmationNonceHash(id: string, nonceHash: string): boolean;
  markConfirmationExecuting(id: string): boolean;
  cancelConfirmation(id: string): boolean;
  setConfirmationResult(id: string, status: PendingStatus, result: unknown): void;
  settleConfirmation(
    id: string,
    status: "succeeded" | "partial" | "definitive_failed" | "outcome_unknown",
    actionName: string,
    result: unknown,
  ): string;
  getActionResult(id: string): unknown | undefined;
  countPendingConfirmations(sessionId: string, nowIso: string): number;
} {
  const { db, nowIso } = ctx;
  return {
    savePendingConfirmation(record) {
      db.prepare(
        `INSERT INTO pending_confirmations (
           id, operation_id, session_id, workspace_id, admin_user_id, status, risk_json, preview_json,
           operation_json, operation_hash, target_fingerprints_json, action_fingerprint, catalog_hash,
           nonce_hash, expires_at, created_at, used_at, result_json, action_result_id, agent_state_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.operationId ?? record.id,
        record.sessionId,
        record.workspaceId,
        record.adminUserId,
        record.status,
        JSON.stringify(record.risk),
        JSON.stringify(record.preview),
        JSON.stringify(record.operation),
        record.operationHash,
        JSON.stringify(record.targetFingerprints ?? []),
        record.actionFingerprint ?? "legacy",
        record.catalogHash ?? "legacy",
        record.nonceHash,
        record.expiresAt,
        record.createdAt,
        record.usedAt ?? null,
        record.result === undefined ? null : JSON.stringify(record.result),
        record.actionResultId ?? null,
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

    markConfirmationExecuting(id) {
      return db.transaction((): boolean => {
        const info = db
          .prepare(
            "UPDATE pending_confirmations SET status = 'executing', used_at = ? WHERE id = ? AND status = 'pending'",
          )
          .run(nowIso(), id);
        if (info.changes !== 1) return false;
        db.prepare(
          `UPDATE operation_runs SET status = 'executing', updated_at = ?
             WHERE id = (SELECT operation_id FROM pending_confirmations WHERE id = ?)
               AND status = 'prepared'`,
        ).run(nowIso(), id);
        return true;
      })();
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

    settleConfirmation(id, status, actionName, result) {
      const settle = db.transaction((): string => {
        const row = db.prepare(
          "SELECT session_id, workspace_id, admin_user_id FROM pending_confirmations WHERE id = ?",
        ).get(id) as { session_id: string; workspace_id: string; admin_user_id: string } | undefined;
        if (!row) throw new Error("confirmation_not_found");
        const actionResultId = randomUUID();
        db.prepare(
          `INSERT INTO action_results (
             id, workspace_id, admin_user_id, session_id, action_name, kind, result_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          actionResultId,
          row.workspace_id,
          row.admin_user_id,
          row.session_id,
          actionName,
          status,
          JSON.stringify(result),
          nowIso(),
        );
        const update = db.prepare(
          `UPDATE pending_confirmations
             SET status = ?, result_json = ?, action_result_id = ?, nonce_hash = '',
                 agent_state_json = NULL, operation_json = '{}'
           WHERE id = ? AND status = 'executing'`,
        ).run(status, JSON.stringify(result), actionResultId, id);
        if (update.changes !== 1) throw new Error("confirmation_not_executing");
        db.prepare(
          `UPDATE operation_runs SET status = ?, action_result_id = ?, updated_at = ?
             WHERE id = (SELECT operation_id FROM pending_confirmations WHERE id = ?)`,
        ).run(status, actionResultId, nowIso(), id);
        return actionResultId;
      });
      return settle();
    },

    getActionResult(id) {
      const row = db.prepare("SELECT result_json FROM action_results WHERE id = ?").get(id) as
        | { result_json: string }
        | undefined;
      return row ? JSON.parse(row.result_json) : undefined;
    },

    countPendingConfirmations(sessionId, nowIso) {
      const row = db
        .prepare(
          "SELECT COUNT(*) AS n FROM pending_confirmations WHERE session_id = ? AND status = 'pending' AND expires_at > ?",
        )
        .get(sessionId, nowIso) as { n: number };
      return row.n;
    },
  };
}
