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

  it("clockify_projects_rate_update converts major units to minor and commits once", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Website" }] });
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

  it("clockify_projects_rate_update passes minor units through unchanged", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Website" }] });
    const preview = await executeAction({
      actionName: "clockify_projects_rate_update",
      args: { projectId: "p1", userId: "u1", rateKind: "COST", amount: 5000, amountUnit: "minor" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect((preview.operation.payload as any).amountMinor).toBe(5000);
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
