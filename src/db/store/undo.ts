import { randomUUID } from "node:crypto";
import type { EntityRef } from "../../harness/receipts.js";
import type { UndoRecord, UndoRecordInput, StoreContext } from "./context.js";
import { actionResultJson, buildActionResultSummary, type ActionResultKind, type ActionResultRef } from "../action-results.js";

const UNDO_TTL_MS = 30 * 60 * 1000;

/** Undo ledger concern (Phase 5b): a reversible action and its one-use status. */
export function buildUndoStore(ctx: StoreContext): {
  recordUndoable(input: UndoRecordInput): string;
  getUndoRecord(id: string): UndoRecord | undefined;
  markUndoExecuting(id: string): boolean;
  settleUndo(
    id: string,
    status: "partially_undone" | "undone" | "failed" | "outcome_unknown",
    remaining: EntityRef[],
    result: unknown,
  ): ActionResultRef;
  settleUndoOperation(
    id: string,
    operationId: string,
    status: "partially_undone" | "undone" | "failed" | "outcome_unknown",
    remaining: EntityRef[],
    result: unknown,
  ): ActionResultRef;
} {
  const { db, now, nowIso } = ctx;
  return {
    recordUndoable(input) {
      const id = randomUUID();
      const createdAt = nowIso();
      const expiresAt = new Date(now().getTime() + UNDO_TTL_MS).toISOString();
      db.prepare(
        `INSERT INTO undo_records
          (id, session_id, workspace_id, admin_user_id, action_name, installation_generation,
           reversal_json, remaining_json, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?)`,
      ).run(
        id,
        input.sessionId,
        input.workspaceId,
        input.adminUserId,
        input.actionName,
        input.installationGeneration ?? null,
        JSON.stringify(input.reversal),
        JSON.stringify(input.reversal),
        createdAt,
        expiresAt,
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
            installation_generation: number | null;
            reversal_json: string;
            remaining_json: string;
            status: UndoRecord["status"];
            created_at: string;
            expires_at: string;
            undone_at: string | null;
            action_result_id: string | null;
          }
        | undefined;
      if (!row) return undefined;
      if (row.status === "available" && new Date(row.expires_at).getTime() <= now().getTime()) {
        db.prepare(
          "UPDATE undo_records SET status = 'expired', reversal_json = '[]', remaining_json = '[]' WHERE id = ? AND status = 'available'",
        ).run(id);
        row.status = "expired";
        row.reversal_json = "[]";
        row.remaining_json = "[]";
      }
      return {
        id: row.id,
        sessionId: row.session_id,
        workspaceId: row.workspace_id,
        adminUserId: row.admin_user_id,
        actionName: row.action_name,
        ...(row.installation_generation === null
          ? {}
          : { installationGeneration: row.installation_generation }),
        reversal: JSON.parse(row.reversal_json) as EntityRef[],
        remaining: JSON.parse(row.remaining_json) as EntityRef[],
        status: row.status,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        undoneAt: row.undone_at ?? undefined,
        actionResultId: row.action_result_id ?? undefined,
      };
    },

    markUndoExecuting(id) {
      const info = db
        .prepare("UPDATE undo_records SET status = 'executing' WHERE id = ? AND status = 'available' AND expires_at > ?")
        .run(id, nowIso());
      return info.changes > 0;
    },

    settleUndo(id, status, remaining, result) {
      return db.transaction((): ActionResultRef => {
        const row = db.prepare(
          "SELECT session_id, workspace_id, admin_user_id FROM undo_records WHERE id = ? AND status = 'executing'",
        ).get(id) as { session_id: string; workspace_id: string; admin_user_id: string } | undefined;
        if (!row) throw new Error("undo_not_executing");
        const kind: ActionResultKind = status === "partially_undone"
          ? "partial"
          : status === "undone"
            ? "succeeded"
            : status === "outcome_unknown"
              ? "outcome_unknown"
              : "definitive_failed";
        const actionResultId = randomUUID();
        const canonicalResult = { kind: "receipt", receipt: result };
        const summary = buildActionResultSummary(actionResultId, canonicalResult);
        db.prepare(
          `INSERT INTO action_results (
             id, workspace_id, admin_user_id, session_id, action_name, kind,
             result_json, summary_json, created_at
           ) VALUES (?, ?, ?, ?, 'undo', ?, ?, ?, ?)`,
        ).run(
          actionResultId,
          row.workspace_id,
          row.admin_user_id,
          row.session_id,
          kind,
          actionResultJson(canonicalResult),
          actionResultJson(summary),
          nowIso(),
        );
        const update = db.prepare(
          `UPDATE undo_records
              SET status = ?, remaining_json = ?, action_result_id = ?,
                  result_summary_json = ?, undone_at = ?
            WHERE id = ? AND status = 'executing'`,
        ).run(status, JSON.stringify(remaining), actionResultId, actionResultJson(summary), nowIso(), id);
        if (update.changes !== 1) throw new Error("undo_not_executing");
        return { id: actionResultId, kind, summary };
      })();
    },

    settleUndoOperation(id, operationId, status, remaining, result) {
      return db.transaction((): ActionResultRef => {
        const owner = db.prepare(
          `SELECT u.session_id, u.workspace_id, u.admin_user_id, o.action_name
             FROM undo_records u
             JOIN operation_runs o
               ON o.id = ?
              AND o.session_id = u.session_id
              AND o.workspace_id = u.workspace_id
              AND o.admin_user_id = u.admin_user_id
            WHERE u.id = ? AND u.status = 'executing'
              AND o.action_name = 'undo'
              AND o.status = 'executing' AND o.action_result_id IS NULL`,
        ).get(operationId, id) as {
          session_id: string;
          workspace_id: string;
          admin_user_id: string;
          action_name: string;
        } | undefined;
        if (!owner) throw new Error("undo_operation_not_executing");
        const kind: ActionResultKind = status === "partially_undone"
          ? "partial"
          : status === "undone"
            ? "succeeded"
            : status === "outcome_unknown"
              ? "outcome_unknown"
              : "definitive_failed";
        const actionResultId = randomUUID();
        const canonicalResult = { kind: "receipt", receipt: result };
        const summary = buildActionResultSummary(actionResultId, canonicalResult);
        db.prepare(
          `INSERT INTO action_results (
             id, operation_id, workspace_id, admin_user_id, session_id, action_name, kind,
             result_json, summary_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          actionResultId,
          operationId,
          owner.workspace_id,
          owner.admin_user_id,
          owner.session_id,
          owner.action_name,
          kind,
          actionResultJson(canonicalResult),
          actionResultJson(summary),
          nowIso(),
        );
        const undo = db.prepare(
          `UPDATE undo_records
              SET status = ?, remaining_json = ?, action_result_id = ?,
                  result_summary_json = ?, undone_at = ?
            WHERE id = ? AND status = 'executing'`,
        ).run(status, JSON.stringify(remaining), actionResultId, actionResultJson(summary), nowIso(), id);
        if (undo.changes !== 1) throw new Error("undo_not_executing");
        const operation = db.prepare(
          `UPDATE operation_runs
              SET status = ?, action_result_id = ?, updated_at = ?
            WHERE id = ? AND status = 'executing' AND action_result_id IS NULL`,
        ).run(kind, actionResultId, nowIso(), operationId);
        if (operation.changes !== 1) throw new Error("operation_not_executing");
        return { id: actionResultId, kind, summary };
      })();
    },
  };
}
