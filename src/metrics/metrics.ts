/**
 * Operational metrics (Phase 7 — launch readiness). A pure aggregation over the
 * data the system already records: every executed action is audited with its
 * receipt, and every risky preview is a pending-confirmation row with a status.
 * From those we derive per-action success/failure, an error taxonomy, and
 * confirm/cancel/expire rates — the signal for "is the assistant working?".
 *
 * Pure (no clock, no I/O): the store fetches the rows, the route stamps the time,
 * so this is trivially unit-testable.
 */

/** One audited action outcome (parsed from its receipt). */
export interface ActionOutcome {
  actionName: string;
  ok: boolean;
  /** Error code for a failed receipt (drives the taxonomy). */
  code?: string;
}

export interface ActionMetric {
  action: string;
  total: number;
  succeeded: number;
  failed: number;
}

export interface ConfirmationMetric {
  previewed: number;
  confirmed: number;
  cancelled: number;
  expired: number;
  failed: number;
  pending: number;
}

export interface MetricsReport {
  generatedAt: string;
  totals: { actions: number; succeeded: number; failed: number };
  byAction: ActionMetric[];
  errorsByCode: Array<{ code: string; count: number }>;
  confirmations: ConfirmationMetric;
}

export function buildMetrics(
  outcomes: ActionOutcome[],
  confirmationStatuses: string[],
  generatedAt: string,
): MetricsReport {
  const perAction = new Map<string, { succeeded: number; failed: number }>();
  const perCode = new Map<string, number>();
  let succeeded = 0;
  let failed = 0;

  for (const outcome of outcomes) {
    const entry = perAction.get(outcome.actionName) ?? { succeeded: 0, failed: 0 };
    if (outcome.ok) {
      entry.succeeded += 1;
      succeeded += 1;
    } else {
      entry.failed += 1;
      failed += 1;
      if (outcome.code) perCode.set(outcome.code, (perCode.get(outcome.code) ?? 0) + 1);
    }
    perAction.set(outcome.actionName, entry);
  }

  const byAction = [...perAction.entries()]
    .map(([action, v]) => ({ action, total: v.succeeded + v.failed, succeeded: v.succeeded, failed: v.failed }))
    .sort((a, b) => b.total - a.total || a.action.localeCompare(b.action));

  const errorsByCode = [...perCode.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

  const count = (status: string): number => confirmationStatuses.filter((s) => s === status).length;
  const confirmations: ConfirmationMetric = {
    previewed: confirmationStatuses.length,
    confirmed: count("used"),
    cancelled: count("cancelled"),
    expired: count("expired"),
    failed: count("failed"),
    pending: count("pending") + count("executing"),
  };

  return {
    generatedAt,
    totals: { actions: outcomes.length, succeeded, failed },
    byAction,
    errorsByCode,
    confirmations,
  };
}
