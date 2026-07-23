import { randomUUID } from "node:crypto";
import type { StoreContext } from "./context.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CONFIRMATION_RETENTION_MS = 30 * DAY_MS;
const UNDO_RETENTION_MS = 30 * DAY_MS;
export const IDEMPOTENCY_RETENTION_MS = 60 * 60 * 1000;
const TELEMETRY_RETENTION_MS = 30 * DAY_MS;
const OPERATION_RETENTION_MS = 30 * DAY_MS;
const BATCH_SIZE = 500;
const MAX_ROWS_PER_PASS = 10_000;

export interface PruneCounts {
  pendingConfirmations: number;
  idempotencyKeys: number;
  undoRecords: number;
  turnTelemetry: number;
  chatMessages: number;
  auditEvents: number;
  artifacts: number;
  operationSteps: number;
  operationRuns: number;
  intentCapabilities: number;
  actionResults: number;
  turnRuns: number;
  assistantRuns: number;
  chatSessions: number;
  retentionRuns: number;
  expiredConfirmations: number;
  expiredConfirmationBatches: number;
  expiredUndoRecords: number;
  deletedTotal: number;
  expiredTotal: number;
  total: number;
  batches: number;
  durationMs: number;
  backlog: boolean;
  walCheckpoint: WalCheckpointMetrics;
}

export interface WalCheckpointMetrics {
  mode: "PASSIVE";
  busy: number;
  log: number;
  checkpointed: number;
}

export interface RetentionRunMetric {
  id: string;
  recordedAt: string;
  durationMs: number;
  deletedCount: number;
  expiredCount: number;
  batches: number;
  backlog: boolean;
  walCheckpoint: WalCheckpointMetrics;
  counts: Record<string, number>;
}

type PruneTable =
  | "pendingConfirmations"
  | "confirmationBatchItems"
  | "confirmationBatches"
  | "idempotencyKeys"
  | "undoRecords"
  | "turnTelemetry"
  | "chatMessages"
  | "auditEvents"
  | "artifacts"
  | "operationSteps"
  | "operationRuns"
  | "intentCapabilities"
  | "actionResults"
  | "turnRuns"
  | "assistantRuns"
  | "chatSessions"
  | "retentionRuns";

interface PruneDelete {
  readonly table: PruneTable;
  readonly cutoff: "iso" | "epoch";
  readonly sqls: readonly string[];
}

const batched = (table: string, predicate: string): string =>
  `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${predicate} LIMIT ?)`;

/** Ordered so child rows are removed before parent rows with foreign keys. */
const PRUNE_DELETES: readonly PruneDelete[] = [
  {
    table: "confirmationBatchItems",
    cutoff: "iso",
    sqls: [
      batched(
        "confirmation_batch_items",
        "batch_id IN (SELECT id FROM confirmation_batches WHERE status != 'pending' AND created_at < ?)",
      ),
      batched(
        "confirmation_batch_items",
        "batch_id IN (SELECT id FROM confirmation_batches WHERE status IN ('pending', 'executing') AND expires_at < ?)",
      ),
    ],
  },
  {
    table: "confirmationBatches",
    cutoff: "iso",
    sqls: [
      batched("confirmation_batches", "status != 'pending' AND created_at < ?"),
      batched("confirmation_batches", "status IN ('pending', 'executing') AND expires_at < ?"),
    ],
  },
  {
    table: "pendingConfirmations",
    cutoff: "iso",
    sqls: [
      batched("pending_confirmations", "status != 'pending' AND created_at < ?"),
      batched("pending_confirmations", "status = 'pending' AND expires_at < ?"),
    ],
  },
  {
    table: "idempotencyKeys",
    cutoff: "epoch",
    sqls: [
      batched("idempotency_keys", "committed_at IS NOT NULL AND committed_at < ?"),
      batched("idempotency_keys", "action_result_id IS NULL AND claimed_at < ?"),
    ],
  },
  {
    table: "undoRecords",
    cutoff: "iso",
    sqls: [
      batched("undo_records", "status IN ('partially_undone', 'undone', 'failed', 'outcome_unknown') AND undone_at < ?"),
      batched("undo_records", "status = 'expired' AND expires_at < ?"),
      batched("undo_records", "status = 'executing' AND created_at < ?"),
    ],
  },
  { table: "turnTelemetry", cutoff: "iso", sqls: [batched("turn_telemetry", "created_at < ?")] },
  { table: "chatMessages", cutoff: "iso", sqls: [batched("chat_messages", "created_at < ?")] },
  { table: "auditEvents", cutoff: "iso", sqls: [batched("audit_events", "created_at < ?")] },
  { table: "artifacts", cutoff: "iso", sqls: [batched("artifacts", "expires_at < ?")] },
  {
    table: "operationSteps",
    cutoff: "iso",
    sqls: [batched("operation_steps", "operation_id IN (SELECT id FROM operation_runs WHERE updated_at < ?)")],
  },
  {
    table: "operationRuns",
    cutoff: "iso",
    sqls: [batched("operation_runs", "updated_at < ? AND NOT EXISTS (SELECT 1 FROM operation_steps WHERE operation_id = operation_runs.id)")],
  },
  {
    table: "intentCapabilities",
    cutoff: "iso",
    sqls: [batched("intent_capabilities", `created_at < ?
      AND NOT EXISTS (SELECT 1 FROM operation_runs WHERE capability_id = intent_capabilities.id)
      AND NOT EXISTS (SELECT 1 FROM pending_confirmations WHERE capability_id = intent_capabilities.id)
      AND NOT EXISTS (SELECT 1 FROM intent_capability_usage WHERE capability_id = intent_capabilities.id)`)],
  },
  { table: "turnRuns", cutoff: "iso", sqls: [batched("turn_runs", "updated_at < ?")] },
  { table: "assistantRuns", cutoff: "iso", sqls: [batched("assistant_runs", "updated_at < ?")] },
  {
    table: "actionResults",
    cutoff: "iso",
    sqls: [batched("action_results", `created_at < ?
      AND NOT EXISTS (SELECT 1 FROM pending_confirmations WHERE action_result_id = action_results.id)
      AND NOT EXISTS (SELECT 1 FROM confirmation_batches WHERE action_result_id = action_results.id)
      AND NOT EXISTS (SELECT 1 FROM confirmation_batch_items WHERE action_result_id = action_results.id)
      AND NOT EXISTS (SELECT 1 FROM audit_events WHERE action_result_id = action_results.id)
      AND NOT EXISTS (SELECT 1 FROM undo_records WHERE action_result_id = action_results.id)
      AND NOT EXISTS (SELECT 1 FROM idempotency_keys WHERE action_result_id = action_results.id)
      AND NOT EXISTS (SELECT 1 FROM operation_runs WHERE action_result_id = action_results.id)
      AND NOT EXISTS (SELECT 1 FROM chat_message_result_links WHERE action_result_id = action_results.id)
      AND NOT EXISTS (SELECT 1 FROM turn_run_result_links WHERE action_result_id = action_results.id)`)],
  },
  {
    table: "chatSessions",
    cutoff: "iso",
    sqls: [batched("chat_sessions", `expires_at < ?
      AND NOT EXISTS (SELECT 1 FROM chat_messages WHERE session_id = chat_sessions.id)
      AND NOT EXISTS (SELECT 1 FROM pending_confirmations WHERE session_id = chat_sessions.id)
      AND NOT EXISTS (SELECT 1 FROM confirmation_batches WHERE session_id = chat_sessions.id)
      AND NOT EXISTS (SELECT 1 FROM undo_records WHERE session_id = chat_sessions.id)
      AND NOT EXISTS (SELECT 1 FROM turn_telemetry WHERE session_id = chat_sessions.id)
      AND NOT EXISTS (SELECT 1 FROM turn_runs WHERE session_id = chat_sessions.id)
      AND NOT EXISTS (SELECT 1 FROM operation_runs WHERE session_id = chat_sessions.id)
      AND NOT EXISTS (SELECT 1 FROM action_results WHERE session_id = chat_sessions.id)
      AND NOT EXISTS (SELECT 1 FROM artifacts WHERE session_id = chat_sessions.id)`)],
  },
  { table: "retentionRuns", cutoff: "iso", sqls: [batched("retention_runs", "recorded_at < ?")] },
];

export interface RetentionStoreOptions {
  chatAuditRetentionMs: number;
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function buildRetentionStore(
  ctx: StoreContext,
  { chatAuditRetentionMs }: RetentionStoreOptions,
): {
  pruneExpired(nowIso: string): Promise<PruneCounts>;
  explainPrunePlan(): Record<PruneTable, string>;
  retentionMetricsForTest(): RetentionRunMetric[];
} {
  const { db } = ctx;
  return {
    async pruneExpired(nowIsoArg) {
      const started = Date.now();
      const nowMs = Date.parse(nowIsoArg);
      const isoCutoff = (windowMs: number): string => new Date(nowMs - windowMs).toISOString();
      const operationCutoff = isoCutoff(OPERATION_RETENTION_MS);
      const cutoffByTable: Record<PruneTable, string | number> = {
        pendingConfirmations: isoCutoff(CONFIRMATION_RETENTION_MS),
        confirmationBatchItems: isoCutoff(CONFIRMATION_RETENTION_MS),
        confirmationBatches: isoCutoff(CONFIRMATION_RETENTION_MS),
        idempotencyKeys: nowMs - IDEMPOTENCY_RETENTION_MS,
        undoRecords: isoCutoff(UNDO_RETENTION_MS),
        turnTelemetry: isoCutoff(TELEMETRY_RETENTION_MS),
        chatMessages: isoCutoff(chatAuditRetentionMs),
        auditEvents: isoCutoff(chatAuditRetentionMs),
        artifacts: nowIsoArg,
        operationSteps: operationCutoff,
        operationRuns: operationCutoff,
        intentCapabilities: operationCutoff,
        actionResults: isoCutoff(chatAuditRetentionMs),
        turnRuns: isoCutoff(chatAuditRetentionMs),
        assistantRuns: isoCutoff(chatAuditRetentionMs),
        chatSessions: nowIsoArg,
        retentionRuns: isoCutoff(chatAuditRetentionMs),
      };
      const counts: Record<PruneTable, number> = {
        pendingConfirmations: 0,
        confirmationBatchItems: 0,
        confirmationBatches: 0,
        idempotencyKeys: 0,
        undoRecords: 0,
        turnTelemetry: 0,
        chatMessages: 0,
        auditEvents: 0,
        artifacts: 0,
        operationSteps: 0,
        operationRuns: 0,
        intentCapabilities: 0,
        actionResults: 0,
        turnRuns: 0,
        assistantRuns: 0,
        chatSessions: 0,
        retentionRuns: 0,
      };
      let total = 0;
      let expiredConfirmations = 0;
      let expiredConfirmationBatches = 0;
      let expiredUndoRecords = 0;
      let batches = 0;
      let changed = true;

      // The helper is deliberately the only retention mutation primitive: one
      // bounded statement is committed per transaction, then the event loop is
      // yielded before any later statement begins.
      const runMutation = async (sql: string, params: readonly unknown[]): Promise<number> => {
        const changes = db.transaction(() => db.prepare(sql).run(...params).changes)();
        batches += 1;
        await yieldToEventLoop();
        return changes;
      };
      const expireConfirmations = `UPDATE pending_confirmations
        SET status = 'expired', used_at = ?, nonce_hash = '',
            risk_json = '[]', preview_json = '{}', target_fingerprints_json = '[]',
            agent_state_json = NULL, operation_json = NULL
        WHERE rowid IN (
          SELECT rowid FROM pending_confirmations
           WHERE status = 'pending' AND expires_at <= ? LIMIT ?
        )`;
      const expireConfirmationBatches = `UPDATE confirmation_batches
        SET status = 'expired', completed_at = COALESCE(completed_at, ?)
        WHERE rowid IN (
          SELECT rowid FROM confirmation_batches
           WHERE status IN ('pending', 'executing') AND expires_at <= ? LIMIT ?
        )`;
      const expireUndo = `UPDATE undo_records
        SET status = 'expired', reversal_json = '[]', remaining_json = '[]'
        WHERE rowid IN (
          SELECT rowid FROM undo_records
           WHERE status = 'available' AND expires_at <= ? LIMIT ?
        )`;

      while (changed && total < MAX_ROWS_PER_PASS) {
        changed = false;
        let limit = Math.min(BATCH_SIZE, MAX_ROWS_PER_PASS - total);
        const confirmationChanges = await runMutation(
          expireConfirmations,
          [nowIsoArg, nowIsoArg, limit],
        );
        expiredConfirmations += confirmationChanges;
        total += confirmationChanges;
        changed ||= confirmationChanges > 0;

        if (total < MAX_ROWS_PER_PASS) {
          limit = Math.min(BATCH_SIZE, MAX_ROWS_PER_PASS - total);
          const batchChanges = await runMutation(
            expireConfirmationBatches,
            [nowIsoArg, nowIsoArg, limit],
          );
          expiredConfirmationBatches += batchChanges;
          total += batchChanges;
          changed ||= batchChanges > 0;
        }

        if (total < MAX_ROWS_PER_PASS) {
          limit = Math.min(BATCH_SIZE, MAX_ROWS_PER_PASS - total);
          const undoChanges = await runMutation(expireUndo, [nowIsoArg, limit]);
          expiredUndoRecords += undoChanges;
          total += undoChanges;
          changed ||= undoChanges > 0;
        }

        for (const { table, sqls } of PRUNE_DELETES) {
          for (const sql of sqls) {
            if (total >= MAX_ROWS_PER_PASS) break;
            limit = Math.min(BATCH_SIZE, MAX_ROWS_PER_PASS - total);
            const deleted = await runMutation(sql, [cutoffByTable[table], limit]);
            counts[table] += deleted;
            total += deleted;
            changed ||= deleted > 0;
          }
          if (total >= MAX_ROWS_PER_PASS) break;
        }
      }
      const deletedTotal = Object.values(counts).reduce((sum, count) => sum + count, 0);
      const expiredTotal = expiredConfirmations + expiredConfirmationBatches + expiredUndoRecords;
      const backlog = total >= MAX_ROWS_PER_PASS;
      const checkpointRow = (db.pragma("wal_checkpoint(PASSIVE)") as Array<{
        busy: number;
        log: number;
        checkpointed: number;
      }>)[0];
      const walCheckpoint: WalCheckpointMetrics = {
        mode: "PASSIVE",
        busy: checkpointRow?.busy ?? 0,
        log: checkpointRow?.log ?? -1,
        checkpointed: checkpointRow?.checkpointed ?? -1,
      };
      const durationMs = Date.now() - started;
      const result: PruneCounts = {
        ...counts,
        expiredConfirmations,
        expiredConfirmationBatches,
        expiredUndoRecords,
        deletedTotal,
        expiredTotal,
        total,
        batches,
        durationMs,
        backlog,
        walCheckpoint,
      };
      await runMutation(
        `INSERT INTO retention_runs (
           id, recorded_at, duration_ms, deleted_count, expired_count, batches,
           backlog, wal_busy, wal_log, wal_checkpointed, counts_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          nowIsoArg,
          durationMs,
          deletedTotal,
          expiredTotal,
          batches,
          backlog ? 1 : 0,
          walCheckpoint.busy,
          walCheckpoint.log,
          walCheckpoint.checkpointed,
          JSON.stringify({ ...counts, expiredConfirmations, expiredUndoRecords }),
        ],
      );
      return result;
    },

    explainPrunePlan() {
      const plan = {} as Record<PruneTable, string>;
      for (const { table, cutoff, sqls } of PRUNE_DELETES) {
        const param: string | number = cutoff === "epoch" ? 0 : "x";
        plan[table] = sqls.map((sql) =>
          (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(param, BATCH_SIZE) as Array<{ detail: string }>)
            .map((row) => row.detail)
            .join(" | "),
        ).join(" | ");
      }
      return plan;
    },

    retentionMetricsForTest() {
      const rows = db.prepare("SELECT * FROM retention_runs ORDER BY recorded_at, rowid").all() as Array<{
        id: string;
        recorded_at: string;
        duration_ms: number;
        deleted_count: number;
        expired_count: number;
        batches: number;
        backlog: number;
        wal_busy: number;
        wal_log: number;
        wal_checkpointed: number;
        counts_json: string;
      }>;
      return rows.map((row) => ({
        id: row.id,
        recordedAt: row.recorded_at,
        durationMs: row.duration_ms,
        deletedCount: row.deleted_count,
        expiredCount: row.expired_count,
        batches: row.batches,
        backlog: row.backlog === 1,
        walCheckpoint: {
          mode: "PASSIVE",
          busy: row.wal_busy,
          log: row.wal_log,
          checkpointed: row.wal_checkpointed,
        },
        counts: JSON.parse(row.counts_json) as Record<string, number>,
      }));
    },
  };
}
