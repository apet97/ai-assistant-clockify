import type { SessionClaims } from "../auth/sessions.js";
import type { Store } from "../db/store.js";
import { buildMetrics, buildUsageMetrics } from "../metrics/metrics.js";
import { buildRunMetrics } from "../metrics/run-metrics.js";
import { THIRTY_DAYS_MS } from "../durations.js";
import type { MetricsView } from "../shared/contracts.js";

/**
 * MetricsService (T16-E): operational metrics scoped to the caller's own
 * actions (privacy). Absent `since` defaults to the last 30 days (matching the
 * telemetry/confirmation retention horizon) so an unbounded read never
 * aggregates every retained audit row in JS; an explicit `since` reaches the
 * full retained history for ops (r1-efficiency-01).
 */
export interface MetricsServiceDeps {
  store: Pick<Store, "listActionOutcomes" | "listConfirmationOutcomes" | "listTurnTelemetry" | "listRunEventsForMetrics">;
  now(): Date;
}

/** Bounded row budget for one metrics read (mirrors the retention batch bound). */
export const RUN_EVENT_METRICS_LIMIT = 10_000;

export function createMetricsService(deps: MetricsServiceDeps) {
  function view(claims: SessionClaims, since?: string): MetricsView {
    const sinceIso = since ?? new Date(deps.now().getTime() - THIRTY_DAYS_MS).toISOString();
    const nowIsoStamp = deps.now().toISOString();
    const outcomes = deps.store.listActionOutcomes(claims.workspaceId, claims.adminUserId, sinceIso);
    const confirmations = deps.store.listConfirmationOutcomes(claims.workspaceId, claims.adminUserId, sinceIso);
    const telemetry = deps.store.listTurnTelemetry(claims.workspaceId, claims.adminUserId, sinceIso);
    // Bounded read: the store hands over rows only, this service calls the one
    // formula module, and the route stays transport-only.
    const runEvents = deps.store.listRunEventsForMetrics({
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      since: sinceIso,
      limit: RUN_EVENT_METRICS_LIMIT,
    });
    return {
      metrics: {
        ...buildMetrics(outcomes, confirmations, nowIsoStamp),
        // Cost + latency (the pending prod cost review): per-admin token/turn
        // aggregates from turn_telemetry.
        usage: buildUsageMetrics(telemetry, nowIsoStamp),
        // Additive v2 block; every formula lives in `run-metrics.ts`.
        runs: buildRunMetrics(runEvents),
      },
    };
  }

  return { view };
}

export type MetricsService = ReturnType<typeof createMetricsService>;
