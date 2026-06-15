import { randomUUID } from "node:crypto";
import type { EntityRef } from "../../harness/receipts.js";
import type { UndoRecord, UndoRecordInput, StoreContext } from "./context.js";

/** Undo ledger concern (Phase 5b): a reversible action and its one-use status. */
export function buildUndoStore(ctx: StoreContext): {
  recordUndoable(input: UndoRecordInput): string;
  getUndoRecord(id: string): UndoRecord | undefined;
  markUndone(id: string): boolean;
} {
  const { db, nowIso } = ctx;
  return {
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
  };
}
