import { describe, expect, it } from "vitest";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { type AdminPolicy, defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext } from "../../src/harness/action.js";

const NOW = new Date("2026-06-06T00:00:00.000Z");

function makeContext(fake: FakeWorkspace, policy: AdminPolicy = defaultAdminPolicy()): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy,
    clockify: fake.client,
    now: () => NOW,
  };
}

describe("project actions — reads", () => {
  it("clockify_projects_list returns the project list and respects the read gate", async () => {
    const fake = createFakeWorkspace({
      projects: [
        { id: "p1", name: "Website", clientId: "c1" },
        { id: "p2", name: "App" },
      ],
    });
    const result = await executeAction({
      actionName: "clockify_projects_list",
      args: {},
      context: makeContext(fake),
    });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt" && result.receipt.ok) {
      expect((result.receipt.data as any).count).toBe(2);
    }

    const off = defaultAdminPolicy();
    off.groups.work_structure = "off";
    const denied = await executeAction({
      actionName: "clockify_projects_list",
      args: {},
      context: makeContext(fake, off),
    });
    expect(denied.kind).toBe("receipt");
    if (denied.kind === "receipt" && !denied.receipt.ok) {
      expect(denied.receipt.code).toBe("policy_denied");
    }
  });

  it("clockify_projects_get fetches a single project by id", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Website" }] });
    const result = await executeAction({
      actionName: "clockify_projects_get",
      args: { id: "p1" },
      context: makeContext(fake),
    });
    if (result.kind === "receipt" && result.receipt.ok) {
      expect((result.receipt.data as any).entity).toMatchObject({ id: "p1", name: "Website" });
    } else {
      throw new Error("expected a read receipt");
    }
  });
});

describe("project actions — safe writes", () => {
  it("clockify_projects_create creates a project and returns a receipt", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_projects_create",
      args: { name: "AIASSIST_SMOKE_p", clientId: "c1", billable: true },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt" && result.receipt.ok) {
      expect(result.receipt.changed?.created?.[0]).toMatchObject({ type: "project" });
    }
    expect(fake.counts.createProject).toBe(1);
  });

  it("clockify_projects_create is denied when work_structure is read-only", async () => {
    const fake = createFakeWorkspace();
    const readOnly = defaultAdminPolicy();
    readOnly.groups.work_structure = "read";
    const result = await executeAction({
      actionName: "clockify_projects_create",
      args: { name: "AIASSIST_SMOKE_p" },
      context: makeContext(fake, readOnly),
    });
    if (result.kind === "receipt" && !result.receipt.ok) {
      expect(result.receipt.code).toBe("policy_denied");
    } else {
      throw new Error("expected a policy_denied receipt");
    }
    expect(fake.counts.createProject ?? 0).toBe(0);
  });

  it("clockify_projects_from_template creates a project from a template", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_projects_from_template",
      args: { templateId: "tmpl-1", name: "AIASSIST_SMOKE_p" },
      context: makeContext(fake),
    });
    if (result.kind === "receipt" && result.receipt.ok) {
      expect(result.receipt.changed?.created?.[0]).toMatchObject({ type: "project" });
    }
    expect(fake.counts.createProjectFromTemplate).toBe(1);
  });
});

describe("project actions — risky writes (preview → commit)", () => {
  it("clockify_projects_update previews without mutating, then mutates once on commit", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Website" }] });
    const preview = await executeAction({
      actionName: "clockify_projects_update",
      args: { id: "p1", name: "New Site" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("high_risk_write");
    expect(preview.preview.expectedChanges.join(" ")).toContain("name");
    expect(fake.counts.updateProject ?? 0).toBe(0);

    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.updateProject).toBe(1);
  });

  it("clockify_projects_archive previews then archives once on commit", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Website" }] });
    const preview = await executeAction({
      actionName: "clockify_projects_archive",
      args: { id: "p1", name: "Website" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("destructive");
    expect(fake.counts.archiveProject ?? 0).toBe(0);

    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.archiveProject).toBe(1);
  });

  it("clockify_projects_delete previews then archives-then-deletes once on commit", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Website" }] });
    const preview = await executeAction({
      actionName: "clockify_projects_delete",
      args: { id: "p1", name: "Website" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("destructive");
    expect(fake.counts.deleteProject ?? 0).toBe(0);

    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.deleteProject).toBe(1);
    expect(fake.state.projects.find((p) => p.id === "p1")).toBeUndefined();
    expect(receipt.ok && receipt.changed?.deleted?.[0]).toMatchObject({ type: "project", id: "p1" });
  });

  it("clockify_projects_delete resolves a project by name when no id is given, then deletes once", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Website" }] });
    const preview = await executeAction({
      actionName: "clockify_projects_delete",
      args: { name: "Website" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect((preview.operation.payload as { id: string }).id).toBe("p1");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.deleteProject).toBe(1);
  });

  it("clockify_projects_delete resolves an ARCHIVED project by name — deleting an archived project is valid (live item 305)", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "p9", name: "Old Thing", archived: true }],
    });
    const preview = await executeAction({
      actionName: "clockify_projects_delete",
      args: { name: "Old Thing" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    expect((preview.operation.payload as { id: string }).id).toBe("p9");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.state.projects.find((p) => p.id === "p9")).toBeUndefined();
  });

  it("clockify_projects_update can UNARCHIVE by name — archived:false resolves archived candidates (live item 305)", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "p9", name: "Old Thing", archived: true }],
    });
    const preview = await executeAction({
      actionName: "clockify_projects_update",
      args: { currentName: "Old Thing", archived: false },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    expect((preview.operation.payload as { id: string }).id).toBe("p9");
  });

  it("clockify_projects_delete clarifies (not invalid_args) on no / ambiguous name match", async () => {
    const none = await executeAction({
      actionName: "clockify_projects_delete",
      args: { name: "Nope" },
      context: makeContext(createFakeWorkspace({ projects: [{ id: "p1", name: "Website" }] })),
    });
    expect(none.kind).toBe("clarify");

    const ambig = await executeAction({
      actionName: "clockify_projects_delete",
      args: { name: "Dup" },
      context: makeContext(createFakeWorkspace({ projects: [{ id: "a", name: "Dup" }, { id: "b", name: "Dup" }] })),
    });
    expect(ambig.kind).toBe("clarify");
    if (ambig.kind === "clarify") expect(ambig.options?.length).toBe(2);
  });

  it("clockify_projects_delete rejects a call with neither id nor name", async () => {
    const result = await executeAction({
      actionName: "clockify_projects_delete",
      args: {},
      context: makeContext(createFakeWorkspace()),
    });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt" && !result.receipt.ok) expect(result.receipt.code).toBe("invalid_args");
    else throw new Error("expected an invalid_args error receipt");
  });

  it("clockify_projects_rate_update converts major units to minor and commits once", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Website" }], users: [{ id: "u1", name: "Worker" }], projectMemberships: { p1: [{ userId: "u1" }] } });
    const preview = await executeAction({
      actionName: "clockify_projects_rate_update",
      args: { projectId: "p1", userId: "u1", rateKind: "HOURLY", amount: 75, amountUnit: "major" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("billing");
    expect(preview.operation.featureGroup).toBe("invoices");
    // The stored operation must carry the already-converted minor amount.
    expect((preview.operation.payload as any).amountMinor).toBe(7500);
    expect(fake.counts.updateProjectRate ?? 0).toBe(0);

    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.updateProjectRate).toBe(1);
  });

  it("clockify_projects_rate_update resolves 'me' to the admin and previews the amount in major units", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Website" }], projectMemberships: { p1: [{ userId: "admin-1" }] } });
    const preview = await executeAction({
      actionName: "clockify_projects_rate_update",
      args: { projectId: "p1", userId: "me", rateKind: "HOURLY", amount: 20, amountUnit: "major" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    // Clockify rejects the literal "me" in the path (wants a 24-hex id) — it must
    // be resolved to the admin's id at PREVIEW, never confirmed-then-failed.
    expect((preview.operation.payload as any).userId).toBe("admin-1");
    const change = preview.preview.expectedChanges.join(" ");
    expect(change).toContain("20.00");
    expect(change).not.toContain("minor units");

    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
  });

  it("clockify_projects_rate_update passes minor units through unchanged", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Website" }], users: [{ id: "u1", name: "Worker" }], projectMemberships: { p1: [{ userId: "u1" }] } });
    const preview = await executeAction({
      actionName: "clockify_projects_rate_update",
      args: { projectId: "p1", userId: "u1", rateKind: "COST", amount: 5000, amountUnit: "minor" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect((preview.operation.payload as any).amountMinor).toBe(5000);
  });

  it("clockify_projects_rate_update clarifies when the user isn't a project member (Clockify 404s otherwise)", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "p1", name: "Website" }],
      users: [{ id: "u1", name: "Worker" }],
      projectMemberships: { p1: [] }, // u1 is a workspace user but NOT on the project
    });
    const result = await executeAction({
      actionName: "clockify_projects_rate_update",
      args: { projectName: "Website", userName: "Worker", rateKind: "HOURLY", amount: 50 },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.updateProjectRate ?? 0).toBe(0);
  });

  it("clockify_projects_estimate_update previews then commits once", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Website" }] });
    const preview = await executeAction({
      actionName: "clockify_projects_estimate_update",
      args: { id: "p1", fields: { timeEstimate: { estimate: "PT8H", type: "MANUAL", active: true } } },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("high_risk_write");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.updateProjectEstimate).toBe(1);
  });

  it("clockify_projects_memberships_update is an elevated write gated by users_groups", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Website" }] });
    const preview = await executeAction({
      actionName: "clockify_projects_memberships_update",
      args: { id: "p1", memberships: [{ userId: "u1", membershipStatus: "ACTIVE" }] },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    // Must NOT be `permission_change` — that label bypasses the Clockify policy
    // gate (it is reserved for assistant self-permission management).
    expect(preview.operation.risks).toContain("high_risk_write");
    expect(preview.operation.risks).not.toContain("permission_change");
    expect(preview.operation.featureGroup).toBe("users_groups");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.updateProjectMemberships).toBe(1);
  });

  it("memberships_update ADDS the requesting admin via addUserIds:['me'] — merged into the CURRENT set, never replacing it (live item 058: 'add me' asked 'which user are you?')", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "p1", name: "Website" }],
      projectMemberships: { p1: [{ userId: "u-existing" }] },
    });
    const preview = await executeAction({
      actionName: "clockify_projects_memberships_update",
      args: { name: "Website", addUserIds: ["me"] },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    const payload = preview.operation.payload as { id: string; memberships: Array<{ userId: string }> };
    expect(payload.id).toBe("p1");
    expect(payload.memberships.map((m) => m.userId).sort()).toEqual(["admin-1", "u-existing"]);

    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect((fake.state.projectMemberships.p1 ?? []).map((m) => String(m.userId)).sort()).toEqual([
      "admin-1",
      "u-existing",
    ]);
  });

  it("memberships_update addUserIds is idempotent for an already-member user", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "p1", name: "Website" }],
      projectMemberships: { p1: [{ userId: "admin-1" }] },
    });
    const preview = await executeAction({
      actionName: "clockify_projects_memberships_update",
      args: { id: "p1", addUserIds: ["me"] },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    const payload = preview.operation.payload as { memberships: Array<{ userId: string }> };
    expect(payload.memberships).toHaveLength(1);
  });

  it("clockify_projects_memberships_update is policy-gated: users_groups=off blocks preview AND commit", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Website" }] });
    const off = defaultAdminPolicy();
    off.groups.users_groups = "off";
    // Preview is refused outright when users_groups write is disabled.
    const denied = await executeAction({
      actionName: "clockify_projects_memberships_update",
      args: { id: "p1", memberships: [{ userId: "u1", membershipStatus: "ACTIVE" }] },
      context: makeContext(fake, off),
    });
    expect(denied.kind).toBe("receipt");
    if (denied.kind === "receipt" && !denied.receipt.ok) {
      expect(denied.receipt.code).toBe("policy_denied");
    }
    // And a commit built under full policy is re-checked and refused if lowered.
    const preview = await executeAction({
      actionName: "clockify_projects_memberships_update",
      args: { id: "p1", memberships: [{ userId: "u1", membershipStatus: "ACTIVE" }] },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    const receipt = await commitConfirmedOperation(makeContext(fake, off), preview.operation);
    expect(receipt.ok).toBe(false);
    if (!receipt.ok) expect(receipt.code).toBe("policy_denied");
    expect(fake.counts.updateProjectMemberships ?? 0).toBe(0);
  });

  it("a project update typed as 'yes' (no confirmation) never mutates", async () => {
    // Risky actions return a preview from executeAction; they only mutate via
    // commitConfirmedOperation. Re-running the proposal must not mutate.
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Website" }] });
    await executeAction({
      actionName: "clockify_projects_update",
      args: { id: "p1", name: "X" },
      context: makeContext(fake),
    });
    await executeAction({
      actionName: "clockify_projects_delete",
      args: { id: "p1" },
      context: makeContext(fake),
    });
    expect(fake.counts.updateProject ?? 0).toBe(0);
    expect(fake.counts.deleteProject ?? 0).toBe(0);
  });
});

describe("project actions — name→id resolution at preview time (live-loop FIX 1)", () => {
  const seed = () => ({ projects: [{ id: "p1", name: "Website" }, { id: "p2", name: "App" }] });

  it("clockify_projects_update renames by currentName — the resolved id is pinned into the operation", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_projects_update",
      args: { currentName: "website", name: "Website v2" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.payload).toMatchObject({ id: "p1", patch: { name: "Website v2" } });
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.state.projects[0].name).toBe("Website v2");
  });

  it("clockify_projects_update resolves a NAME passed in the id slot (the audit-log failure shape)", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_projects_update",
      args: { id: "Website", billable: true },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.payload).toMatchObject({ id: "p1" });
  });

  it("clockify_projects_update clarifies (never previews a doomed commit) on an unknown name", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({
      actionName: "clockify_projects_update",
      args: { currentName: "Webside", name: "X" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.updateProject ?? 0).toBe(0);
  });

  it("clockify_projects_update resolves a client NAME in the clientId slot (live item 096: 'assign P4 to client X' failed at commit)", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "p1", name: "Website" }],
      clients: [{ id: "c1", name: "Acme" }],
    });
    const preview = await executeAction({
      actionName: "clockify_projects_update",
      args: { currentName: "Website", clientId: "Acme" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    expect((preview.operation.payload as { patch: { clientId: string } }).patch.clientId).toBe("c1");
  });

  it("clockify_projects_update clarifies on an unknown client name in clientId (never previews a doomed assign)", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "p1", name: "Website" }],
      clients: [{ id: "c1", name: "Acme" }],
    });
    const result = await executeAction({
      actionName: "clockify_projects_update",
      args: { currentName: "Website", clientId: "Ghost Client" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
  });

  it("clockify_projects_update passes an empty clientId through (unassigning the client)", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "p1", name: "Website", clientId: "c1" }],
      clients: [{ id: "c1", name: "Acme" }],
    });
    const preview = await executeAction({
      actionName: "clockify_projects_update",
      args: { currentName: "Website", clientId: "" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    expect((preview.operation.payload as { patch: { clientId: string } }).patch.clientId).toBe("");
  });

  it("clockify_projects_archive resolves by name and pins the id", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_projects_archive",
      args: { name: "App" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.payload).toMatchObject({ id: "p2" });
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.archiveProject).toBe(1);
  });

  it("clockify_projects_get carries the billable flag so 'is X billable?' is answerable (live item 069)", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Website", billable: true }] });
    const result = await executeAction({
      actionName: "clockify_projects_get",
      args: { id: "p1" },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected a read receipt");
    expect((result.receipt.data as { entity: { billable?: boolean } }).entity.billable).toBe(true);
  });

  it("clockify_projects_get fetches by name when no id is given", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({
      actionName: "clockify_projects_get",
      args: { name: "Website" },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected a success receipt");
    expect((result.receipt.data as any).entity).toMatchObject({ id: "p1" });
  });

  it("clockify_projects_get clarifies on an unknown name instead of a raw 400", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({
      actionName: "clockify_projects_get",
      args: { name: "Webside" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
  });
});
