import { describe, expect, it } from "vitest";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { type AdminPolicy, defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext } from "../../src/harness/action.js";

const NOW = new Date("2026-06-06T00:00:00.000Z");
function makeContext(fake: FakeWorkspace, policy: AdminPolicy = defaultAdminPolicy()): ActionContext {
  return { workspaceId: "ws-1", adminUserId: "admin-1", policy, clockify: fake.client, now: () => NOW };
}
const seed = () => ({
  timeOffPolicies: [{ id: "pol1", name: "PTO", status: "ACTIVE" }],
  timeOffRequests: [{ id: "r1", policyId: "pol1", userId: "u1", status: "PENDING" }],
  timeOffBalances: [{ policyId: "pol1", policyName: "PTO", balance: 15, used: 5, total: 20 }],
  users: [
    { id: "u1", name: "Alice", email: "a@x.com", status: "ACTIVE" },
    { id: "u2", name: "Bob", email: "b@x.com", status: "ACTIVE" },
  ],
  groups: [{ id: "g1", name: "Devs", userIds: [] }],
});

describe("time-off actions", () => {
  it("policies_list is read-gated", async () => {
    const fake = createFakeWorkspace(seed());
    const ok = await executeAction({ actionName: "clockify_time_off_policies_list", args: {}, context: makeContext(fake) });
    if (ok.kind === "receipt" && ok.receipt.ok) expect((ok.receipt.data as any).count).toBe(1);
    else throw new Error("expected receipt");
    const off = defaultAdminPolicy();
    off.groups.time_off_approvals = "off";
    const denied = await executeAction({ actionName: "clockify_time_off_policies_list", args: {}, context: makeContext(fake, off) });
    if (denied.kind === "receipt" && !denied.receipt.ok) expect(denied.receipt.code).toBe("policy_denied");
    else throw new Error("expected policy_denied");
  });

  it("policies_create previews high_risk_write, injects the admin as owner, commits", async () => {
    const fake = createFakeWorkspace();
    const preview = await executeAction({ actionName: "clockify_time_off_policies_create", args: { name: "AIASSIST_SMOKE_pol", daysPerYear: 20 }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("high_risk_write");
    expect(fake.counts.createTimeOffPolicy ?? 0).toBe(0);
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.createTimeOffPolicy).toBe(1);
  });

  it("policies_create scopes to a user GROUP + user BY NAME (resolves), clarifies on an unknown group", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({ actionName: "clockify_time_off_policies_create", args: { name: "AIASSIST_SMOKE_pol2", userGroupIds: ["Devs"], userIds: ["Bob"] }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    expect(preview.preview.expectedChanges.join(" ")).toContain("Devs");
    await commitConfirmedOperation(makeContext(fake), preview.operation);
    const created = fake.state.timeOffPolicies.find((p) => p.name === "AIASSIST_SMOKE_pol2") as { userGroupIds?: string[]; userIds?: string[] } | undefined;
    expect(created?.userGroupIds).toEqual(["g1"]);
    expect(created?.userIds).toEqual(["u2"]);

    const bad = await executeAction({ actionName: "clockify_time_off_policies_create", args: { name: "X", userGroupIds: ["Ghosts"] }, context: makeContext(fake) });
    expect(bad.kind).toBe("clarify");
  });

  it("policies_update sets a user-group scope BY NAME", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({ actionName: "clockify_time_off_policies_update", args: { id: "pol1", userGroupIds: ["Devs"] }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    await commitConfirmedOperation(makeContext(fake), preview.operation);
    const updated = fake.state.timeOffPolicies.find((p) => p.id === "pol1") as { userGroupIds?: string[] } | undefined;
    expect(updated?.userGroupIds).toEqual(["g1"]);
  });

  it("policies_update previews then updates", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({ actionName: "clockify_time_off_policies_update", args: { id: "pol1", name: "PTO 2" }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("high_risk_write");
    await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(fake.state.timeOffPolicies[0].name).toBe("PTO 2");
  });

  it("policies_archive previews destructive then archives", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({ actionName: "clockify_time_off_policies_archive", args: { id: "pol1", name: "PTO" }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("destructive");
    await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(fake.state.timeOffPolicies[0].status).toBe("ARCHIVED");
  });

  it("policies_archive with archived=false previews an UNARCHIVE truthfully (no 'archiving stops requests' warning)", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_time_off_policies_archive",
      args: { id: "pol1", name: "PTO", archived: false },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    const warnings = (preview.preview.warnings ?? []).join(" ");
    expect(warnings).not.toMatch(/archiving a policy stops/i);
    expect(warnings).toMatch(/re-enables new requests/i);
  });

  it("requests_list reads + requests_create previews external_side_effect then commits", async () => {
    const fake = createFakeWorkspace(seed());
    const list = await executeAction({ actionName: "clockify_time_off_requests_list", args: {}, context: makeContext(fake) });
    if (list.kind === "receipt" && list.receipt.ok) expect((list.receipt.data as any).count).toBe(1);
    else throw new Error("expected receipt");
    const preview = await executeAction({
      actionName: "clockify_time_off_requests_create",
      args: { policyId: "pol1", start: "2026-07-01T00:00:00Z", end: "2026-07-03T00:00:00Z", days: 3, note: "vacay" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("external_side_effect");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.createTimeOffRequest).toBe(1);
  });

  it("approve / deny preview external_side_effect then set the request status", async () => {
    const fake = createFakeWorkspace(seed());
    const approve = await executeAction({ actionName: "clockify_time_off_approve", args: { policyId: "pol1", requestId: "r1" }, context: makeContext(fake) });
    if (approve.kind !== "preview") throw new Error("expected a preview");
    expect(approve.operation.risks).toContain("external_side_effect");
    await commitConfirmedOperation(makeContext(fake), approve.operation);
    expect(fake.state.timeOffRequests[0].status).toBe("APPROVED");

    const deny = await executeAction({ actionName: "clockify_time_off_deny", args: { policyId: "pol1", requestId: "r1", note: "no" }, context: makeContext(fake) });
    if (deny.kind !== "preview") throw new Error("expected a preview");
    await commitConfirmedOperation(makeContext(fake), deny.operation);
    expect(fake.state.timeOffRequests[0].status).toBe("REJECTED");
  });

  it("requests_delete previews destructive then deletes", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({ actionName: "clockify_time_off_requests_delete", args: { policyId: "pol1", requestId: "r1" }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("destructive");
    await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(fake.counts.deleteTimeOffRequest).toBe(1);
    expect(fake.state.timeOffRequests.find((r) => r.id === "r1")).toBeUndefined();
  });

  it("balance_get reads (defaults to the admin) + balance_update previews high_risk_write", async () => {
    const fake = createFakeWorkspace(seed());
    const get = await executeAction({ actionName: "clockify_time_off_balance_get", args: {}, context: makeContext(fake) });
    if (get.kind === "receipt" && get.receipt.ok) expect((get.receipt.data as any).count).toBe(1);
    else throw new Error("expected receipt");

    const preview = await executeAction({ actionName: "clockify_time_off_balance_update", args: { policyId: "pol1", userIds: ["u1"], value: 5 }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("high_risk_write");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.updateTimeOffBalance).toBe(1);
  });

  it("balance_update resolves policy + user NAMES at preview, clarifies on an unknown user", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({ actionName: "clockify_time_off_balance_update", args: { policyId: "PTO", userIds: ["Alice", "me"], value: 3 }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    expect(preview.operation.payload).toMatchObject({ policyId: "pol1", userIds: ["u1", "admin-1"] });
    expect(preview.preview.expectedChanges.join(" ")).toContain("Alice");

    const bad = await executeAction({ actionName: "clockify_time_off_balance_update", args: { policyId: "PTO", userIds: ["Ghost"], value: 3 }, context: makeContext(fake) });
    expect(bad.kind).toBe("clarify");
    expect(fake.counts.updateTimeOffBalance ?? 0).toBe(0);
  });
});

describe("time-off date normalization (live-loop FIX 2: the literal 'next Monday' reached the wire)", () => {
  it("requests_create resolves weekday words to bare dates server-side", async () => {
    const fake = createFakeWorkspace(seed());
    // NOW is 2026-06-06 (a Saturday) → next monday = 2026-06-08, next friday = 2026-06-12.
    const preview = await executeAction({
      actionName: "clockify_time_off_requests_create",
      args: { policyId: "pol1", start: "next Monday", end: "next Friday" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect((preview.operation.payload as any).input).toMatchObject({
      start: "2026-06-08",
      end: "2026-06-12",
    });
  });

  it("requests_create clarifies on an unparseable date", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({
      actionName: "clockify_time_off_requests_create",
      args: { policyId: "pol1", start: "sometime", end: "next Friday" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.createTimeOffRequest ?? 0).toBe(0);
  });
});

describe("time-off balance surfaced in the preview (live-loop FIX 4a: a zero-balance workspace 400s misleadingly)", () => {
  it("requests_create WARNS when the requested days exceed the policy balance", async () => {
    const fake = createFakeWorkspace({
      ...seed(),
      timeOffBalances: [{ policyId: "pol1", policyName: "PTO", balance: 0, used: 0, total: 0 }],
    });
    const preview = await executeAction({
      actionName: "clockify_time_off_requests_create",
      args: { policyId: "pol1", start: "2026-07-01", end: "2026-07-03" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.preview.warnings.some((w) => /balance/i.test(w))).toBe(true);
  });

  it("requests_create does NOT add the balance warning when the balance covers the request", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_time_off_requests_create",
      args: { policyId: "pol1", start: "2026-07-01", end: "2026-07-03" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.preview.warnings.some((w) => /balance/i.test(w))).toBe(false);
  });
});
