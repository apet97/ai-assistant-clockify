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

import { DAY_MS } from "../durations.js";

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
    confirmed: count("succeeded") + count("partial"),
    cancelled: count("cancelled"),
    expired: count("expired"),
    failed: count("definitive_failed") + count("outcome_unknown"),
    pending: count("pending"),
  };

  return {
    generatedAt,
    totals: { actions: outcomes.length, succeeded, failed },
    byAction,
    errorsByCode,
    confirmations,
  };
}

// --- Turn telemetry (cost + latency) ----------------------------------------

/** One chat/resume turn's model telemetry, as stored in turn_telemetry. */
export interface TurnTelemetry {
  kind: "chat" | "resume";
  modelCalls: number;
  /** Absent when the backend reported no token counts (absence ≠ zero). */
  promptTokens?: number;
  completionTokens?: number;
  /** Prompt tokens served from the provider's cache; absent when the backend reported none. */
  cachedPromptTokens?: number;
  turnMs: number;
  modelMs: number;
  createdAt: string;
}

export interface UsageMetrics {
  turns: number;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens that hit the provider cache (cheaper) — a window into prefix-cache savings. */
  cachedPromptTokens: number;
  avgTurnMs: number;
  maxTurnMs: number;
  avgModelMs: number;
  last24h: {
    turns: number;
    modelCalls: number;
    promptTokens: number;
    completionTokens: number;
    cachedPromptTokens: number;
    avgTurnMs: number;
  };
}

/** Pure aggregation over turn_telemetry rows (cost review + latency baseline). */
export function buildUsageMetrics(rows: TurnTelemetry[], generatedAt: string): UsageMetrics {
  const cutoff = new Date(Date.parse(generatedAt) - DAY_MS).toISOString();
  const sum = (subset: TurnTelemetry[]) => ({
    turns: subset.length,
    modelCalls: subset.reduce((n, r) => n + r.modelCalls, 0),
    promptTokens: subset.reduce((n, r) => n + (r.promptTokens ?? 0), 0),
    completionTokens: subset.reduce((n, r) => n + (r.completionTokens ?? 0), 0),
    cachedPromptTokens: subset.reduce((n, r) => n + (r.cachedPromptTokens ?? 0), 0),
    avgTurnMs: subset.length ? Math.round(subset.reduce((n, r) => n + r.turnMs, 0) / subset.length) : 0,
  });
  const recent = rows.filter((r) => r.createdAt >= cutoff);
  return {
    ...sum(rows),
    maxTurnMs: rows.reduce((m, r) => Math.max(m, r.turnMs), 0),
    avgModelMs: rows.length ? Math.round(rows.reduce((n, r) => n + r.modelMs, 0) / rows.length) : 0,
    last24h: sum(recent),
  };
}
