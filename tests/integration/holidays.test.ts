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
    const fake = createFakeWorkspace(seed());
    const get = await executeAction({ actionName: "clockify_holidays_get", args: { id: "h1" }, context: makeContext(fake) });
    if (get.kind === "receipt" && get.receipt.ok) expect((get.receipt.data as any).entity).toMatchObject({ id: "h1" });
    else throw new Error("expected receipt");
    const period = await executeAction({ actionName: "clockify_holidays_in_period", args: { assignedTo: "u1", start: "2026-12-01", end: "2026-12-31" }, context: makeContext(fake) });
    if (period.kind === "receipt" && period.receipt.ok) expect((period.receipt.data as any).count).toBe(1);
    else throw new Error("expected receipt");
  });

  it("holidays_create is a SAFE write (executes immediately) and needs an assignment", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_holidays_create",
      args: { name: "AIASSIST_SMOKE_hol", startDate: "2026-07-01", userIds: ["admin-1"] },
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

  it("holidays_update is a SAFE write (executes immediately)", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({ actionName: "clockify_holidays_update", args: { id: "h1", name: "Christmas" }, context: makeContext(fake) });
    if (result.kind === "receipt" && result.receipt.ok) expect(result.receipt.changed?.updated?.[0]).toMatchObject({ type: "holiday" });
    else throw new Error("expected receipt");
    expect(fake.state.holidays[0].name).toBe("Christmas");
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
