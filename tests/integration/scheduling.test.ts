import { describe, expect, it } from "vitest";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { type AdminPolicy, defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext } from "../../src/harness/action.js";

const NOW = new Date("2026-06-06T00:00:00.000Z");
function makeContext(fake: FakeWorkspace, policy: AdminPolicy = defaultAdminPolicy()): ActionContext {
  return { workspaceId: "ws-1", adminUserId: "admin-1", policy, clockify: fake.client, now: () => NOW };
}
const seed = () => ({ assignments: [{ id: "a1", userId: "u1", projectId: "p1", start: "2026-06-01", end: "2026-06-05", hoursPerDay: 8 }] });

describe("scheduling actions", () => {
  it("assignments_list is read-gated", async () => {
    const fake = createFakeWorkspace(seed());
    const ok = await executeAction({ actionName: "clockify_scheduling_assignments_list", args: {}, context: makeContext(fake) });
    if (ok.kind === "receipt" && ok.receipt.ok) expect((ok.receipt.data as any).count).toBe(1);
    else throw new Error("expected receipt");
    const off = defaultAdminPolicy();
    off.groups.scheduling = "off";
    const denied = await executeAction({ actionName: "clockify_scheduling_assignments_list", args: {}, context: makeContext(fake, off) });
    if (denied.kind === "receipt" && !denied.receipt.ok) expect(denied.receipt.code).toBe("policy_denied");
    else throw new Error("expected policy_denied");
  });

  it("assignments_get + totals read", async () => {
    const fake = createFakeWorkspace(seed());
    const get = await executeAction({ actionName: "clockify_scheduling_assignments_get", args: { id: "a1" }, context: makeContext(fake) });
    if (get.kind === "receipt" && get.receipt.ok) expect((get.receipt.data as any).entity).toMatchObject({ id: "a1" });
    else throw new Error("expected receipt");
    const ut = await executeAction({ actionName: "clockify_scheduling_user_totals", args: { start: "2026-06-01", end: "2026-06-30" }, context: makeContext(fake) });
    if (ut.kind === "receipt" && ut.receipt.ok) expect(ut.receipt.ok).toBe(true);
    else throw new Error("expected receipt");
  });

  it("assignments_create is a SAFE write (executes immediately)", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({ actionName: "clockify_scheduling_assignments_create", args: { userId: "u1", projectId: "p1", start: "2026-06-01", end: "2026-06-05", hoursPerDay: 8 }, context: makeContext(fake) });
    if (result.kind === "receipt" && result.receipt.ok) expect(result.receipt.changed?.created?.[0]).toMatchObject({ type: "assignment" });
    else throw new Error("expected receipt");
    expect(fake.counts.createAssignment).toBe(1);
  });

  it("assignments_update previews high_risk_write then updates", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({ actionName: "clockify_scheduling_assignments_update", args: { id: "a1", hoursPerDay: 6 }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("high_risk_write");
    await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(fake.state.assignments[0].hoursPerDay).toBe(6);
  });

  it("assignments_delete previews destructive then deletes", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({ actionName: "clockify_scheduling_assignments_delete", args: { id: "a1", seriesUpdateOption: "ALL" }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("destructive");
    await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(fake.counts.deleteAssignment).toBe(1);
    expect(fake.state.assignments.find((a) => a.id === "a1")).toBeUndefined();
  });

  it("publish previews external_side_effect then publishes", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({ actionName: "clockify_scheduling_publish", args: { start: "2026-06-01", end: "2026-06-07", notifyUsers: false }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("external_side_effect");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.publishSchedule).toBe(1);
  });
});

describe("scheduling date normalization (live-loop FIX 2: invalid start/end)", () => {
  it("assignments_create resolves relative start/end to the wire's UTC instants", async () => {
    const fake = createFakeWorkspace();
    // NOW is 2026-06-06 (a Saturday) → next monday = 2026-06-08.
    const result = await executeAction({
      actionName: "clockify_scheduling_assignments_create",
      args: { userId: "u1", projectId: "p1", start: "next monday", end: "next friday", hoursPerDay: 8 },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("receipt");
    expect(fake.state.assignments[0]).toMatchObject({
      start: "2026-06-08T00:00:00.000Z",
      end: "2026-06-12T23:59:59.999Z",
    });
  });

  it("assignments_create clarifies on an unparseable date instead of a doomed call", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_scheduling_assignments_create",
      args: { userId: "u1", projectId: "p1", start: "soonish", end: "later", hoursPerDay: 8 },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.createAssignment ?? 0).toBe(0);
  });

  it("assignments_list resolves relative start/end and clarifies on garbage", async () => {
    const fake = createFakeWorkspace();
    const ok = await executeAction({
      actionName: "clockify_scheduling_assignments_list",
      args: { start: "today", end: "today" },
      context: makeContext(fake),
    });
    expect(ok.kind).toBe("receipt");

    const garbage = await executeAction({
      actionName: "clockify_scheduling_assignments_list",
      args: { start: "whenever" },
      context: makeContext(fake),
    });
    expect(garbage.kind).toBe("clarify");
    expect(fake.counts.listAssignments ?? 0).toBe(1);
  });

  it("assignments_list and publish resolve the FORWARD range 'next month' (live item 321)", async () => {
    const fake = createFakeWorkspace();
    const list = await executeAction({
      actionName: "clockify_scheduling_assignments_list",
      args: { start: "next month", end: "next month" },
      context: makeContext(fake),
    });
    expect(list.kind).toBe("receipt");

    // NOW = 2026-06-06 → next month = the full July 2026 window.
    const publish = await executeAction({
      actionName: "clockify_scheduling_publish",
      args: { start: "next month", end: "next month" },
      context: makeContext(fake),
    });
    if (publish.kind !== "preview") throw new Error(`expected a preview, got ${publish.kind}`);
    expect(publish.operation.payload).toMatchObject({
      start: "2026-07-01T00:00:00.000Z",
      end: "2026-07-31T23:59:59.999Z",
    });
  });

  it("publish + totals resolve relative ranges too", async () => {
    const fake = createFakeWorkspace();
    const publish = await executeAction({
      actionName: "clockify_scheduling_publish",
      args: { start: "today", end: "next friday" },
      context: makeContext(fake),
    });
    if (publish.kind !== "preview") throw new Error("expected a preview");
    expect(publish.operation.payload).toMatchObject({
      start: "2026-06-06T00:00:00.000Z",
      end: "2026-06-12T23:59:59.999Z",
    });

    const totals = await executeAction({
      actionName: "clockify_scheduling_user_totals",
      args: { start: "banana", end: "today" },
      context: makeContext(fake),
    });
    expect(totals.kind).toBe("clarify");
  });
});
