import { createHash, randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import type {
  ConfirmationBatchItemRecord,
  ConfirmationBatchRecord,
  ConfirmationBatchItemStatus,
  ConfirmationBatchStatus,
  CreateConfirmationBatchInput,
  StoreContext,
} from "./context.js";
import { actionResultJson, buildActionResultSummary } from "../action-results.js";

interface BatchRow {
  id: string;
  session_id: string;
  run_id: string;
  workspace_id: string;
  admin_user_id: string;
  ordered_tuple_hash: string;
  status: ConfirmationBatchStatus;
  current_index: number;
  action_result_id: string | null;
  expires_at: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface BatchItemRow {
  batch_id: string;
  item_index: number;
  session_id: string;
  run_id: string;
  workspace_id: string;
  admin_user_id: string;
  confirmation_id: string;
  operation_id: string;
  status: ConfirmationBatchItemStatus;
  action_result_id: string | null;
  started_at: string | null;
  completed_at: string | null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeOrderedTupleHash(
  items: ReadonlyArray<{ confirmationId: string; operationId: string }>,
): string {
  return createHash("sha256").update(
    canonicalJson(items.map(({ confirmationId, operationId }) => ({
      confirmationId,
      operationId,
    }))),
  ).digest("hex");
}

function toBatch(row: BatchRow): ConfirmationBatchRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    adminUserId: row.admin_user_id,
    orderedTupleHash: row.ordered_tuple_hash,
    status: row.status,
    currentIndex: row.current_index,
    ...(row.action_result_id ? { actionResultId: row.action_result_id } : {}),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

function toBatchItem(row: BatchItemRow): ConfirmationBatchItemRecord {
  return {
    batchId: row.batch_id,
    itemIndex: row.item_index,
    sessionId: row.session_id,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    adminUserId: row.admin_user_id,
    confirmationId: row.confirmation_id,
    operationId: row.operation_id,
    status: row.status,
    ...(row.action_result_id ? { actionResultId: row.action_result_id } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

function operationWasDispatched(db: Database, operationId: string): boolean {
  return (db.prepare(
    `SELECT 1 FROM operation_steps
      WHERE operation_id = ? AND dispatched_at IS NOT NULL LIMIT 1`,
  ).get(operationId) as { 1: number } | undefined) !== undefined;
}

function insertConfirmationBatchRows(
  db: Database,
  input: CreateConfirmationBatchInput,
  id: string,
  timestamp: string,
): ConfirmationBatchRecord {
  const expectedHash = computeOrderedTupleHash(input.items);
  if (expectedHash !== input.orderedTupleHash) {
    throw new Error("ordered_tuple_hash_mismatch");
  }
  db.prepare(
    `INSERT INTO confirmation_batches (
       id, session_id, run_id, workspace_id, admin_user_id, ordered_tuple_hash,
       status, current_index, action_result_id, expires_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)`,
  ).run(
    id,
    input.sessionId,
    input.runId,
    input.workspaceId,
    input.adminUserId,
    input.orderedTupleHash,
    input.expiresAt,
    timestamp,
  );
  const insertItem = db.prepare(
    `INSERT INTO confirmation_batch_items (
       batch_id, item_index, session_id, run_id, workspace_id, admin_user_id,
       confirmation_id, operation_id, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
  );
  const setConfirmationBatch = db.prepare(
    "UPDATE pending_confirmations SET batch_id = ? WHERE id = ?",
  );
  const setOperationBatch = db.prepare(
    "UPDATE operation_runs SET batch_id = ? WHERE id = ?",
  );
  input.items.forEach((item, itemIndex) => {
    insertItem.run(
      id,
      itemIndex,
      input.sessionId,
      input.runId,
      input.workspaceId,
      input.adminUserId,
      item.confirmationId,
      item.operationId,
    );
    setConfirmationBatch.run(id, item.confirmationId);
    setOperationBatch.run(id, item.operationId);
  });
  return toBatch(db.prepare("SELECT * FROM confirmation_batches WHERE id = ?").get(id) as BatchRow);
}

export function buildConfirmationBatchStore(ctx: StoreContext): {
  computeOrderedTupleHash: typeof computeOrderedTupleHash;
  createConfirmationBatch(input: CreateConfirmationBatchInput): ConfirmationBatchRecord;
  insertConfirmationBatch(input: CreateConfirmationBatchInput): ConfirmationBatchRecord;
  getConfirmationBatch(id: string): ConfirmationBatchRecord | undefined;
  getScopedConfirmationBatch(
    id: string,
    workspaceId: string,
    adminUserId: string,
    sessionId: string,
  ): ConfirmationBatchRecord | undefined;
  listConfirmationBatchItems(batchId: string): ConfirmationBatchItemRecord[];
  updateConfirmationBatchStatus(
    id: string,
    status: ConfirmationBatchStatus,
    patch?: {
      currentIndex?: number;
      actionResultId?: string;
      startedAt?: string;
      completedAt?: string;
    },
  ): boolean;
  updateConfirmationBatchItemStatus(
    batchId: string,
    itemIndex: number,
    status: ConfirmationBatchItemStatus,
    patch?: { actionResultId?: string; startedAt?: string; completedAt?: string },
  ): boolean;
  markConfirmationBatchExecuting(batchId: string): boolean;
  advanceConfirmationBatchProgress(
    batchId: string,
    nextIndex: number,
    timestamp: string,
  ): boolean;
  cancelUndispatchedBatchItems(batchId: string, fromIndex: number, timestamp: string): number;
  recoverConfirmationBatch(batchId: string, nowIsoArg: string): void;
} {
  const { db, nowIso } = ctx;
  return {
    computeOrderedTupleHash,
    createConfirmationBatch(input) {
      const id = input.id ?? randomUUID();
      const timestamp = nowIso();
      return db.transaction(() => insertConfirmationBatchRows(db, input, id, timestamp))();
    },
    insertConfirmationBatch(input) {
      const id = input.id ?? randomUUID();
      return insertConfirmationBatchRows(db, input, id, nowIso());
    },
    getConfirmationBatch(id) {
      const row = db.prepare("SELECT * FROM confirmation_batches WHERE id = ?").get(id) as BatchRow | undefined;
      return row ? toBatch(row) : undefined;
    },
    getScopedConfirmationBatch(id, workspaceId, adminUserId, sessionId) {
      const row = db.prepare(
        `SELECT * FROM confirmation_batches
          WHERE id = ? AND workspace_id = ? AND admin_user_id = ? AND session_id = ?`,
      ).get(id, workspaceId, adminUserId, sessionId) as BatchRow | undefined;
      return row ? toBatch(row) : undefined;
    },
    listConfirmationBatchItems(batchId) {
      const rows = db.prepare(
        `SELECT * FROM confirmation_batch_items
          WHERE batch_id = ?
          ORDER BY item_index ASC`,
      ).all(batchId) as BatchItemRow[];
      return rows.map(toBatchItem);
    },
    updateConfirmationBatchStatus(id, status, patch = {}) {
      return db.prepare(
        `UPDATE confirmation_batches
            SET status = ?,
                current_index = COALESCE(?, current_index),
                action_result_id = COALESCE(?, action_result_id),
                started_at = COALESCE(?, started_at),
                completed_at = COALESCE(?, completed_at)
          WHERE id = ?`,
      ).run(
        status,
        patch.currentIndex ?? null,
        patch.actionResultId ?? null,
        patch.startedAt ?? null,
        patch.completedAt ?? null,
        id,
      ).changes === 1;
    },
    updateConfirmationBatchItemStatus(batchId, itemIndex, status, patch = {}) {
      return db.prepare(
        `UPDATE confirmation_batch_items
            SET status = ?,
                action_result_id = COALESCE(?, action_result_id),
                started_at = COALESCE(?, started_at),
                completed_at = COALESCE(?, completed_at)
          WHERE batch_id = ? AND item_index = ?`,
      ).run(
        status,
        patch.actionResultId ?? null,
        patch.startedAt ?? null,
        patch.completedAt ?? null,
        batchId,
        itemIndex,
      ).changes === 1;
    },
    markConfirmationBatchExecuting(batchId) {
      const timestamp = nowIso();
      return db.prepare(
        `UPDATE confirmation_batches
            SET status = 'executing', started_at = COALESCE(started_at, ?)
          WHERE id = ? AND status = 'pending'`,
      ).run(timestamp, batchId).changes === 1;
    },
    advanceConfirmationBatchProgress(batchId, nextIndex, _timestamp) {
      return db.prepare(
        `UPDATE confirmation_batches
            SET current_index = ?
          WHERE id = ? AND status = 'executing'`,
      ).run(nextIndex, batchId).changes === 1;
    },
    cancelUndispatchedBatchItems(batchId, fromIndex, timestamp) {
      return db.transaction(() => {
        const items = db.prepare(
          `SELECT item_index, confirmation_id, operation_id
             FROM confirmation_batch_items
            WHERE batch_id = ? AND item_index >= ? AND status = 'pending'
            ORDER BY item_index ASC`,
        ).all(batchId, fromIndex) as Array<{
          item_index: number;
          confirmation_id: string;
          operation_id: string;
        }>;
        let cancelled = 0;
        for (const item of items) {
          db.prepare(
            `UPDATE confirmation_batch_items
                SET status = 'cancelled', completed_at = ?
              WHERE batch_id = ? AND item_index = ? AND status = 'pending'`,
          ).run(timestamp, batchId, item.item_index);
          db.prepare(
            `UPDATE pending_confirmations
                SET status = 'cancelled', used_at = ?, nonce_hash = '',
                    risk_json = '[]', preview_json = '{}', target_fingerprints_json = '[]',
                    agent_state_json = NULL, operation_json = NULL, idempotency_key = NULL
              WHERE id = ? AND status = 'pending'`,
          ).run(timestamp, item.confirmation_id);
          db.prepare(
            `UPDATE operation_runs
                SET status = 'definitive_failed', updated_at = ?
              WHERE id = ? AND status = 'prepared'`,
          ).run(timestamp, item.operation_id);
          cancelled += 1;
        }
        return cancelled;
      })();
    },
    recoverConfirmationBatch(batchId, nowIsoArg) {
      db.transaction(() => {
        const batchRow = db.prepare(
          "SELECT * FROM confirmation_batches WHERE id = ?",
        ).get(batchId) as BatchRow | undefined;
        if (!batchRow || batchRow.status !== "executing") return;

        const items = db.prepare(
          `SELECT * FROM confirmation_batch_items
            WHERE batch_id = ?
            ORDER BY item_index ASC`,
        ).all(batchId) as BatchItemRow[];

        const startedItems = items.filter((item) => item.status !== "pending");
        if (batchRow.current_index === 0 && startedItems.length === 0) {
          const expiresAt = new Date(batchRow.expires_at).getTime();
          if (!Number.isNaN(expiresAt) && expiresAt > Date.parse(nowIsoArg)) {
            db.prepare(
              `UPDATE confirmation_batches
                  SET status = 'pending', started_at = NULL
                WHERE id = ? AND status = 'executing'`,
            ).run(batchId);
          }
          return;
        }

        for (const item of items.filter((row) => row.status === "executing")) {
          if (operationWasDispatched(db, item.operation_id)) {
            db.prepare(
              `UPDATE confirmation_batches
                  SET status = 'outcome_unknown',
                      completed_at = COALESCE(completed_at, ?)
                WHERE id = ?`,
            ).run(nowIsoArg, batchId);
            const cancelFrom = item.item_index;
            for (const pending of items.filter((row) =>
              row.item_index >= cancelFrom && row.status === "pending")) {
              db.prepare(
                `UPDATE confirmation_batch_items
                    SET status = 'cancelled', completed_at = ?
                  WHERE batch_id = ? AND item_index = ? AND status = 'pending'`,
              ).run(nowIsoArg, batchId, pending.item_index);
              db.prepare(
                `UPDATE pending_confirmations
                    SET status = 'cancelled', used_at = ?, nonce_hash = '',
                        risk_json = '[]', preview_json = '{}', target_fingerprints_json = '[]',
                        agent_state_json = NULL, operation_json = NULL, idempotency_key = NULL
                  WHERE id = ? AND status = 'pending'`,
              ).run(nowIsoArg, pending.confirmation_id);
            }
            return;
          }

          const actionResultId = randomUUID();
          const result = {
            kind: "receipt",
            receipt: {
              ok: false,
              action: "unknown_action",
              code: "operation_cancelled_before_dispatch",
              message: "The server restarted before this queued action reached Clockify. No change was made.",
              // `ErrorReceipt.recovery` is a RecoveryHint object, and the UI
              // protocol decoder requires `recovery.retryable` to be a boolean
              // (`src/ui/protocol.ts`). A bare string here meant the one result
              // an admin most needs after a restart could not be decoded or
              // rendered at all.
              recovery: {
                hint: "Create a fresh request when the service is available.",
                retryable: false,
              },
            },
          };
          const summary = buildActionResultSummary(actionResultId, result);
          db.prepare(
            `INSERT INTO action_results (
               id, operation_id, workspace_id, admin_user_id, session_id, action_name, kind,
               result_json, summary_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'definitive_failed', ?, ?, ?)`,
          ).run(
            actionResultId,
            item.operation_id,
            item.workspace_id,
            item.admin_user_id,
            item.session_id,
            "unknown_action",
            actionResultJson(result),
            actionResultJson(summary),
            nowIsoArg,
          );
          db.prepare(
            `UPDATE confirmation_batch_items
                SET status = 'definitive_failed', action_result_id = ?, completed_at = ?
              WHERE batch_id = ? AND item_index = ? AND status = 'executing'`,
          ).run(actionResultId, nowIsoArg, batchId, item.item_index);
          db.prepare(
            `UPDATE pending_confirmations
                SET status = 'definitive_failed', action_result_id = ?,
                    result_summary_json = ?, nonce_hash = '', operation_json = NULL,
                    agent_state_json = NULL, idempotency_key = NULL, used_at = ?
              WHERE id = ? AND status = 'executing'`,
          ).run(actionResultId, actionResultJson(summary), nowIsoArg, item.confirmation_id);
          db.prepare(
            `UPDATE operation_runs
                SET status = 'definitive_failed', action_result_id = ?, updated_at = ?
              WHERE id = ? AND status = 'executing'`,
          ).run(actionResultId, nowIsoArg, item.operation_id);
        }
      })();
    },
  };
}
