import { describe, expect, it } from "vitest";
import { executeAction } from "../../src/harness/actions.js";
import { type AdminPolicy, defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext } from "../../src/harness/action.js";

const NOW = new Date("2026-06-06T00:00:00.000Z");
function makeContext(fake: FakeWorkspace, policy: AdminPolicy = defaultAdminPolicy()): ActionContext {
  return { workspaceId: "ws-1", adminUserId: "admin-1", policy, clockify: fake.client, now: () => NOW };
}
const range = { dateRangeStart: "2026-06-01T00:00:00Z", dateRangeEnd: "2026-06-30T23:59:59Z" };

describe("report actions", () => {
  it("reports_summary is read-gated and returns the report (with byte count)", async () => {
    const fake = createFakeWorkspace();
    const ok = await executeAction({ actionName: "clockify_reports_summary", args: range, context: makeContext(fake) });
    if (ok.kind === "receipt" && ok.receipt.ok) {
      expect((ok.receipt.data as any).report).toMatchObject({ type: "summary" });
      expect((ok.receipt.data as any).truncated).toBe(false);
      expect((ok.receipt.data as any).bytes).toBeGreaterThan(0);
    } else throw new Error("expected receipt");
    expect(fake.counts.summaryReport).toBe(1);

    const off = defaultAdminPolicy();
    off.groups.reports = "off";
    const denied = await executeAction({ actionName: "clockify_reports_summary", args: range, context: makeContext(fake, off) });
    if (denied.kind === "receipt" && !denied.receipt.ok) expect(denied.receipt.code).toBe("policy_denied");
    else throw new Error("expected policy_denied");
  });

  it("reports default the date range when the planner omits it (summary/detailed/weekly)", async () => {
    const fake = createFakeWorkspace();
    const s = await executeAction({ actionName: "clockify_reports_summary", args: {}, context: makeContext(fake) });
    if (s.kind === "receipt" && s.receipt.ok) {
      const r = (s.receipt.data as any).report.range;
      expect(r.dateRangeStart).toBeTruthy();
      expect(r.dateRangeEnd).toBeTruthy();
    } else throw new Error("expected receipt");
    const w = await executeAction({ actionName: "clockify_reports_weekly", args: {}, context: makeContext(fake) });
    expect(w.kind === "receipt" && w.receipt.ok).toBe(true);
    const d2 = await executeAction({ actionName: "clockify_reports_detailed", args: {}, context: makeContext(fake) });
    expect(d2.kind === "receipt" && d2.receipt.ok).toBe(true);
    expect(fake.counts.summaryReport).toBe(1);
    expect(fake.counts.weeklyReport).toBe(1);
    expect(fake.counts.detailedReport).toBe(1);
  });

  it("reports_detailed + reports_weekly read", async () => {
    const fake = createFakeWorkspace();
    const d = await executeAction({ actionName: "clockify_reports_detailed", args: range, context: makeContext(fake) });
    if (d.kind === "receipt" && d.receipt.ok) expect((d.receipt.data as any).report).toMatchObject({ type: "detailed" });
    else throw new Error("expected receipt");
    const w = await executeAction({ actionName: "clockify_reports_weekly", args: range, context: makeContext(fake) });
    if (w.kind === "receipt" && w.receipt.ok) expect((w.receipt.data as any).report).toMatchObject({ type: "weekly" });
    else throw new Error("expected receipt");
  });
});

describe("report date normalization (live-loop FIX 2: 'Invalid date!' 400s)", () => {
  it("resolves relative range words to UTC instants before they reach the reports host", async () => {
    const fake = createFakeWorkspace();
    // NOW is 2026-06-06.
    const result = await executeAction({
      actionName: "clockify_reports_summary",
      args: { dateRangeStart: "yesterday", dateRangeEnd: "yesterday" },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected a success receipt");
    // The fake echoes the range it was called with.
    expect((result.receipt.data as any).report.range).toEqual({
      dateRangeStart: "2026-06-05T00:00:00.000Z",
      dateRangeEnd: "2026-06-05T23:59:59.999Z",
    });
  });

  it("clarifies on an unparseable range instead of sending it", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_reports_weekly",
      args: { dateRangeStart: "since the sprint started" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.weeklyReport ?? 0).toBe(0);
  });
});
