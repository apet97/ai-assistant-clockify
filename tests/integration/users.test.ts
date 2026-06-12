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
  projects: [{ id: "p1", name: "Apollo" }],
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
    const role = await executeAction({ actionName: "clockify_users_role_update", args: { userId: "u2", role: "TEAM_MANAGER", groupName: "Devs" }, context: makeContext(fake) });
    if (role.kind !== "preview") throw new Error("expected a preview");
    expect(role.operation.risks).toContain("high_risk_write");
    expect(role.operation.risks).not.toContain("permission_change");
    // The recipient (u2) is the grantee; the group is the scope.
    expect((role.operation.payload as any).granteeId).toBe("u2");
    await commitConfirmedOperation(makeContext(fake), role.operation);
    expect(fake.counts.updateUserRole).toBe(1);

    const deact = await executeAction({ actionName: "clockify_users_deactivate", args: { userId: "u2" }, context: makeContext(fake) });
    if (deact.kind !== "preview") throw new Error("expected a preview");
    expect(deact.operation.risks).toContain("high_risk_write");
    await commitConfirmedOperation(makeContext(fake), deact.operation);
    expect(fake.state.users.find((u) => u.id === "u2")?.status).toBe("INACTIVE");
  });

  it("role_update scopes entityId per role (live-verified): PM→project, TM→group+USER_GROUP, ADMIN→workspace; bad ids clarify", async () => {
    const fake = createFakeWorkspace(seed());
    const ctx = makeContext(fake);
    // PROJECT_MANAGER → entityId is the PROJECT, no sourceType. Recipient resolved by name.
    const pm = await executeAction({ actionName: "clockify_users_role_update", args: { userName: "Bob", role: "PROJECT_MANAGER", projectName: "Apollo" }, context: ctx });
    if (pm.kind !== "preview") throw new Error("expected a preview");
    expect(pm.operation.payload).toMatchObject({ granteeId: "u2", entityId: "p1", role: "PROJECT_MANAGER" });
    expect((pm.operation.payload as any).sourceType).toBeUndefined();

    // TEAM_MANAGER of a group → entityId is the GROUP, sourceType USER_GROUP.
    const tm = await executeAction({ actionName: "clockify_users_role_update", args: { userName: "Bob", role: "TEAM_MANAGER", groupName: "Devs" }, context: ctx });
    if (tm.kind !== "preview") throw new Error("expected a preview");
    expect(tm.operation.payload).toMatchObject({ granteeId: "u2", entityId: "g1", role: "TEAM_MANAGER", sourceType: "USER_GROUP" });

    // WORKSPACE_ADMIN → entityId is the workspace; no scope param needed.
    const admin = await executeAction({ actionName: "clockify_users_role_update", args: { userName: "Bob", role: "WORKSPACE_ADMIN" }, context: ctx });
    if (admin.kind !== "preview") throw new Error("expected a preview");
    expect(admin.operation.payload).toMatchObject({ granteeId: "u2", entityId: "ws-1", role: "WORKSPACE_ADMIN" });

    // The live bug shape: a project id in the recipient slot is NOT a member → clarify.
    const badUser = await executeAction({ actionName: "clockify_users_role_update", args: { userId: "6a2be82c0cf5bebaba4dace3", role: "PROJECT_MANAGER", projectName: "Apollo" }, context: ctx });
    expect(badUser.kind).toBe("clarify");
    // PROJECT_MANAGER with no project scope → clarify (don't guess).
    const noScope = await executeAction({ actionName: "clockify_users_role_update", args: { userName: "Bob", role: "PROJECT_MANAGER" }, context: ctx });
    expect(noScope.kind).toBe("clarify");
    expect(fake.counts.updateUserRole ?? 0).toBe(0);
  });

  it("rate_update sets a workspace member's Team-section rate (billing): resolves name/me, major→minor, truthful preview", async () => {
    const fake = createFakeWorkspace(seed());
    const ctx = makeContext(fake);
    // Resolve a member by name; 60 major → 6000 minor; billing risk, gated by invoices.
    const byName = await executeAction({ actionName: "clockify_users_rate_update", args: { userName: "Bob", rateKind: "HOURLY", amount: 60 }, context: ctx });
    if (byName.kind !== "preview") throw new Error("expected a preview");
    expect(byName.operation.risks).toContain("billing");
    expect(byName.operation.featureGroup).toBe("invoices");
    expect(byName.operation.payload).toMatchObject({ userId: "u2", rateKind: "HOURLY", amountMinor: 6000 });
    // Truthful preview: shows the major amount, never raw minor units.
    const change = byName.preview.expectedChanges.join(" ");
    expect(change).toContain("60.00");
    expect(change).not.toContain("minor");
    expect(change).not.toContain("6000");
    const receipt = await commitConfirmedOperation(makeContext(fake), byName.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.updateWorkspaceMemberRate).toBe(1);

    // "me" resolves to the admin.
    const me = await executeAction({ actionName: "clockify_users_rate_update", args: { userId: "me", rateKind: "COST", amount: 25 }, context: ctx });
    if (me.kind !== "preview") throw new Error("expected a preview");
    expect(me.operation.payload).toMatchObject({ userId: "admin-1", rateKind: "COST", amountMinor: 2500 });
  });

  it("rate_update clarifies when the member isn't a workspace user (never confirm-then-fail)", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({ actionName: "clockify_users_rate_update", args: { userName: "Nobody", rateKind: "HOURLY", amount: 10 }, context: makeContext(fake) });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.updateWorkspaceMemberRate ?? 0).toBe(0);
  });

  it("deactivate refuses self-deactivation (no preview, no commit)", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({ actionName: "clockify_users_deactivate", args: { userId: "admin-1" }, context: makeContext(fake) });
    if (result.kind === "receipt" && !result.receipt.ok) expect(result.receipt.code).toBe("invalid_args");
    else throw new Error("expected refusal");
    expect(fake.counts.deactivateUser ?? 0).toBe(0);
  });

  it("deactivate resolves a member NAME (or userName) and previews the NAME, not an opaque id", async () => {
    const fake = createFakeWorkspace(seed());
    const bySlot = await executeAction({ actionName: "clockify_users_deactivate", args: { userId: "Bob" }, context: makeContext(fake) });
    if (bySlot.kind !== "preview") throw new Error(`expected a preview, got ${bySlot.kind}`);
    expect((bySlot.operation.payload as any).userId).toBe("u2");
    expect(bySlot.preview.expectedChanges.join(" ")).toContain("Bob");
    await commitConfirmedOperation(makeContext(fake), bySlot.operation);
    expect(fake.state.users.find((u) => u.id === "u2")?.status).toBe("INACTIVE");
  });

  it("deactivate refuses 'me' and the admin's own NAME (the guard must hold on the RESOLVED id)", async () => {
    const fake = createFakeWorkspace(seed());
    const me = await executeAction({ actionName: "clockify_users_deactivate", args: { userId: "me" }, context: makeContext(fake) });
    if (me.kind === "receipt" && !me.receipt.ok) expect(me.receipt.code).toBe("invalid_args");
    else throw new Error(`expected refusal, got ${me.kind}`);

    const ownName = await executeAction({ actionName: "clockify_users_deactivate", args: { userName: "Me" }, context: makeContext(fake) });
    if (ownName.kind === "receipt" && !ownName.receipt.ok) expect(ownName.receipt.code).toBe("invalid_args");
    else throw new Error(`expected refusal, got ${ownName.kind}`);
    expect(fake.counts.deactivateUser ?? 0).toBe(0);
  });

  it("deactivate clarifies on an unknown member and a wrong-typed 24-hex id (verify, never trust)", async () => {
    const fake = createFakeWorkspace(seed());
    const unknown = await executeAction({ actionName: "clockify_users_deactivate", args: { userName: "Ghost" }, context: makeContext(fake) });
    expect(unknown.kind).toBe("clarify");

    // A 24-hex value that is NOT a workspace user (e.g. a project id) must clarify.
    const wrongType = await executeAction({
      actionName: "clockify_users_deactivate",
      args: { userId: "5f1e2d3c4b5a69788796a999" },
      context: makeContext(fake),
    });
    expect(wrongType.kind).toBe("clarify");
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

  it("groups_add_user resolves a user NAME passed in the id slot and shows names in the preview (no confirm-then-400)", async () => {
    const fake = createFakeWorkspace(seed());
    // The live bug: the model put "Bob" in the userId slot → 400 at commit.
    const add = await executeAction({ actionName: "clockify_groups_add_user", args: { groupId: "g1", userId: "Bob" }, context: makeContext(fake) });
    if (add.kind !== "preview") throw new Error(`expected a preview, got ${add.kind}`);
    expect(add.operation.payload).toMatchObject({ groupId: "g1", userIds: ["u2"] });
    const change = add.preview.expectedChanges.join(" ");
    expect(change).toContain("Bob");
    expect(change).toContain("Devs");
    await commitConfirmedOperation(makeContext(fake), add.operation);
    expect(fake.state.groups.find((g) => g.id === "g1")?.userIds).toContain("u2");
  });

  it("groups_add_user resolves the group by name + user by 'me'", async () => {
    const fake = createFakeWorkspace(seed());
    const add = await executeAction({ actionName: "clockify_groups_add_user", args: { groupName: "Devs", userId: "me" }, context: makeContext(fake) });
    if (add.kind !== "preview") throw new Error("expected a preview");
    expect(add.operation.payload).toMatchObject({ groupId: "g1", userIds: ["admin-1"] });
  });

  it("groups_add_user adds MULTIPLE members (names + 'me') in ONE preview/commit", async () => {
    const fake = createFakeWorkspace(seed());
    const add = await executeAction({ actionName: "clockify_groups_add_user", args: { groupName: "Devs", members: ["Bob", "me"] }, context: makeContext(fake) });
    if (add.kind !== "preview") throw new Error("expected a preview");
    expect(add.operation.payload).toMatchObject({ groupId: "g1", userIds: ["u2", "admin-1"] });
    expect(add.operation.risks).toContain("high_risk_write");
    const change = add.preview.expectedChanges.join(" ");
    expect(change).toContain("Bob");
    expect(change).toContain("you");
    await commitConfirmedOperation(makeContext(fake), add.operation);
    const g = fake.state.groups.find((x) => x.id === "g1");
    expect(g?.userIds).toEqual(expect.arrayContaining(["u2", "admin-1"]));
    expect(fake.counts.addUserToGroup).toBe(2);
  });

  it("groups_add_user clarifies if ANY member in the list is unknown (no partial add)", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({ actionName: "clockify_groups_add_user", args: { groupName: "Devs", members: ["Bob", "Ghost"] }, context: makeContext(fake) });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.addUserToGroup ?? 0).toBe(0);
  });

  it("groups_add_user clarifies on an unknown user (never previews a doomed commit)", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({ actionName: "clockify_groups_add_user", args: { groupId: "g1", userId: "Ghost McNobody" }, context: makeContext(fake) });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.addUserToGroup ?? 0).toBe(0);
  });

  it("groups_remove_user resolves names and clarifies on an unknown group", async () => {
    const fake = createFakeWorkspace(seed());
    const ok = await executeAction({ actionName: "clockify_groups_remove_user", args: { groupName: "Devs", userId: "Bob" }, context: makeContext(fake) });
    if (ok.kind !== "preview") throw new Error("expected a preview");
    expect(ok.operation.payload).toMatchObject({ groupId: "g1", userId: "u2" });
    const bad = await executeAction({ actionName: "clockify_groups_remove_user", args: { groupName: "Nope", userId: "Bob" }, context: makeContext(fake) });
    expect(bad.kind).toBe("clarify");
  });

  it("clockify_groups_delete resolves a group by name when no id is given (live-loop FIX 1)", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_groups_delete",
      args: { name: "Devs" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect((preview.operation.payload as { id: string }).id).toBe("g1");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.state.groups.find((g) => g.id === "g1")).toBeUndefined();
  });

  it("clockify_groups_delete clarifies on an unknown name instead of invalid_args", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({
      actionName: "clockify_groups_delete",
      args: { name: "Designers" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.deleteGroup ?? 0).toBe(0);
  });
});
