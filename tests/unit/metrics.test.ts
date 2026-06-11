import { describe, expect, it } from "vitest";
import { buildMetrics, type ActionOutcome } from "../../src/metrics/metrics.js";

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

  it("summarizes confirmation outcomes (used→confirmed)", () => {
    // Only statuses the store actually produces: used / cancelled / failed /
    // pending, plus the 'expired' the store derives for a lapsed pending row.
    const m = buildMetrics([], ["used", "used", "cancelled", "expired", "failed", "pending"], "t");
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
