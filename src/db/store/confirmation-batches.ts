import { createHash, randomUUID } from "node:crypto";
import type {
  ConfirmationBatchItemRecord,
  ConfirmationBatchRecord,
  ConfirmationBatchItemStatus,
  ConfirmationBatchStatus,
  CreateConfirmationBatchInput,
  StoreContext,
} from "./context.js";

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

export function buildConfirmationBatchStore(ctx: StoreContext): {
  computeOrderedTupleHash: typeof computeOrderedTupleHash;
  createConfirmationBatch(input: CreateConfirmationBatchInput): ConfirmationBatchRecord;
  getConfirmationBatch(id: string): ConfirmationBatchRecord | undefined;
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
  expireConfirmationBatches(nowIso: string): number;
} {
  const { db, nowIso } = ctx;
  return {
    computeOrderedTupleHash,
    createConfirmationBatch(input) {
      const id = input.id ?? randomUUID();
      const timestamp = nowIso();
      const expectedHash = computeOrderedTupleHash(input.items);
      if (expectedHash !== input.orderedTupleHash) {
        throw new Error("ordered_tuple_hash_mismatch");
      }
      return db.transaction(() => {
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
          db.prepare(
            "UPDATE pending_confirmations SET batch_id = ? WHERE id = ?",
          ).run(id, item.confirmationId);
        });
        return toBatch(db.prepare("SELECT * FROM confirmation_batches WHERE id = ?").get(id) as BatchRow);
      })();
    },
    getConfirmationBatch(id) {
      const row = db.prepare("SELECT * FROM confirmation_batches WHERE id = ?").get(id) as BatchRow | undefined;
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
    expireConfirmationBatches(nowIsoArg) {
      return db.prepare(
        `UPDATE confirmation_batches
            SET status = 'expired', completed_at = COALESCE(completed_at, ?)
          WHERE status IN ('pending', 'executing') AND expires_at <= ?`,
      ).run(nowIsoArg, nowIsoArg).changes;
    },
  };
}
