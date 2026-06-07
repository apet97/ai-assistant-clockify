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
  users: [{ id: "admin-1", name: "Me", email: "me@x.com", status: "ACTIVE" }, { id: "u2", name: "Bob", email: "bob@x.com", status: "ACTIVE" }],
  groups: [{ id: "g1", name: "Devs", userIds: [] }],
});

describe("user & group actions", () => {
  it("users_list is read-gated", async () => {
    const fake = createFakeWorkspace(seed());
    const ok = await executeAction({ actionName: "clockify_users_list", args: {}, context: makeContext(fake) });
    if (ok.kind === "receipt" && ok.receipt.ok) expect((ok.receipt.data as any).count).toBe(2);
    else throw new Error("expected receipt");
    const off = defaultAdminPolicy();
    off.groups.users_groups = "off";
    const denied = await executeAction({ actionName: "clockify_users_list", args: {}, context: makeContext(fake, off) });
    if (denied.kind === "receipt" && !denied.receipt.ok) expect(denied.receipt.code).toBe("policy_denied");
    else throw new Error("expected policy_denied");
  });

  it("invite previews external_side_effect (no email by default) then commits", async () => {
    const fake = createFakeWorkspace();
    const preview = await executeAction({ actionName: "clockify_users_invite", args: { email: "new@x.com" }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("external_side_effect");
    expect(preview.operation.payload).toMatchObject({ sendEmail: false });
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.inviteUser).toBe(1);
  });

  it("role_update + deactivate preview high_risk_write; uses high_risk_write NOT permission_change", async () => {
    const fake = createFakeWorkspace(seed());
    const role = await executeAction({ actionName: "clockify_users_role_update", args: { userId: "u2", role: "TEAM_MANAGER", entityId: "team1" }, context: makeContext(fake) });
    if (role.kind !== "preview") throw new Error("expected a preview");
    expect(role.operation.risks).toContain("high_risk_write");
    expect(role.operation.risks).not.toContain("permission_change");
    await commitConfirmedOperation(makeContext(fake), role.operation);
    expect(fake.counts.updateUserRole).toBe(1);

    const deact = await executeAction({ actionName: "clockify_users_deactivate", args: { userId: "u2" }, context: makeContext(fake) });
    if (deact.kind !== "preview") throw new Error("expected a preview");
    expect(deact.operation.risks).toContain("high_risk_write");
    await commitConfirmedOperation(makeContext(fake), deact.operation);
    expect(fake.state.users.find((u) => u.id === "u2")?.status).toBe("INACTIVE");
  });

  it("deactivate refuses self-deactivation (no preview, no commit)", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({ actionName: "clockify_users_deactivate", args: { userId: "admin-1" }, context: makeContext(fake) });
    if (result.kind === "receipt" && !result.receipt.ok) expect(result.receipt.code).toBe("invalid_args");
    else throw new Error("expected refusal");
    expect(fake.counts.deactivateUser ?? 0).toBe(0);
  });

  it("groups CRUD + add/remove member round-trip", async () => {
    const fake = createFakeWorkspace(seed());
    const create = await executeAction({ actionName: "clockify_groups_create", args: { name: "AIASSIST_SMOKE_grp" }, context: makeContext(fake) });
    if (create.kind !== "preview") throw new Error("expected a preview");
    expect(create.operation.risks).toContain("high_risk_write");
    const cr = await commitConfirmedOperation(makeContext(fake), create.operation);
    if (!cr.ok) throw new Error("expected created group");
    const gid = (cr.changed?.created?.[0] as any)?.id as string;
    expect(gid).toBeTruthy();

    const add = await executeAction({ actionName: "clockify_groups_add_user", args: { groupId: gid, userId: "u2" }, context: makeContext(fake) });
    if (add.kind === "preview") await commitConfirmedOperation(makeContext(fake), add.operation);
    expect(fake.state.groups.find((g) => g.id === gid)?.userIds).toContain("u2");

    const remove = await executeAction({ actionName: "clockify_groups_remove_user", args: { groupId: gid, userId: "u2" }, context: makeContext(fake) });
    if (remove.kind !== "preview") throw new Error("expected a preview");
    expect(remove.operation.risks).toContain("destructive");
    await commitConfirmedOperation(makeContext(fake), remove.operation);
    expect(fake.state.groups.find((g) => g.id === gid)?.userIds).not.toContain("u2");

    const del = await executeAction({ actionName: "clockify_groups_delete", args: { id: gid }, context: makeContext(fake) });
    if (del.kind !== "preview") throw new Error("expected a preview");
    expect(del.operation.risks).toContain("destructive");
    await commitConfirmedOperation(makeContext(fake), del.operation);
    expect(fake.state.groups.find((g) => g.id === gid)).toBeUndefined();
  });
});
