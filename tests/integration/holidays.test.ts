import { describe, expect, it } from "vitest";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { type AdminPolicy, defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext } from "../../src/harness/action.js";

const NOW = new Date("2026-06-06T00:00:00.000Z");
function makeContext(fake: FakeWorkspace, policy: AdminPolicy = defaultAdminPolicy()): ActionContext {
  return { workspaceId: "ws-1", adminUserId: "admin-1", policy, clockify: fake.client, now: () => NOW };
}
const seed = () => ({ holidays: [{ id: "h1", name: "Xmas", startDate: "2026-12-25", endDate: "2026-12-25" }] });
const directory = () => ({
  users: [
    { id: "u1", name: "Alice", email: "a@x.com", status: "ACTIVE" },
    { id: "u2", name: "Bob", email: "b@x.com", status: "ACTIVE" },
  ],
  groups: [{ id: "g1", name: "Devs", userIds: [] }],
});

describe("holiday actions", () => {
  it("holidays_list is read-gated", async () => {
    const fake = createFakeWorkspace(seed());
    const ok = await executeAction({ actionName: "clockify_holidays_list", args: {}, context: makeContext(fake) });
    if (ok.kind === "receipt" && ok.receipt.ok) expect((ok.receipt.data as any).count).toBe(1);
    else throw new Error("expected receipt");
    const off = defaultAdminPolicy();
    off.groups.time_off_approvals = "off";
    const denied = await executeAction({ actionName: "clockify_holidays_list", args: {}, context: makeContext(fake, off) });
    if (denied.kind === "receipt" && !denied.receipt.ok) expect(denied.receipt.code).toBe("policy_denied");
    else throw new Error("expected policy_denied");
  });

  it("holidays_get + holidays_in_period read", async () => {
    // assignedTo resolves against the real user list — the directory must exist.
    const fake = createFakeWorkspace({ ...seed(), ...directory() });
    const get = await executeAction({ actionName: "clockify_holidays_get", args: { id: "h1" }, context: makeContext(fake) });
    if (get.kind === "receipt" && get.receipt.ok) expect((get.receipt.data as any).entity).toMatchObject({ id: "h1" });
    else throw new Error("expected receipt");
    const period = await executeAction({ actionName: "clockify_holidays_in_period", args: { assignedTo: "u1", start: "2026-12-01", end: "2026-12-31" }, context: makeContext(fake) });
    if (period.kind === "receipt" && period.receipt.ok) expect((period.receipt.data as any).count).toBe(1);
    else throw new Error("expected receipt");
  });

  it("holidays_in_period resolves a user NAME (defaults to the caller) and RELATIVE dates server-side", async () => {
    const fake = createFakeWorkspace({
      holidays: [{ id: "h2", name: "Midsummer", startDate: "2026-06-19", endDate: "2026-06-19" }],
      ...directory(),
    });
    // NOW is 2026-06-06: "this month" should cover the June 19 holiday.
    const byName = await executeAction({
      actionName: "clockify_holidays_in_period",
      args: { assignedTo: "Alice", start: "this month", end: "this month" },
      context: makeContext(fake),
    });
    if (byName.kind !== "receipt" || !byName.receipt.ok) throw new Error(`expected a receipt, got ${byName.kind}`);
    expect((byName.receipt.data as any).count).toBe(1);

    // Omitted assignedTo defaults to the caller (the admin).
    const mine = await executeAction({
      actionName: "clockify_holidays_in_period",
      args: { start: "2026-06-01", end: "2026-06-30" },
      context: makeContext(fake),
    });
    if (mine.kind !== "receipt" || !mine.receipt.ok) throw new Error(`expected a receipt, got ${mine.kind}`);
  });

  it("holidays_in_period clarifies on an unknown user or an unparseable date", async () => {
    const fake = createFakeWorkspace({ ...seed(), ...directory() });
    const badUser = await executeAction({
      actionName: "clockify_holidays_in_period",
      args: { assignedTo: "Ghost", start: "2026-12-01", end: "2026-12-31" },
      context: makeContext(fake),
    });
    expect(badUser.kind).toBe("clarify");

    const badDate = await executeAction({
      actionName: "clockify_holidays_in_period",
      args: { assignedTo: "u1", start: "whenever", end: "2026-12-31" },
      context: makeContext(fake),
    });
    expect(badDate.kind).toBe("clarify");
    expect(fake.counts.listHolidaysInPeriod ?? 0).toBe(0);
  });

  it("holidays_create is a SAFE write (executes immediately) and needs an assignment", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_holidays_create",
      args: { name: "AIASSIST_SMOKE_hol", startDate: "2026-07-01", userIds: ["me"] },
      context: makeContext(fake),
    });
    if (result.kind === "receipt" && result.receipt.ok) expect(result.receipt.changed?.created?.[0]).toMatchObject({ type: "holiday" });
    else throw new Error("expected receipt");
    expect(fake.counts.createHoliday).toBe(1);
    expect(fake.state.holidays.find((h) => h.name === "AIASSIST_SMOKE_hol")).toBeDefined();

    // no assignment -> invalid_args, no write
    const bad = await executeAction({ actionName: "clockify_holidays_create", args: { name: "X", startDate: "2026-07-01" }, context: makeContext(fake) });
    if (bad.kind === "receipt" && !bad.receipt.ok) expect(bad.receipt.code).toBe("invalid_args");
    else throw new Error("expected invalid_args");
  });

  it("holidays_create resolves user + group NAMES (and 'me') to ids before the write", async () => {
    const fake = createFakeWorkspace(directory());
    const result = await executeAction({
      actionName: "clockify_holidays_create",
      args: { name: "AIASSIST_SMOKE_hol2", startDate: "2026-07-01", userIds: ["Alice", "me"], userGroupIds: ["Devs"] },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error(`expected an ok receipt, got ${result.kind}`);
    const created = fake.state.holidays.find((h) => h.name === "AIASSIST_SMOKE_hol2") as { userIds?: string[]; userGroupIds?: string[] } | undefined;
    expect(created?.userIds).toEqual(["u1", "admin-1"]);
    expect(created?.userGroupIds).toEqual(["g1"]);
  });

  it("holidays_create clarifies on an unknown group name (no write)", async () => {
    const fake = createFakeWorkspace(directory());
    const result = await executeAction({
      actionName: "clockify_holidays_create",
      args: { name: "X", startDate: "2026-07-01", userGroupIds: ["Ghosts"] },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.createHoliday ?? 0).toBe(0);
  });

  it("holidays_create resolves a relative startDate server-side and clarifies on a non-date", async () => {
    // Dates server-side: the model must never compute a calendar date. A relative
    // day resolves; a fabricated/non-date string clarifies instead of fabricating a
    // value that 400s (or silently mis-dates) at the wire.
    const fake = createFakeWorkspace();
    const rel = await executeAction({
      actionName: "clockify_holidays_create",
      args: { name: "AIASSIST_SMOKE_rel", startDate: "tomorrow", userIds: ["me"] },
      context: makeContext(fake),
    });
    if (rel.kind !== "receipt" || !rel.receipt.ok) throw new Error(`expected an ok receipt, got ${rel.kind}`);
    // NOW = 2026-06-06 → tomorrow = 2026-06-07 (resolved by the harness, not the model).
    expect(fake.state.holidays.find((h) => h.name === "AIASSIST_SMOKE_rel")?.startDate).toBe("2026-06-07");

    const bad = await executeAction({
      actionName: "clockify_holidays_create",
      args: { name: "X", startDate: "Christmas", userIds: ["me"] },
      context: makeContext(fake),
    });
    expect(bad.kind).toBe("clarify");
    expect(fake.counts.createHoliday).toBe(1); // the non-date never reached the wire
  });

  it("holidays_update resolves group NAMES to ids at PREVIEW time (no commit yet)", async () => {
    const fake = createFakeWorkspace({ ...directory(), holidays: [{ id: "h1", name: "Xmas", startDate: "2026-12-25" }] });
    const result = await executeAction({
      actionName: "clockify_holidays_update",
      args: { id: "h1", userGroupIds: ["Devs"] },
      context: makeContext(fake),
    });
    if (result.kind !== "preview") throw new Error("expected a preview — editing live data requires confirmation");
    // The name resolves to an id in the previewed payload; the live holiday is untouched until confirm.
    expect((result.operation.payload as { body: { userGroupIds?: string[] } }).body.userGroupIds).toEqual(["g1"]);
    const live = fake.state.holidays.find((h) => h.id === "h1") as { userGroupIds?: string[] } | undefined;
    expect(live?.userGroupIds).toBeUndefined();
  });

  it("holidays_update PREVIEWS then commit applies it (editing live data is high_risk_write)", async () => {
    const fake = createFakeWorkspace(seed());
    const ctx = makeContext(fake);
    const result = await executeAction({ actionName: "clockify_holidays_update", args: { id: "h1", name: "Christmas" }, context: ctx });
    if (result.kind !== "preview") throw new Error("expected a preview, not an immediate write");
    expect(fake.state.holidays[0].name).toBe("Xmas"); // NOT applied before confirm
    const receipt = await commitConfirmedOperation(ctx, result.operation);
    expect(receipt.ok).toBe(true);
    if (receipt.ok) expect(receipt.changed?.updated?.[0]).toMatchObject({ type: "holiday" });
    expect(fake.state.holidays[0].name).toBe("Christmas"); // applied only after confirm
  });

  it("holidays_delete previews destructive then deletes once", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({ actionName: "clockify_holidays_delete", args: { id: "h1", name: "Xmas" }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("destructive");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.deleteHoliday).toBe(1);
    expect(fake.state.holidays.find((h) => h.id === "h1")).toBeUndefined();
  });
});
