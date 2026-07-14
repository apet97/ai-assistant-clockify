import { randomUUID } from "node:crypto";
import type { EntityRef } from "../../harness/receipts.js";
import type { UndoRecord, UndoRecordInput, StoreContext } from "./context.js";

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
  ): void;
} {
  const { db, now, nowIso } = ctx;
  return {
    recordUndoable(input) {
      const id = randomUUID();
      const createdAt = nowIso();
      const expiresAt = new Date(now().getTime() + UNDO_TTL_MS).toISOString();
      db.prepare(
        `INSERT INTO undo_records
          (id, session_id, workspace_id, admin_user_id, action_name, reversal_json, remaining_json, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'available', ?, ?)`,
      ).run(
        id,
        input.sessionId,
        input.workspaceId,
        input.adminUserId,
        input.actionName,
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
            reversal_json: string;
            remaining_json: string;
            status: UndoRecord["status"];
            created_at: string;
            expires_at: string;
            undone_at: string | null;
          }
        | undefined;
      if (!row) return undefined;
      if (row.status === "available" && new Date(row.expires_at).getTime() <= now().getTime()) {
        db.prepare("UPDATE undo_records SET status = 'expired', remaining_json = '[]' WHERE id = ? AND status = 'available'").run(id);
        row.status = "expired";
        row.remaining_json = "[]";
      }
      return {
        id: row.id,
        sessionId: row.session_id,
        workspaceId: row.workspace_id,
        adminUserId: row.admin_user_id,
        actionName: row.action_name,
        reversal: JSON.parse(row.reversal_json) as EntityRef[],
        remaining: JSON.parse(row.remaining_json) as EntityRef[],
        status: row.status,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        undoneAt: row.undone_at ?? undefined,
      };
    },

    markUndoExecuting(id) {
      const info = db
        .prepare("UPDATE undo_records SET status = 'executing' WHERE id = ? AND status = 'available' AND expires_at > ?")
        .run(id, nowIso());
      return info.changes > 0;
    },

    settleUndo(id, status, remaining, result) {
      db.prepare(
        `UPDATE undo_records
         SET status = ?, remaining_json = ?, result_json = ?, undone_at = ?
         WHERE id = ? AND status = 'executing'`,
      ).run(status, JSON.stringify(remaining), JSON.stringify(result), nowIso(), id);
    },
  };
}
