import { describe, expect, it } from "vitest";
import { executeAction, commitConfirmedOperation } from "../../src/harness/actions.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext, ConfirmableOperation } from "../../src/harness/catalog.js";
import type { CreateProjectInput, UpdateProjectRateInput } from "../../src/clockify/ports/projects.js";
import type { WorkspaceClient } from "../../src/clockify/client.js";
import { AmbiguousWriteOutcome, DefinitiveWriteFailure } from "../../src/clockify/write-outcome.js";

/**
 * clockify_setup_project — the single-approval composite: ONE preview listing
 * every change → ONE Confirm → an atomic composition (create project + add
 * members + set the project default rate + set per-member rates), with reverse-
 * order rollback and a single undo handle. Mirrors compose-create.test.ts.
 */

function ctxWith(fake: FakeWorkspace, client: WorkspaceClient = fake.client, policy = defaultAdminPolicy()): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy,
    clockify: client,
    now: () => new Date("2026-06-05T00:00:00.000Z"),
  };
}

/** A spy over the fake that captures the wire bodies the fake otherwise drops. */
function spy(fake: FakeWorkspace): {
  client: WorkspaceClient;
  createProject: CreateProjectInput[];
  rate: UpdateProjectRateInput[];
} {
  const createProject: CreateProjectInput[] = [];
  const rate: UpdateProjectRateInput[] = [];
  const client: WorkspaceClient = {
    ...fake.client,
    createProjectAtomic: async (input) => {
      createProject.push(input);
      return fake.client.createProjectAtomic(input);
    },
    updateProjectRateAtomic: async (input) => {
      rate.push(input);
      return fake.client.updateProjectRateAtomic(input);
    },
  };
  return { client, createProject, rate };
}

async function previewSetup(ctx: ActionContext, args: Record<string, unknown>): Promise<ConfirmableOperation> {
  const result = await executeAction({ actionName: "clockify_setup_project", args, context: ctx });
  if (result.kind !== "preview") throw new Error(`expected a preview, got ${result.kind}`);
  return result.operation;
}

describe("clockify_setup_project — single-approval composite", () => {
  it("previews every change (resolved) and writes NOTHING until confirmed", async () => {
    const fake = createFakeWorkspace({ users: [{ id: "admin-1", name: "Ada" }] });
    const result = await executeAction({
      actionName: "clockify_setup_project",
      args: { name: "test1122", private: true, members: ["me"], projectRate: 50, memberRates: [{ member: "me", amount: 25 }] },
      context: ctxWith(fake),
    });
    expect(result.kind).toBe("preview");
    if (result.kind !== "preview") return;
    const changes = result.preview.expectedChanges.join(" | ");
    expect(changes).toContain('Create project "test1122" (private)');
    expect(changes).toContain("Add you as a member");
    expect(changes).toContain("Set project hourly rate to $50.00");
    expect(changes).toContain("Set your member hourly rate to $25.00");
    expect(result.preview.riskLabels).toEqual(expect.arrayContaining(["high_risk_write", "billing"]));
    expect(fake.counts.createProject ?? 0).toBe(0); // nothing written at preview
  });

  it("on confirm: creates the project (private + default hourly rate), adds the member, sets the member rate", async () => {
    const fake = createFakeWorkspace({ users: [{ id: "admin-1", name: "Ada" }] });
    const s = spy(fake);
    const op = await previewSetup(ctxWith(fake, s.client), {
      name: "test1122",
      private: true,
      members: ["me"],
      projectRate: 50,
      memberRates: [{ member: "me", amount: 25 }],
    });
    const receipt = await commitConfirmedOperation(ctxWith(fake, s.client), op);
    expect(receipt.ok).toBe(true);
    // create body carried visibility + the project DEFAULT rate (in minor units).
    expect(s.createProject).toHaveLength(1);
    expect(s.createProject[0].isPublic).toBe(false);
    expect(s.createProject[0].hourlyRate).toEqual({ amount: 5000 });
    // the member was added, then the per-member rate was set (minor units).
    expect(fake.counts.updateProjectMembershipsAtomic).toBe(1);
    expect(s.rate).toHaveLength(1);
    expect(s.rate[0]).toMatchObject({ userId: "admin-1", rateKind: "HOURLY", amountMinor: 2500 });
    const projectId = (receipt.ok && receipt.changed?.created?.[0].id) as string;
    expect(fake.state.projectMemberships[projectId].some((m) => String(m.userId) === "admin-1")).toBe(true);
    // exactly one created entity (the project) → one undo handle.
    expect(receipt.ok && receipt.changed?.created).toHaveLength(1);
  });

  it("stops later setup writes after an ambiguous project create reconciles successfully", async () => {
    const fake = createFakeWorkspace({ users: [{ id: "admin-1", name: "Ada" }] });
    const original = fake.client.createProjectAtomic.bind(fake.client);
    const client: WorkspaceClient = {
      ...fake.client,
      createProjectAtomic: async (input) => {
        const created = await original(input);
        throw new AmbiguousWriteOutcome("POST", `/projects/${created.id}`, "socket closed");
      },
    };
    const op = await previewSetup(ctxWith(fake, client), {
      name: "reconciled-project",
      members: ["me"],
      memberRates: [{ member: "me", amount: 25 }],
    });

    const result = await commitConfirmedOperation(ctxWith(fake, client), op);

    expect(result).toMatchObject({ kind: "partial", receipt: { ok: true }, recovery: { retryable: false } });
    expect(fake.counts.createProjectAtomic).toBe(1);
    expect(fake.counts.updateProjectMembershipsAtomic ?? 0).toBe(0);
    expect(fake.counts.updateProjectRateAtomic ?? 0).toBe(0);
  });

  it("a drifted stored payload (e.g. a deploy during a pending preview) fails with an honest receipt, not a silent wrong commit", async () => {
    const fake = createFakeWorkspace({ users: [{ id: "admin-1", name: "Ada" }] });
    const op = await previewSetup(ctxWith(fake), { name: "drifty", members: ["me"] });
    const drifted = { ...op, payload: { name: "drifty" } }; // missing addUserIds/memberRates
    const receipt = await commitConfirmedOperation(ctxWith(fake), drifted);
    expect(receipt.ok).toBe(false);
    expect((receipt as { code?: string }).code).toBe("invalid_payload");
    expect(fake.counts.createProject ?? 0).toBe(0); // nothing was created
  });

  it("returns partial and retains the project when the rate step definitively fails", async () => {
    const fake = createFakeWorkspace({ users: [{ id: "admin-1", name: "Ada" }] });
    const client: WorkspaceClient = {
      ...fake.client,
      updateProjectRateAtomic: async () => {
        throw new DefinitiveWriteFailure("PUT", "/project-rate", "Clockify rejected the rate", 400);
      },
    };
    const op = await previewSetup(ctxWith(fake, client), {
      name: "test1122",
      members: ["me"],
      memberRates: [{ member: "me", amount: 25 }],
    });
    const receipt = await commitConfirmedOperation(ctxWith(fake, client), op);
    expect(receipt).toMatchObject({ kind: "partial", receipt: { ok: true } });
    expect(fake.counts.createProjectAtomic).toBe(1);
    expect(fake.state.projects.some((project) => project.name === "test1122")).toBe(true);
    expect(fake.state.deleted).toEqual([]);
  });

  it("a per-member rate implies membership: 'set my member rate' adds me first, then sets the rate", async () => {
    const fake = createFakeWorkspace({ users: [{ id: "admin-1", name: "Ada" }] });
    const s = spy(fake);
    const op = await previewSetup(ctxWith(fake, s.client), {
      name: "test1122",
      memberRates: [{ member: "me", amount: 25 }], // no explicit `members`
    });
    const receipt = await commitConfirmedOperation(ctxWith(fake, s.client), op);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.updateProjectMembershipsAtomic).toBe(1); // I was added
    expect(s.rate).toHaveLength(1); // and my rate was set
  });

  it("honors cost-vs-hourly: cost goes to the create costRate body and the member COST rate", async () => {
    const fake = createFakeWorkspace({ users: [{ id: "admin-1", name: "Ada" }] });
    const s = spy(fake);
    const op = await previewSetup(ctxWith(fake, s.client), {
      name: "test1122",
      projectRate: 80,
      projectRateKind: "cost",
      memberRates: [{ member: "me", amount: 40, kind: "cost" }],
    });
    const receipt = await commitConfirmedOperation(ctxWith(fake, s.client), op);
    expect(receipt.ok).toBe(true);
    expect(s.createProject[0].costRate).toEqual({ amount: 8000 });
    expect(s.createProject[0].hourlyRate).toBeUndefined();
    expect(s.rate[0]).toMatchObject({ rateKind: "COST", amountMinor: 4000 });
  });

  it("resolves member names (and 'me'); an unknown member clarifies and writes nothing", async () => {
    const fake = createFakeWorkspace({ users: [{ id: "admin-1", name: "Ada" }, { id: "u2", name: "Bob" }] });
    const ok = await executeAction({
      actionName: "clockify_setup_project",
      args: { name: "test1122", members: ["me", "Bob"] },
      context: ctxWith(fake),
    });
    expect(ok.kind).toBe("preview");

    const bad = await executeAction({
      actionName: "clockify_setup_project",
      args: { name: "test1122", members: ["Nobody"] },
      context: ctxWith(fake),
    });
    expect(bad.kind).toBe("clarify");
    expect(fake.counts.createProject ?? 0).toBe(0);
  });

  it("resolves a client by name; an unknown client clarifies", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "c1", name: "Acme" }] });
    const s = spy(fake);
    const op = await previewSetup(ctxWith(fake, s.client), { name: "test1122", clientName: "Acme" });
    await commitConfirmedOperation(ctxWith(fake, s.client), op);
    expect(s.createProject[0].clientId).toBe("c1");

    const bad = await executeAction({
      actionName: "clockify_setup_project",
      args: { name: "test1122", clientName: "Ghost" },
      context: ctxWith(fake),
    });
    expect(bad.kind).toBe("clarify");
  });
});
