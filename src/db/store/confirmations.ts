import type { RiskLabel } from "../../harness/risk.js";
import type { PendingConfirmationRecord, PendingStatus } from "../../harness/confirmations.js";
import type { StoreContext } from "./context.js";
import { randomUUID } from "node:crypto";
import { actionResultJson, buildActionResultSummary, type ActionResultRef } from "../action-results.js";

interface PendingRow {
  id: string;
  operation_id: string;
  session_id: string;
  workspace_id: string;
  admin_user_id: string;
  status: PendingStatus;
  risk_json: string;
  preview_json: string;
  operation_json: string | null;
  operation_hash: string;
  target_fingerprints_json: string;
  action_fingerprint: string;
  catalog_hash: string;
  nonce_hash: string;
  expires_at: string;
  created_at: string;
  used_at: string | null;
  result_summary_json: string | null;
  agent_state_json: string | null;
  action_result_id: string | null;
  idempotency_key: string | null;
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
    operation: row.operation_json ? JSON.parse(row.operation_json) : {},
    operationHash: row.operation_hash,
    targetFingerprints: JSON.parse(row.target_fingerprints_json) as string[],
    actionFingerprint: row.action_fingerprint,
    catalogHash: row.catalog_hash,
    nonceHash: row.nonce_hash,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    usedAt: row.used_at ?? undefined,
    agentState: parseStoredAgentState(row.agent_state_json),
    actionResultId: row.action_result_id ?? undefined,
  };
}

function dispatchUnknownResult(actionName: string): unknown {
  return {
    kind: "receipt",
    receipt: {
      ok: false,
      action: actionName,
      code: "commit_outcome_unknown",
      message: "This confirmation entered the dispatch window without a durable final receipt, so its outcome is unknown.",
      recovery: "Verify the result in Clockify before trying the action again.",
    },
  };
}

/**
 * Pending-confirmation concern: persist a preview + the ATOMIC one-use status
 * transitions (the confirm/cancel TOCTOU guards), pre-dispatch canonical result
 * binding/scrubbing, and the per-session live list.
 */
export function buildConfirmationStore(ctx: StoreContext): {
  savePendingConfirmation(record: PendingConfirmationRecord): void;
  getPendingConfirmation(id: string): PendingConfirmationRecord | undefined;
  listPendingConfirmations(sessionId: string, nowIso: string): PendingConfirmationRecord[];
  updateConfirmationNonceHash(id: string, nonceHash: string): boolean;
  markConfirmationExecuting(id: string): boolean;
  cancelConfirmation(id: string): boolean;
  expireConfirmation(id: string): boolean;
  bindConfirmationIdempotencyKey(id: string, key: string): void;
  releaseConfirmationIdempotencyKey(id: string, key: string): void;
  settleConfirmation(
    id: string,
    status: "succeeded" | "partial" | "definitive_failed" | "outcome_unknown",
    actionName: string,
    result: unknown,
  ): ActionResultRef;
  getActionResult(id: string): unknown | undefined;
  countPendingConfirmations(sessionId: string, nowIso: string): number;
} {
  const { db, now, nowIso } = ctx;
  return {
    savePendingConfirmation(record) {
      db.prepare(
        `INSERT INTO pending_confirmations (
           id, operation_id, session_id, workspace_id, admin_user_id, status, risk_json, preview_json,
           operation_json, operation_hash, target_fingerprints_json, action_fingerprint, catalog_hash,
           nonce_hash, expires_at, created_at, used_at, action_result_id, idempotency_key,
           result_summary_json, agent_state_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        record.actionResultId ?? null,
        null,
        null,
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
      return db.transaction(() => {
        db.prepare(
          `UPDATE pending_confirmations
              SET status = 'expired', used_at = ?, nonce_hash = '',
                  agent_state_json = NULL, operation_json = NULL
            WHERE session_id = ? AND status = 'pending' AND expires_at <= ?`,
        ).run(nowIsoArg, sessionId, nowIsoArg);
        const rows = db
          .prepare(
            `SELECT * FROM pending_confirmations
              WHERE session_id = ? AND status = 'pending' AND expires_at > ?
              ORDER BY created_at ASC`,
          )
          .all(sessionId, nowIsoArg) as PendingRow[];
        return rows.map(pendingRowToRecord);
      })();
    },

    updateConfirmationNonceHash(id, nonceHash) {
      const info = db
        .prepare("UPDATE pending_confirmations SET nonce_hash = ? WHERE id = ? AND status = 'pending'")
        .run(nonceHash, id);
      return info.changes === 1;
    },

    markConfirmationExecuting(id) {
      return db.transaction((): boolean => {
        const row = db.prepare(
          `SELECT c.operation_id, c.session_id, c.workspace_id, c.admin_user_id,
                  c.operation_json, COALESCE(o.action_name, '') AS operation_action_name
             FROM pending_confirmations c
             LEFT JOIN operation_runs o ON o.id = c.operation_id
            WHERE c.id = ? AND c.status = 'pending'`,
        ).get(id) as {
          operation_id: string;
          session_id: string;
          workspace_id: string;
          admin_user_id: string;
          operation_json: string | null;
          operation_action_name: string;
        } | undefined;
        if (!row) return false;
        const operation = row.operation_json
          ? JSON.parse(row.operation_json) as { actionName?: unknown }
          : undefined;
        const actionName = row.operation_action_name ||
          (typeof operation?.actionName === "string" && operation.actionName.length > 0
            ? operation.actionName
            : "unknown_action");
        const actionResultId = randomUUID();
        const result = dispatchUnknownResult(actionName);
        const summary = buildActionResultSummary(actionResultId, result);
        const claimedAt = nowIso();
        const info = db
          .prepare(
            `UPDATE pending_confirmations
                SET status = 'executing', used_at = ?, action_result_id = ?,
                    result_summary_json = ?, nonce_hash = '', agent_state_json = NULL,
                    operation_json = NULL
              WHERE id = ? AND status = 'pending'`,
          )
          .run(claimedAt, actionResultId, actionResultJson(summary), id);
        if (info.changes !== 1) return false;
        db.prepare(
          `INSERT INTO action_results (
             id, operation_id, workspace_id, admin_user_id, session_id, action_name, kind,
             result_json, summary_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'outcome_unknown', ?, ?, ?)`,
        ).run(
          actionResultId,
          row.operation_id,
          row.workspace_id,
          row.admin_user_id,
          row.session_id,
          actionName,
          actionResultJson(result),
          actionResultJson(summary),
          claimedAt,
        );
        const operationClaim = db.prepare(
          `UPDATE operation_runs SET status = 'executing', action_result_id = ?, updated_at = ?
             WHERE id = (SELECT operation_id FROM pending_confirmations WHERE id = ?)
               AND status = 'prepared'`,
        ).run(actionResultId, claimedAt, id);
        if (operationClaim.changes !== 1) throw new Error("operation_not_prepared");
        return true;
      })();
    },

    cancelConfirmation(id) {
      const info = db
        .prepare(
          `UPDATE pending_confirmations
              SET status = 'cancelled', used_at = ?, nonce_hash = '',
                  agent_state_json = NULL, operation_json = NULL
            WHERE id = ? AND status = 'pending'`,
        )
        .run(nowIso(), id);
      return info.changes === 1;
    },

    expireConfirmation(id) {
      return db.prepare(
        `UPDATE pending_confirmations
            SET status = 'expired', used_at = ?, nonce_hash = '',
                agent_state_json = NULL, operation_json = NULL
          WHERE id = ? AND status = 'pending' AND expires_at <= ?`,
      ).run(nowIso(), id, nowIso()).changes === 1;
    },

    bindConfirmationIdempotencyKey(id, key) {
      db.transaction(() => {
        const row = db.prepare(
          `SELECT workspace_id, admin_user_id
             FROM pending_confirmations
            WHERE id = ? AND status = 'executing' AND idempotency_key IS NULL`,
        ).get(id) as { workspace_id: string; admin_user_id: string } | undefined;
        if (!row) throw new Error("confirmation_not_executing");
        const claim = db.prepare(
          `SELECT 1 FROM idempotency_keys
            WHERE key = ? AND workspace_id = ? AND admin_user_id = ?
              AND action_result_id IS NULL`,
        ).get(key, row.workspace_id, row.admin_user_id);
        if (!claim) throw new Error("idempotency_claim_not_owned");
        const update = db.prepare(
          `UPDATE pending_confirmations SET idempotency_key = ?
            WHERE id = ? AND status = 'executing' AND idempotency_key IS NULL`,
        ).run(key, id);
        if (update.changes !== 1) throw new Error("confirmation_not_executing");
      })();
    },

    releaseConfirmationIdempotencyKey(id, key) {
      db.transaction(() => {
        const row = db.prepare(
          "SELECT workspace_id, admin_user_id FROM pending_confirmations WHERE id = ? AND idempotency_key = ?",
        ).get(id, key) as { workspace_id: string; admin_user_id: string } | undefined;
        if (!row) return;
        db.prepare(
          `DELETE FROM idempotency_keys
            WHERE key = ? AND workspace_id = ? AND admin_user_id = ?
              AND action_result_id IS NULL`,
        ).run(key, row.workspace_id, row.admin_user_id);
        db.prepare(
          "UPDATE pending_confirmations SET idempotency_key = NULL WHERE id = ? AND idempotency_key = ?",
        ).run(id, key);
      })();
    },

    settleConfirmation(id, status, actionName, result) {
      const settle = db.transaction((): ActionResultRef => {
        const row = db.prepare(
          `SELECT operation_id, session_id, workspace_id, admin_user_id, idempotency_key,
                  action_result_id
             FROM pending_confirmations WHERE id = ? AND status = 'executing'`,
        ).get(id) as {
          operation_id: string;
          session_id: string;
          workspace_id: string;
          admin_user_id: string;
          idempotency_key: string | null;
          action_result_id: string | null;
        } | undefined;
        if (!row) throw new Error("confirmation_not_executing");
        if (!row.action_result_id) throw new Error("confirmation_result_not_found");
        const actionResultId = row.action_result_id;
        const canonicalResult = result && typeof result === "object" &&
          (result as { kind?: unknown }).kind === "partial"
          ? result
          : { kind: "receipt", receipt: result };
        const summary = buildActionResultSummary(actionResultId, canonicalResult);
        const settledAt = nowIso();
        const resultUpdate = db.prepare(
          `UPDATE action_results
              SET action_name = ?, kind = ?, result_json = ?, summary_json = ?, created_at = ?
            WHERE id = ? AND operation_id = ?`,
        ).run(
          actionName,
          status,
          actionResultJson(canonicalResult),
          actionResultJson(summary),
          settledAt,
          actionResultId,
          row.operation_id,
        );
        if (resultUpdate.changes !== 1) throw new Error("confirmation_result_not_found");
        const update = db.prepare(
          `UPDATE pending_confirmations
             SET status = ?, action_result_id = ?, result_summary_json = ?, nonce_hash = '',
                 agent_state_json = NULL, operation_json = NULL, idempotency_key = NULL
           WHERE id = ? AND status = 'executing'`,
        ).run(status, actionResultId, actionResultJson(summary), id);
        if (update.changes !== 1) throw new Error("confirmation_not_executing");
        const operationUpdate = db.prepare(
          `UPDATE operation_runs SET status = ?, action_result_id = ?, updated_at = ?
             WHERE id = (SELECT operation_id FROM pending_confirmations WHERE id = ?)
               AND status = 'executing' AND action_result_id = ?`,
        ).run(status, actionResultId, settledAt, id, actionResultId);
        if (operationUpdate.changes !== 1) throw new Error("operation_not_found");
        if (row.idempotency_key) {
          if (status === "definitive_failed") {
            db.prepare(
              `DELETE FROM idempotency_keys
                WHERE key = ? AND workspace_id = ? AND admin_user_id = ?
                  AND action_result_id IS NULL`,
            ).run(row.idempotency_key, row.workspace_id, row.admin_user_id);
          } else {
            const ledger = db.prepare(
              `UPDATE idempotency_keys
                  SET action_result_id = ?, result_summary_json = ?, committed_at = ?, claimed_at = ?
                WHERE key = ? AND workspace_id = ? AND admin_user_id = ?
                  AND action_result_id IS NULL`,
            ).run(
              actionResultId,
              actionResultJson(summary),
              now().getTime(),
              now().getTime(),
              row.idempotency_key,
              row.workspace_id,
              row.admin_user_id,
            );
            if (ledger.changes !== 1) throw new Error("idempotency_claim_not_owned");
          }
        }
        return { id: actionResultId, kind: status, summary };
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
      return db.transaction(() => {
        db.prepare(
          `UPDATE pending_confirmations
              SET status = 'expired', used_at = ?, nonce_hash = '',
                  agent_state_json = NULL, operation_json = NULL
            WHERE session_id = ? AND status = 'pending' AND expires_at <= ?`,
        ).run(nowIso, sessionId, nowIso);
        const row = db
          .prepare(
            "SELECT COUNT(*) AS n FROM pending_confirmations WHERE session_id = ? AND status = 'pending' AND expires_at > ?",
          )
          .get(sessionId, nowIso) as { n: number };
        return row.n;
      })();
    },
  };
}
