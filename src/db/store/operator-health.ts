import {
  OPERATOR_HEALTH_PHASES,
  OPERATOR_HEALTH_PROGRESSING_PHASES,
  type OperatorHealthCounts,
  type OperatorHealthPhase,
} from "../../operator-health.js";
import type { StoreContext } from "./context.js";

/**
 * D4: the ONE fleet-wide read behind the operator health snapshot
 * (`src/operator-health.ts` owns what the line means and how it is formatted).
 *
 * Why this aggregates in SQL when `listRunEventsForMetrics` deliberately does
 * not. That reader is scoped to one workspace + one admin and bounded to 10,000
 * rows, so the store can hand rows over and let `metrics/run-metrics.ts` own
 * every formula. A FLEET read has no such bound — the row set is every
 * workspace's — so there is no honest row limit to hand over: any cap would
 * silently truncate the aggregate and report a number that looks like health.
 * `COUNT`/`SUM` in SQL is a bounded PRIMITIVE, not a formula: this module
 * decides nothing about what the numbers mean, does no ratio, threshold or
 * classification, and returns integers the emitter only formats.
 *
 * WHY TERMINAL RUNS ARE COUNTED FROM `assistant_runs`, NOT FROM `run.failed`.
 * `failActiveRunsForSession` (`store/runs.js`) flips `phase = 'failed'` with a
 * bare UPDATE and NO event — it does not even persist the code (`void code`).
 * `routes/v2-chat-pipeline.ts` reaches it for `confirmation_lapsed` and
 * `clarification_missing`, and as the fallback when a stranded run's state
 * cannot be loaded. Counting `run.failed` EVENTS therefore misses a whole class
 * of failure while looking authoritative, so terminal runs are counted from the
 * phase column, which every path writes. `runs_started` stays event-based
 * because `run.started` is emitted by `startRunWithEvent`, the only run-creation
 * path with a production caller (`startRunWithTurn` inserts a row without an
 * event but is declared and never called; if that changes, this undercounts and
 * must move to the phase read too).
 *
 * COST, measured with EXPLAIN QUERY PLAN rather than assumed, because this runs
 * unattended every 15 minutes forever:
 *
 * - `run_events` is a RANGE SEEK on `idx_run_events_prune_created`
 *   (`created_at>?`), so the `json_extract` calls only ever touch the window's
 *   rows — not the largest table in the database.
 * - the non-terminal `assistant_runs` read is a COVERING scan of
 *   `idx_assistant_runs_phase_updated`; `phase NOT IN (…)` cannot be a range
 *   seek, but no table page is read. The terminal read IS a seek on the same
 *   index (`phase IN (…)` + `updated_at >= ?`), which is why it is a separate
 *   statement rather than one ungated GROUP BY over 90 days of terminal rows.
 * - `operation_runs` is a full table SCAN — the one statement here that is not
 *   index-supported, since no index covers `status`. Accepted, not overlooked:
 *   the table holds one row per external WRITE operation and is retention-pruned
 *   at 30 days, so it is the smallest of the three. If that ever stops being
 *   true the fix is a partial index on `status = 'outcome_unknown'`, which is a
 *   schema-version event and deliberately not bundled into an observability
 *   change.
 * - `retention_runs` seeks the last entry of `idx_retention_runs_recorded`.
 *   That row is pruned on the SAME 90-day horizon as chat/audit, while sweeps
 *   run hourly, so the newest row can only age out if no sweep completed for a
 *   whole retention window — which is the "no sweep has recorded anything" case
 *   the `retentionBacklog` contract already covers, and is alert row 3's job.
 *
 * PRIVACY: no statement selects an id, a name, a payload, or any text. The
 * `json_extract` calls read one bounded enum-like denial code and compare it to
 * a literal; the code never leaves SQLite as a value.
 */
interface FlowRow {
  started: number;
  budget_tools: number;
  budget_runs: number;
}

interface PhaseRow {
  phase: string;
  total: number;
  stale: number;
}

export function buildOperatorHealthStore(ctx: StoreContext) {
  const { db } = ctx;
  const progressing = new Set<string>(OPERATOR_HEALTH_PROGRESSING_PHASES);
  const emitted = new Set<string>(OPERATOR_HEALTH_PHASES);

  return {
    operatorHealthCounts(input: { since: string }): OperatorHealthCounts {
      const flow = db.prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN event_type = 'run.started' THEN 1 ELSE 0 END), 0) AS started,
           COALESCE(SUM(CASE WHEN event_type = 'tool.denied'
                              AND json_extract(payload_json, '$.code') = 'budget_exhausted'
                             THEN 1 ELSE 0 END), 0) AS budget_tools,
           COALESCE(SUM(CASE WHEN event_type = 'run.failed'
                              AND json_extract(payload_json, '$.code') = 'budget_exhausted'
                             THEN 1 ELSE 0 END), 0) AS budget_runs
           FROM run_events
          WHERE created_at >= ?`,
      ).get(input.since) as FlowRow;

      // Terminal runs by PHASE, so the eventless failure paths are counted too
      // (see the header). A run that reaches a terminal phase is never updated
      // again, so `updated_at` is the instant it terminalized.
      const terminal = db.prepare(
        `SELECT phase, COUNT(*) AS total
           FROM assistant_runs
          WHERE phase IN ('completed', 'failed') AND updated_at >= ?
          GROUP BY phase`,
      ).all(input.since) as Array<{ phase: string; total: number }>;
      const terminalByPhase = new Map(terminal.map((row) => [row.phase, row.total]));

      // One pass for both levels: `total` is the histogram, `stale` is the same
      // rows filtered to "not touched for a whole window" so the two can never
      // be read at different instants and disagree.
      const phases = db.prepare(
        `SELECT phase,
                COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN updated_at < ? THEN 1 ELSE 0 END), 0) AS stale
           FROM assistant_runs
          WHERE phase NOT IN ('completed', 'failed')
          GROUP BY phase`,
      ).all(input.since) as PhaseRow[];

      const inFlightByPhase = Object.fromEntries(
        OPERATOR_HEALTH_PHASES.map((phase) => [phase, 0]),
      ) as Record<OperatorHealthPhase, number>;
      let inFlight = 0;
      let stalled = 0;
      for (const row of phases) {
        // `inFlight` counts EVERY non-terminal row, including a phase this
        // build has no field for, so an unemitted phase shows up as a histogram
        // mismatch rather than disappearing from the snapshot.
        inFlight += row.total;
        if (emitted.has(row.phase)) inFlightByPhase[row.phase as OperatorHealthPhase] = row.total;
        if (progressing.has(row.phase)) stalled += row.stale;
      }

      // Two numbers, because they have different clear paths. `unreconciled`
      // is exactly `listStartupReconciliationCandidates`' predicate, so it
      // drains at the next restart's reconciliation pass; the total does not,
      // since a row that pass examined and could NOT settle keeps
      // `status='outcome_unknown'` with `reconciled_at` set and is never a
      // candidate again.
      const unknown = db.prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN reconciled_at IS NULL THEN 1 ELSE 0 END), 0) AS unreconciled
           FROM operation_runs
          WHERE status = 'outcome_unknown'`,
      ).get() as { total: number; unreconciled: number };

      // `retention_runs` had no production reader at all before this: the sweep
      // recorded its evidence and only a unit test ever read it back, so a
      // backlog reached an operator solely through the in-memory crossing alert
      // — which a restart clears. This re-derives the current state from the
      // database, so a restart cannot hide a standing backlog.
      const sweep = db.prepare(
        "SELECT backlog FROM retention_runs ORDER BY recorded_at DESC, rowid DESC LIMIT 1",
      ).get() as { backlog: number } | undefined;

      return {
        runsStarted: flow.started,
        runsCompleted: terminalByPhase.get("completed") ?? 0,
        runsFailed: terminalByPhase.get("failed") ?? 0,
        budgetDeniedTools: flow.budget_tools,
        budgetDeniedRuns: flow.budget_runs,
        inFlight,
        inFlightByPhase,
        stalled,
        outcomeUnknown: unknown.total,
        outcomeUnknownUnreconciled: unknown.unreconciled,
        retentionBacklog: sweep?.backlog === 1,
      };
    },
  };
}
