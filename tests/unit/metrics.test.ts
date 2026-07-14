import { describe, expect, it } from "vitest";
import { buildMetrics, buildUsageMetrics, type ActionOutcome } from "../../src/metrics/metrics.js";

const outcomes: ActionOutcome[] = [
  { actionName: "clockify_tags_create", ok: true },
  { actionName: "clockify_tags_create", ok: false, code: "invalid_args" },
  { actionName: "clockify_invoices_create", ok: true },
  { actionName: "clockify_invoices_create", ok: false, code: "invalid_args" },
  { actionName: "clockify_invoices_create", ok: false, code: "policy_denied" },
];

describe("buildMetrics", () => {
  it("totals successes and failures across all actions", () => {
    const m = buildMetrics(outcomes, [], "2026-06-05T00:00:00.000Z");
    expect(m.totals).toEqual({ actions: 5, succeeded: 2, failed: 3 });
    expect(m.generatedAt).toBe("2026-06-05T00:00:00.000Z");
  });

  it("groups per action, sorted by volume (busiest first)", () => {
    const m = buildMetrics(outcomes, [], "t");
    expect(m.byAction[0]).toEqual({ action: "clockify_invoices_create", total: 3, succeeded: 1, failed: 2 });
    expect(m.byAction[1]).toEqual({ action: "clockify_tags_create", total: 2, succeeded: 1, failed: 1 });
  });

  it("builds an error taxonomy from failed receipts, most common first", () => {
    const m = buildMetrics(outcomes, [], "t");
    expect(m.errorsByCode).toEqual([
      { code: "invalid_args", count: 2 },
      { code: "policy_denied", count: 1 },
    ]);
  });

  it("summarizes durable confirmation outcomes", () => {
    // Only statuses the store actually produces: succeeded / cancelled / definitive_failed /
    // pending, plus the 'expired' the store derives for a lapsed pending row.
    const m = buildMetrics([], ["succeeded", "succeeded", "cancelled", "expired", "definitive_failed", "pending"], "t");
    expect(m.confirmations).toEqual({
      previewed: 6,
      confirmed: 2,
      cancelled: 1,
      expired: 1,
      failed: 1,
      pending: 1,
    });
  });

  it("handles an empty system (no actions, no confirmations)", () => {
    const m = buildMetrics([], [], "t");
    expect(m.totals).toEqual({ actions: 0, succeeded: 0, failed: 0 });
    expect(m.byAction).toEqual([]);
    expect(m.errorsByCode).toEqual([]);
    expect(m.confirmations.previewed).toBe(0);
  });
});

describe("buildUsageMetrics", () => {
  const NOW_ISO = "2026-06-06T12:00:00.000Z";
  const row = (overrides: Partial<import("../../src/metrics/metrics.js").TurnTelemetry> = {}) => ({
    kind: "chat" as const,
    modelCalls: 2,
    promptTokens: 1000,
    completionTokens: 100,
    turnMs: 4000,
    modelMs: 3000,
    createdAt: "2026-06-06T11:00:00.000Z", // inside the 24h window
    ...overrides,
  });

  it("aggregates totals + last-24h separately (the old row drops out of last24h)", () => {
    const old = row({ createdAt: "2026-06-01T00:00:00.000Z", turnMs: 10_000 });
    const metrics = buildUsageMetrics([old, row()], NOW_ISO);
    expect(metrics.turns).toBe(2);
    expect(metrics.modelCalls).toBe(4);
    expect(metrics.promptTokens).toBe(2000);
    expect(metrics.maxTurnMs).toBe(10_000);
    expect(metrics.avgTurnMs).toBe(7000);
    expect(metrics.last24h).toMatchObject({ turns: 1, modelCalls: 2, promptTokens: 1000, avgTurnMs: 4000 });
  });

  it("treats absent token counts as 0 in sums and handles empty rows", () => {
    const noUsage = row({ promptTokens: undefined, completionTokens: undefined });
    expect(buildUsageMetrics([noUsage], NOW_ISO).promptTokens).toBe(0);
    expect(buildUsageMetrics([], NOW_ISO)).toMatchObject({ turns: 0, avgTurnMs: 0, maxTurnMs: 0 });
  });

  it("sums cached prompt tokens (total + last24h), treating an absent cache count as 0", () => {
    const old = row({ createdAt: "2026-06-01T00:00:00.000Z", cachedPromptTokens: 700 });
    const recentHit = row({ cachedPromptTokens: 640 });
    const recentNoCache = row({ cachedPromptTokens: undefined }); // backend reported no cache info
    const metrics = buildUsageMetrics([old, recentHit, recentNoCache], NOW_ISO);
    expect(metrics.cachedPromptTokens).toBe(1340); // 700 + 640 + 0
    expect(metrics.last24h.cachedPromptTokens).toBe(640); // the old row falls out of 24h
    expect(buildUsageMetrics([], NOW_ISO).cachedPromptTokens).toBe(0);
  });
});
