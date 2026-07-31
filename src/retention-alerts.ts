/**
 * Operator alerts for the retention sweep (D3; `DEPLOYMENT.md` "Required
 * alerts" row 3, which names a retention BACKLOG and a REPEATED prune failure
 * as two separate conditions).
 *
 * Before this, `server.ts` logged `retention prune failed:` on every failure
 * with no counter anywhere, so nothing distinguished one transient
 * `SQLITE_BUSY` against a concurrent turn from a sweep that had not completed
 * in a day — and "repeated" in the runbook was a word, not a number.
 *
 * Both alerts fire at a CROSSING and then stay quiet:
 *
 * - The failure alert fires on the Nth consecutive failure and not again until
 *   a sweep succeeds, mirroring `clockify/token-rejection-monitor.ts`.
 * - The backlog alert fires when a sweep first reports an unfinished backlog.
 *   It must not fire per pass: a backlogged sweep re-arms itself through
 *   `setImmediate` until it drains, so a per-pass line would emit thousands of
 *   times while an operator is trying to read the log.
 *
 * `failed()` takes NO error argument on purpose. A prune failure's message is a
 * driver string that quotes the failing SQL — customer row values and token
 * ciphertext — so it must be unable to reach THIS ALERT LINE at the type level,
 * not merely stripped by a caller who remembers to. That is a claim about this
 * line only: `server.ts` separately writes the driver message to its own
 * `retention prune failed:` prose line, which is a different question and is
 * not governed by this module.
 */

/**
 * Consecutive failed sweeps before the "repeated" alert fires.
 *
 * Three, because the sweep runs hourly (`PRUNE_INTERVAL_MS` in `server.ts`) and
 * a single failure is routinely a transient lock contending with a live turn.
 * Three consecutive failures is therefore ~3 hours of no retention progress —
 * still far inside the retention window this protects (`RETENTION_DAYS`,
 * default 90 days), but well past any transient. A failed sweep does not re-arm
 * the backlog continuation, so the streak cannot be burned through faster than
 * one per hour.
 */
export const RETENTION_PRUNE_FAILURE_THRESHOLD = 3;

export interface RetentionAlertMonitor {
  /** A sweep completed. Clears the failure streak and tracks the backlog state. */
  swept(input: { backlog: boolean; batches: number }): void;
  /** A sweep threw. The reason is deliberately not accepted (see the header). */
  failed(): void;
}

export function createRetentionAlertMonitor(input: {
  failureThreshold?: number;
  log?: (line: string) => void;
} = {}): RetentionAlertMonitor {
  const threshold = input.failureThreshold ?? RETENTION_PRUNE_FAILURE_THRESHOLD;
  const log = input.log ?? ((line: string) => console.warn(line));
  let consecutiveFailures = 0;
  let backlogged = false;
  return {
    swept(sweep) {
      consecutiveFailures = 0;
      if (sweep.backlog === backlogged) return;
      backlogged = sweep.backlog;
      log(
        sweep.backlog
          ? `[retention] event=prune_backlog_started batches=${sweep.batches}`
          : "[retention] event=prune_backlog_cleared",
      );
    },
    failed() {
      consecutiveFailures += 1;
      // Exactly one alert per streak: at the crossing, not on every failure.
      if (consecutiveFailures === threshold) {
        log(`[retention] event=prune_failing_repeatedly consecutive=${consecutiveFailures}`);
      }
    },
  };
}
