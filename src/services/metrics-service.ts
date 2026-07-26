import type { SessionClaims } from "../auth/sessions.js";
import type { Store } from "../db/store.js";
import { buildMetrics, buildUsageMetrics } from "../metrics/metrics.js";
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
  store: Pick<Store, "listActionOutcomes" | "listConfirmationOutcomes" | "listTurnTelemetry">;
  now(): Date;
}

export function createMetricsService(deps: MetricsServiceDeps) {
  function view(claims: SessionClaims, since?: string): MetricsView {
    const sinceIso = since ?? new Date(deps.now().getTime() - THIRTY_DAYS_MS).toISOString();
    const nowIsoStamp = deps.now().toISOString();
    const outcomes = deps.store.listActionOutcomes(claims.workspaceId, claims.adminUserId, sinceIso);
    const confirmations = deps.store.listConfirmationOutcomes(claims.workspaceId, claims.adminUserId, sinceIso);
    const telemetry = deps.store.listTurnTelemetry(claims.workspaceId, claims.adminUserId, sinceIso);
    return {
      metrics: {
        ...buildMetrics(outcomes, confirmations, nowIsoStamp),
        // Cost + latency (the pending prod cost review): per-admin token/turn
        // aggregates from turn_telemetry.
        usage: buildUsageMetrics(telemetry, nowIsoStamp),
      },
    };
  }

  return { view };
}

export type MetricsService = ReturnType<typeof createMetricsService>;
