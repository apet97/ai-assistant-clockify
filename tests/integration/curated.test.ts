import { describe, expect, it } from "vitest";
import { executeAction, commitConfirmedOperation } from "../../src/harness/actions.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext, ConfirmableOperation } from "../../src/harness/catalog.js";

function ctx(fake: FakeWorkspace): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy: defaultAdminPolicy(),
    clockify: fake.client,
    now: () => new Date("2026-06-05T00:00:00.000Z"),
  };
}

describe("clockify_period_report (curated read job)", () => {
  it("resolves a period keyword to a date range server-side and runs the report", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_period_report",
      args: { period: "last_month", type: "summary" },
      context: ctx(fake),
    });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt" && result.receipt.ok) {
      const data = result.receipt.data as { period: string; type: string; range: { dateRangeStart: string; dateRangeEnd: string } };
      expect(data.period).toBe("last_month");
      expect(data.range.dateRangeStart).toBe("2026-05-01T00:00:00.000Z");
      expect(data.range.dateRangeEnd).toBe("2026-05-31T23:59:59.999Z");
    } else {
      throw new Error("expected a success receipt");
    }
    expect(fake.counts.summaryReport).toBe(1);
  });

  it("defaults to a last-7-days summary when no period/type is given", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({ actionName: "clockify_period_report", args: {}, context: ctx(fake) });
    expect(result.kind).toBe("receipt");
    expect(fake.counts.summaryReport).toBe(1);
  });
});

describe("clockify_onboard_user (curated risky job — invite + group adds)", () => {
  it("previews the invite + group adds as one card (not executed yet)", async () => {
    const fake = createFakeWorkspace({ groups: [{ id: "g1", name: "Engineering" }] });
    const result = await executeAction({
      actionName: "clockify_onboard_user",
      args: { email: "ada@example.com", groups: ["Engineering"] },
      context: ctx(fake),
    });
    expect(result.kind).toBe("preview");
    if (result.kind === "preview") {
      const text = result.preview.expectedChanges.join(" ");
      expect(text).toContain("ada@example.com");
      expect(text).toContain("Engineering");
    }
    expect(fake.counts.inviteUser ?? 0).toBe(0); // preview-only
  });

  it("commits as one composed transaction: invites then adds to the resolved group", async () => {
    const fake = createFakeWorkspace({ groups: [{ id: "g1", name: "Engineering" }] });
    const preview = await executeAction({
      actionName: "clockify_onboard_user",
      args: { email: "ada@example.com", groups: ["Engineering"] },
      context: ctx(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    const receipt = await commitConfirmedOperation(ctx(fake), preview.operation as ConfirmableOperation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.inviteUser).toBe(1);
    expect(fake.counts.addUserToGroup).toBe(1);
    if (receipt.ok) expect((receipt.changed?.created ?? []).some((e) => e.type === "user")).toBe(true);
  });

  it("sendEmail=false previews truthfully: no 'sends a real invitation' warning", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_onboard_user",
      args: { email: "ada@example.com", sendEmail: false },
      context: ctx(fake),
    });
    if (result.kind !== "preview") throw new Error("expected a preview");
    const warnings = (result.preview.warnings ?? []).join(" ");
    expect(warnings).not.toMatch(/sends a real invitation/i);
    expect(warnings).toMatch(/without an invitation email/i);
  });

  it("fetches the group list ONCE per commit, not once per group (no N+1)", async () => {
    const fake = createFakeWorkspace({
      groups: [
        { id: "g1", name: "Engineering" },
        { id: "g2", name: "Design" },
        { id: "g3", name: "Sales" },
      ],
    });
    const preview = await executeAction({
      actionName: "clockify_onboard_user",
      args: { email: "ada@example.com", groups: ["Engineering", "Design", "Sales"] },
      context: ctx(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    const receipt = await commitConfirmedOperation(ctx(fake), preview.operation as ConfirmableOperation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.addUserToGroup).toBe(3);
    // The group list is identical across the per-group steps within one commit —
    // resolve it once, not once per group.
    expect(fake.counts.listGroups).toBe(1);
  });

  it("a missing group is a warning — the user is still invited (best-effort group adds)", async () => {
    const fake = createFakeWorkspace(); // no groups configured
    const preview = await executeAction({
      actionName: "clockify_onboard_user",
      args: { email: "ada@example.com", groups: ["Nonexistent"] },
      context: ctx(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    const receipt = await commitConfirmedOperation(ctx(fake), preview.operation as ConfirmableOperation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.inviteUser).toBe(1);
    expect(fake.counts.addUserToGroup ?? 0).toBe(0);
    if (receipt.ok) expect((receipt.warnings ?? []).some((w) => /group/i.test(w.message))).toBe(true);
  });
});

describe("period_report weekly clamp (live-loop FIX 2: a month range 400s 'exactly 7 days')", () => {
  it("clamps a longer period to the exact last 7 days of the range for the weekly report", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_period_report",
      args: { period: "last_month", type: "weekly" },
      context: ctx(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected a success receipt");
    const data = result.receipt.data as any;
    // last_month = 2026-05-01 → 2026-05-31; the weekly report gets its last 7 days.
    expect(data.report.range).toEqual({
      dateRangeStart: "2026-05-25T00:00:00.000Z",
      dateRangeEnd: "2026-05-31T23:59:59.999Z",
    });
    expect(fake.counts.weeklyReport).toBe(1);
  });

  it("leaves an exact-7-day period (last_week) untouched", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_period_report",
      args: { period: "last_week", type: "weekly" },
      context: ctx(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected a success receipt");
    const data = result.receipt.data as any;
    // 2026-06-05 is a Friday → last week = Mon 2026-05-25 … Sun 2026-05-31.
    expect(data.report.range).toEqual({
      dateRangeStart: "2026-05-25T00:00:00.000Z",
      dateRangeEnd: "2026-05-31T23:59:59.999Z",
    });
  });
});
