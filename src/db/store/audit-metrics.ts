import { randomUUID } from "node:crypto";
import type { ActionOutcome } from "../../metrics/metrics.js";
import type { AuditEventInput, StoreContext } from "./context.js";

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
export function actionOutcomesSql(bounded: boolean): string {
  return `SELECT action_name,
            json_extract(receipt_json, '$.ok') AS ok,
            json_extract(receipt_json, '$.code') AS code
          FROM audit_events
          WHERE workspace_id = ? AND admin_user_id = ?${bounded ? " AND created_at >= ?" : ""}`;
}

/** SQL for {@link Store.listConfirmationOutcomes}; same conditional-bound shape. */
export function confirmationOutcomesSql(bounded: boolean): string {
  return `SELECT status, expires_at FROM pending_confirmations
          WHERE workspace_id = ? AND admin_user_id = ?${bounded ? " AND created_at >= ?" : ""}`;
}

/** Audit + operational-metrics concern: the audit log and the two outcome reads. */
export function buildAuditMetricsStore(ctx: StoreContext): {
  addAuditEvent(input: AuditEventInput): void;
  listActionOutcomes(workspaceId: string, adminUserId: string, sinceIso?: string): ActionOutcome[];
  listConfirmationOutcomes(workspaceId: string, adminUserId: string, sinceIso?: string): string[];
} {
  const { db, now, nowIso } = ctx;
  return {
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
  };
}
