/**
 * The periodic fleet-health snapshot (D4; `DEPLOYMENT.md` "Required alerts"
 * row 10).
 *
 * WHY THIS IS A LOG LINE AND NOT AN HTTP AGGREGATE. `GET /api/metrics` is
 * session-gated and every store read behind it is keyed on BOTH
 * `claims.workspaceId` AND `claims.adminUserId` — per-admin scoping is the
 * stated privacy contract of `services/metrics-service.ts`, not an incidental
 * detail. So it structurally cannot answer "is the FLEET healthy", and the two
 * ways to make it answer that are both wrong:
 *
 * - Returning a cross-workspace aggregate to one admin's session would hand
 *   that admin other workspaces' data. That is an authorization regression
 *   wearing a feature's clothes.
 * - Adding an operator-scoped route would need an operator CREDENTIAL, and this
 *   system has none: every authenticated surface is a Clockify admin session
 *   with a fail-closed role recheck, and there is no `OPS_`/`OPERATOR_` secret
 *   anywhere in the tree. Inventing one adds a brand-new authentication surface
 *   — exactly where the leak risk lives — to ship an observability nicety.
 *
 * The log plane is already the operator's trust boundary (D2/D3 put the
 * `[subsystem] event=key=value` contract and the HMAC aliases of
 * `src/log-alias.ts` there), its access control belongs to the deploy platform,
 * and it is reachable without a session. So the aggregate goes there.
 *
 * PRIVACY. This is the ONE operator line whose inputs are not scoped to a
 * single admin, so it is counts-only BY CONSTRUCTION: `OperatorHealthCounts`
 * has no string field, and the formatter below can only ever write integers.
 * There is no workspace dimension at all — not even an HMAC alias — because a
 * per-workspace breakdown of a fleet aggregate would re-introduce exactly the
 * cross-tenant correlation the aggregate exists to avoid.
 *
 * UNCONDITIONAL, INCLUDING ALL ZEROES — the deliberate opposite of D3's
 * crossing-only rule. This is a heartbeat: an all-zero line means "the fleet is
 * idle and the process is alive", and the ABSENCE of lines is itself the
 * operator signal. A crossing-only heartbeat would be indistinguishable from a
 * dead process.
 *
 * WHAT THE WINDOW IS NOT. `setInterval` does not tile: consecutive fires drift
 * by however long the previous snapshot and the rest of the event loop took, so
 * successive windows overlap or leave a gap. An event landing in a gap is
 * counted by NO line. The flow fields are therefore a sample of recent activity,
 * never a ledger — nothing here may be summed across lines to obtain a total.
 *
 * THE FIRST LINE AFTER A CRASH IS DISTORTED, and knowing that is the difference
 * between reading it and being misled by it. `start()` emits one snapshot at
 * boot, right after `runProductionStartupReconciliation`. Store construction's
 * `recoverOrphanedRuns` has already stamped every orphaned run's synthetic
 * `run.failed` — and its `phase='failed'` — with the CURRENT time, however long
 * ago the process actually died. So the boot line attributes every historical
 * orphan to the last 15 minutes. That is a real signal ("this restart found N
 * stranded runs"), but it is not a rate, and the second line 15 minutes later
 * is the first one that measures live traffic.
 *
 * WHAT IS NOT HERE. Run phases split into FLOW (what happened inside the
 * window, from the run-event journal) and LEVEL (what is sitting there right
 * now, from `assistant_runs`). The terminal phases `completed`/`failed` appear
 * only as flow: a lifetime count of terminal rows is a retention artifact, not
 * fleet health. `preparing_writes` is declared in `RunPhase` and in the schema
 * CHECK but NO code ever assigns it (verified 2026-07-31: the only occurrences
 * are the schema constraint, two defensive `IN` lists, and one route branch), so
 * a `phase_preparing_writes` field could only ever read 0 and is not emitted.
 * `in_flight` is counted independently of the histogram so that a phase which
 * starts being written without a field here surfaces as a mismatch instead of
 * vanishing; `tests/integration/operator-health-snapshot.test.ts` pins both that
 * invariant and the `RunPhase` union.
 */

/**
 * Non-terminal phases a run can actually be observed in, in lifecycle order.
 * The emitted field order follows this array, so a dashboard column order is
 * stable across releases.
 */
export const OPERATOR_HEALTH_PHASES = [
  "model",
  "discovering",
  "executing_reads",
  "awaiting_confirmation",
  "awaiting_clarification",
] as const;

export type OperatorHealthPhase = (typeof OPERATOR_HEALTH_PHASES)[number];

/**
 * Phases where the RUNTIME owns the next step, so elapsed time with no update
 * means broken rather than waiting.
 *
 * The two `awaiting_*` phases are excluded from `stalled` on purpose, and the
 * exact mechanism matters. A lapsed confirmation IS terminalized — but LAZILY:
 * `routes/v2-chat-pipeline.ts` calls `failActiveRunsForSession(…,
 * "confirmation_lapsed")` while handling the SAME session's NEXT request. An
 * admin who previews a risky write and then walks away sends no next request,
 * so nothing ever runs that code and the row sits in `awaiting_confirmation`
 * until retention removes it ~90 days later. Counting those would make
 * `stalled` grow monotonically with abandoned sessions — precisely the
 * always-firing alert D3 existed to eliminate. Scoped this way `stalled` means
 * "neither progressing nor waiting on a human": normally zero, worth waking
 * someone for.
 */
export const OPERATOR_HEALTH_PROGRESSING_PHASES = [
  "model",
  "discovering",
  "executing_reads",
] as const satisfies readonly OperatorHealthPhase[];

/**
 * Every value one snapshot reports: integers plus one boolean. None is a string
 * and none may become one — that is what makes the formatter incapable of
 * writing workspace text even by accident.
 */
export interface OperatorHealthCounts {
  /**
   * FLOW — `run.started` events inside the window. Complete for every
   * run-creation path that has a production caller; see the store module's
   * header for the eventless `startRunWithTurn` that currently has none.
   */
  runsStarted: number;
  /** FLOW — runs that reached `phase='completed'` inside the window. */
  runsCompleted: number;
  /**
   * FLOW — runs that reached `phase='failed'` inside the window, any cause.
   * Counted from the phase, NOT from `run.failed` events, so the eventless
   * `failActiveRunsForSession` failures are included; the store header names
   * the three paths that take it.
   */
  runsFailed: number;
  /**
   * FLOW — tool calls the harness refused for budget
   * (`services/action-execution-service.ts`). Recoverable: the run continues.
   */
  budgetDeniedTools: number;
  /**
   * FLOW — runs the bounded runner ended on budget (`assistant-v2/runner.ts`).
   * The same condition as above but terminal for the turn, and previously
   * invisible: `buildRunMetrics` counts `run.failed` without its code.
   */
  budgetDeniedRuns: number;
  /** LEVEL — every non-terminal run right now, counted independently of the histogram. */
  inFlight: number;
  /** LEVEL — non-terminal runs by phase; see the header for the omitted phases. */
  inFlightByPhase: Record<OperatorHealthPhase, number>;
  /** LEVEL — progressing-phase runs not touched for a whole window. */
  stalled: number;
  /**
   * LEVEL — every operation left in `outcome_unknown`: a dispatched write
   * Clockify never proved either way. This is a STANDING backlog, not an
   * incident counter, and it has exactly two drop paths: startup reconciliation
   * settling a row (restart only), and retention deleting it after
   * `OPERATION_RETENTION_MS` = 30 days. A row that reconciliation examined and
   * could not settle keeps this status with `reconciled_at` set and is never a
   * candidate again, so it stays counted for those 30 days with no operator
   * action able to clear it. Alerting on `> 0` would therefore be the same
   * always-firing pathology `stalled` avoids — watch it for a RISE.
   */
  outcomeUnknown: number;
  /**
   * LEVEL — the subset above that reconciliation has NOT yet examined
   * (`reconciled_at IS NULL`), which is exactly what
   * `listStartupReconciliationCandidates` selects. This one HAS a clear path: a
   * restart drains it, settling what it can and marking the rest examined. It
   * is the page-worthy half of the pair.
   */
  outcomeUnknownUnreconciled: number;
  /**
   * LEVEL — the most recent RECORDED sweep left rows unpruned. Reads 0 whenever
   * no sweep record exists: a fresh database, a prune that never ran, or (only
   * if nothing swept for a whole 90-day retention window) after the last record
   * aged out. All three are "the prune is not running", which is alert row 3's
   * job — this field answers "did the last sweep finish", not "did one happen".
   */
  retentionBacklog: boolean;
}

/**
 * Snapshot cadence. Fifteen minutes: ~96 lines a day is cheap to retain and
 * still readable by eye, a stalled run or an ambiguous write surfaces within a
 * quarter hour, and the window is long enough that the flow counts are not
 * dominated by sampling noise. It is deliberately SHORTER than the hourly
 * retention sweep, which is why `retentionBacklog` is reported as a level read
 * back from the database rather than as sweeps-in-window (that would read zero
 * in three windows out of four).
 */
export const OPERATOR_HEALTH_SNAPSHOT_INTERVAL_MS = 15 * 60 * 1000;

export interface OperatorHealthSnapshotEmitter {
  emit(input: { windowMs: number; counts: OperatorHealthCounts }): void;
  /**
   * The snapshot read itself failed. Takes NO error argument, for the same
   * reason `RetentionAlertMonitor.failed()` takes none: a store failure's
   * message is a driver string that quotes the failing SQL, and therefore
   * customer row values, so it must be unable to reach this line at the TYPE
   * level rather than by a caller who remembers to strip it.
   */
  unavailable(): void;
}

export function createOperatorHealthSnapshotEmitter(
  input: { log?: (line: string) => void } = {},
): OperatorHealthSnapshotEmitter {
  // console.log, not console.warn: a heartbeat is informational even when the
  // fields inside it are what an operator thresholds on. `unavailable` is the
  // exceptional one and uses warn.
  const log = input.log ?? ((line: string) => console.log(line));
  return {
    emit({ windowMs, counts }) {
      const phases = OPERATOR_HEALTH_PHASES
        .map((phase) => `phase_${phase}=${counts.inFlightByPhase[phase]}`)
        .join(" ");
      log(
        "[operator] event=health_snapshot"
        + ` window_min=${Math.round(windowMs / 60_000)}`
        + ` runs_started=${counts.runsStarted}`
        + ` runs_completed=${counts.runsCompleted}`
        + ` runs_failed=${counts.runsFailed}`
        + ` budget_denied_tools=${counts.budgetDeniedTools}`
        + ` budget_denied_runs=${counts.budgetDeniedRuns}`
        + ` in_flight=${counts.inFlight}`
        + ` ${phases}`
        + ` stalled=${counts.stalled}`
        + ` outcome_unknown=${counts.outcomeUnknown}`
        + ` outcome_unknown_unreconciled=${counts.outcomeUnknownUnreconciled}`
        + ` retention_backlog=${counts.retentionBacklog ? 1 : 0}`,
      );
    },
    unavailable() {
      // Deliberately NOT prefixed `health_snapshot`: an operator's match string
      // for the heartbeat must not also match its failure, or one grep silently
      // reports two different conditions and the field parse breaks.
      log("[operator] event=snapshot_unavailable");
    },
  };
}
