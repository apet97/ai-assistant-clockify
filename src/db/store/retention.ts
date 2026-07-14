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
  actionResults: number;
  turnRuns: number;
  chatSessions: number;
  total: number;
  batches: number;
  durationMs: number;
  backlog: boolean;
}

type PruneTable = Exclude<keyof PruneCounts, "total" | "batches" | "durationMs" | "backlog">;

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
  { table: "turnRuns", cutoff: "iso", sqls: [batched("turn_runs", "updated_at < ?")] },
  {
    table: "actionResults",
    cutoff: "iso",
    sqls: [batched("action_results", `created_at < ?
      AND NOT EXISTS (SELECT 1 FROM pending_confirmations WHERE action_result_id = action_results.id)
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
      AND NOT EXISTS (SELECT 1 FROM undo_records WHERE session_id = chat_sessions.id)
      AND NOT EXISTS (SELECT 1 FROM turn_telemetry WHERE session_id = chat_sessions.id)
      AND NOT EXISTS (SELECT 1 FROM turn_runs WHERE session_id = chat_sessions.id)
      AND NOT EXISTS (SELECT 1 FROM operation_runs WHERE session_id = chat_sessions.id)
      AND NOT EXISTS (SELECT 1 FROM action_results WHERE session_id = chat_sessions.id)
      AND NOT EXISTS (SELECT 1 FROM artifacts WHERE session_id = chat_sessions.id)`)],
  },
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
        idempotencyKeys: nowMs - IDEMPOTENCY_RETENTION_MS,
        undoRecords: isoCutoff(UNDO_RETENTION_MS),
        turnTelemetry: isoCutoff(TELEMETRY_RETENTION_MS),
        chatMessages: isoCutoff(chatAuditRetentionMs),
        auditEvents: isoCutoff(chatAuditRetentionMs),
        artifacts: nowIsoArg,
        operationSteps: operationCutoff,
        operationRuns: operationCutoff,
        actionResults: isoCutoff(chatAuditRetentionMs),
        turnRuns: isoCutoff(chatAuditRetentionMs),
        chatSessions: nowIsoArg,
      };
      const counts: Record<PruneTable, number> = {
        pendingConfirmations: 0,
        idempotencyKeys: 0,
        undoRecords: 0,
        turnTelemetry: 0,
        chatMessages: 0,
        auditEvents: 0,
        artifacts: 0,
        operationSteps: 0,
        operationRuns: 0,
        actionResults: 0,
        turnRuns: 0,
        chatSessions: 0,
      };
      let total = 0;
      let batches = 0;
      let changed = true;
      while (changed && total < MAX_ROWS_PER_PASS) {
        changed = false;
        const remainingAtRoundStart = MAX_ROWS_PER_PASS - total;
        const roundLimit = Math.min(BATCH_SIZE, remainingAtRoundStart);
        db.transaction(() => {
          db.prepare(
            `UPDATE undo_records SET status = 'expired', remaining_json = '[]'
             WHERE rowid IN (SELECT rowid FROM undo_records WHERE status = 'available' AND expires_at < ? LIMIT ?)`,
          ).run(nowIsoArg, roundLimit);
          db.prepare(
            `UPDATE pending_confirmations
                SET status = 'expired', used_at = ?, nonce_hash = '',
                    agent_state_json = NULL, operation_json = NULL
              WHERE rowid IN (
                SELECT rowid FROM pending_confirmations
                 WHERE status = 'pending' AND expires_at <= ? LIMIT ?
              )`,
          ).run(nowIsoArg, nowIsoArg, roundLimit);
          for (const { table, sqls } of PRUNE_DELETES) {
            for (const sql of sqls) {
              if (total >= MAX_ROWS_PER_PASS) return;
              const limit = Math.min(BATCH_SIZE, MAX_ROWS_PER_PASS - total);
              const deleted = db.prepare(sql).run(cutoffByTable[table], limit).changes;
              counts[table] += deleted;
              total += deleted;
              if (deleted > 0) changed = true;
            }
          }
        })();
        batches += 1;
        if (changed && total < MAX_ROWS_PER_PASS) await yieldToEventLoop();
      }
      return {
        ...counts,
        total,
        batches,
        durationMs: Date.now() - started,
        backlog: total >= MAX_ROWS_PER_PASS,
      };
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
  };
}
