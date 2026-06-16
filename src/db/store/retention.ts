import type { StoreContext } from "./context.js";

/**
 * Operational-table retention. Settled/expired confirmations age out on a 30d
 * clock so listConfirmationOutcomes metrics keep a generous recent window.
 */
const CONFIRMATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const UNDO_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Must stay comfortably above routes/api.ts IDEMPOTENCY_WINDOW_MS (10 min). */
export const IDEMPOTENCY_RETENTION_MS = 60 * 60 * 1000;
/** Turn telemetry rows older than this are pruned (cost review needs weeks, not forever). */
const TELEMETRY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface PruneCounts {
  pendingConfirmations: number;
  idempotencyKeys: number;
  undoRecords: number;
  turnTelemetry: number;
  chatMessages: number;
  auditEvents: number;
}

type PruneTable = keyof PruneCounts;

/**
 * Single source of truth for the retention DELETEs: one entry per table, each
 * carrying its disjunct SQL string(s) AND the kind of cutoff value its `?`
 * binds (an idempotency cutoff is an epoch INT; every other writer stamps via
 * toISOString(), so those bind the ISO STRING cutoff). Both `pruneExpired`
 * (which runs each DELETE) and `explainPrunePlan` (the index-seek regression
 * test) iterate this SAME const, so the executed predicate shapes and the
 * EXPLAINed ones can never drift.
 *
 * Each OR-predicate retention DELETE is split into single-predicate statements
 * so the planner can SEARCH a narrow index instead of full-SCANning the table:
 * SQLite won't OR-union a low-cardinality `status` index, and a combined OR over
 * two columns is one SCAN (pinned by explainPrunePlan / store-retention.test.ts).
 */
const PRUNE_DELETES: ReadonlyArray<{
  readonly table: PruneTable;
  readonly cutoff: "iso" | "epoch";
  readonly sqls: readonly string[];
}> = [
  {
    table: "pendingConfirmations",
    cutoff: "iso",
    sqls: [
      "DELETE FROM pending_confirmations WHERE status != 'pending' AND created_at < ?",
      "DELETE FROM pending_confirmations WHERE status = 'pending' AND expires_at < ?",
    ],
  },
  {
    table: "idempotencyKeys",
    cutoff: "epoch",
    sqls: [
      "DELETE FROM idempotency_keys WHERE committed_at IS NOT NULL AND committed_at < ?",
      "DELETE FROM idempotency_keys WHERE receipt_json IS NULL AND claimed_at < ?",
    ],
  },
  {
    table: "undoRecords",
    cutoff: "iso",
    sqls: ["DELETE FROM undo_records WHERE status = 'undone' AND undone_at IS NOT NULL AND undone_at < ?"],
  },
  {
    table: "turnTelemetry",
    cutoff: "iso",
    sqls: ["DELETE FROM turn_telemetry WHERE created_at < ?"],
  },
  // Chat transcripts + audit log past the retention window (data-minimization).
  {
    table: "chatMessages",
    cutoff: "iso",
    sqls: ["DELETE FROM chat_messages WHERE created_at < ?"],
  },
  {
    table: "auditEvents",
    cutoff: "iso",
    sqls: ["DELETE FROM audit_events WHERE created_at < ?"],
  },
];

export interface RetentionStoreOptions {
  /** Retention window (ms) for chat_messages + audit_events. */
  chatAuditRetentionMs: number;
}

/**
 * Retention concern: pruneExpired (one transaction) + its test-only
 * explainPrunePlan. The chat/audit window is threaded in (the retentionDays
 * override is resolved in createStore) so this module owns only the
 * operational-table windows.
 */
export function buildRetentionStore(
  ctx: StoreContext,
  { chatAuditRetentionMs }: RetentionStoreOptions,
): {
  pruneExpired(nowIso: string): PruneCounts;
  explainPrunePlan(): Record<PruneTable, string>;
} {
  const { db } = ctx;
  return {
    pruneExpired(nowIsoArg) {
      const nowMs = Date.parse(nowIsoArg);
      // Per-table cutoffs. The idempotency cutoff is a bare epoch int (its
      // columns store epoch ms); every other table's column is an ISO string
      // (each writer stamps via toISOString()), so ISO-string comparison is safe.
      const isoCutoff = (windowMs: number): string => new Date(nowMs - windowMs).toISOString();
      const cutoffByTable: Record<PruneTable, string | number> = {
        pendingConfirmations: isoCutoff(CONFIRMATION_RETENTION_MS),
        undoRecords: isoCutoff(UNDO_RETENTION_MS),
        turnTelemetry: isoCutoff(TELEMETRY_RETENTION_MS),
        chatMessages: isoCutoff(chatAuditRetentionMs),
        auditEvents: isoCutoff(chatAuditRetentionMs),
        // Crashed-claim backstop (r1-concurrency-races-01): a NULL-receipt claim
        // for a key that never recurs would leak forever — the committed_at-only
        // prune NEVER matches it (NULL < n is NULL/falsy in SQLite, proven by
        // execution). It is swept on the SAME retention clock as a completed row,
        // NOT at CLAIM_TTL: a claim orphaned by a crash between the host write and
        // `fill` must survive the whole dedup window so a re-claim sees
        // `stale_unknown` (crash-before-fill), never a silent re-commit. Sweeping
        // it at CLAIM_TTL would reopen that duplicate window from this hourly prune.
        idempotencyKeys: nowMs - IDEMPOTENCY_RETENTION_MS,
      };
      // One transaction — operational tables ONLY.
      const run = db.transaction((): PruneCounts => {
        const counts = {} as PruneCounts;
        for (const { table, sqls } of PRUNE_DELETES) {
          const cutoff = cutoffByTable[table];
          counts[table] = sqls.reduce(
            (sum, sql) => sum + db.prepare(sql).run(cutoff).changes,
            0,
          );
        }
        return counts;
      });
      return run();
    },

    explainPrunePlan() {
      // The exact prune DELETEs (mirror pruneExpired via the shared PRUNE_DELETES
      // const); EXPLAIN takes a placeholder bind value of the right type, so the
      // planner sees the real predicate shapes. The OR-predicate prunes are split
      // into one DELETE per disjunct (as pruneExpired runs them); the joined plan
      // must SEARCH an index for each.
      const plan = {} as Record<PruneTable, string>;
      for (const { table, cutoff, sqls } of PRUNE_DELETES) {
        const param: string | number = cutoff === "epoch" ? 0 : "x";
        plan[table] = sqls
          .map((sql) =>
            (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(param) as Array<{ detail: string }>)
              .map((r) => r.detail)
              .join(" | "),
          )
          .join(" | ");
      }
      return plan;
    },
  };
}
