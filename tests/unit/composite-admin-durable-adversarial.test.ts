import { describe, expect, it } from "vitest";
import { createStore } from "../../src/db/store.js";
import { AmbiguousWriteOutcome, DefinitiveWriteFailure } from "../../src/clockify/write-outcome.js";
import type { WorkspaceClient } from "../../src/clockify/client.js";
import type { ActionContext, ConfirmableOperation, ExternalMutationPlan } from "../../src/harness/action.js";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { actionFingerprint, catalogHash } from "../../src/harness/catalog.js";
import { hashOperation } from "../../src/harness/confirmations.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";

function context(fake: FakeWorkspace, clockify: WorkspaceClient = fake.client): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy: defaultAdminPolicy(),
    clockify,
    now: () => new Date("2026-07-14T09:00:00.000Z"),
  };
}

async function preview(fake: FakeWorkspace, actionName: string, args: unknown, clockify = fake.client) {
  const result = await executeAction({ actionName, args, context: context(fake, clockify) });
  if (result.kind !== "preview") throw new Error(`expected preview, got ${result.kind}`);
  return result.operation;
}

function journaledContext(fake: FakeWorkspace, operation: ConfirmableOperation, clockify = fake.client) {
  const store = createStore(":memory:");
  store.prepareOperationRun({
    id: operation.operationId,
    confirmationId: `confirmation-${operation.operationId}`,
    sessionId: "session",
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    actionName: operation.actionName,
    actionFingerprint: actionFingerprint(operation.actionName)!,
    catalogHash: catalogHash(),
    operationHash: hashOperation(operation),
    operation,
    mutationPlan: operation.mutationPlan,
  });
  store.markOperationExecuting(operation.operationId);
  return { store, ctx: { ...context(fake, clockify), mutationJournal: store.mutationStepJournal(operation.operationId) } };
}

describe("composite/admin durable adversarial behavior", () => {
  it("journals the exact prepared work-package plan and normalized atomic calls", async () => {
    const fake = createFakeWorkspace();
    const store = createStore(":memory:");
    let operationId = "";
    let plan: ExternalMutationPlan | undefined;
    const result = await executeAction({
      actionName: "clockify_create_work_package",
      args: { client: { name: "Acme" }, project: { name: "Apollo", clientName: "Acme" }, task: { name: "Build" }, startTimer: true },
      context: {
        ...context(fake),
        operationJournal: {
          prepare(actionName, operation, mutationPlan) {
            plan = mutationPlan;
            operationId = store.prepareOperationRun({
              id: "safe:work-package",
              sessionId: "session",
              workspaceId: "ws-1",
              adminUserId: "admin-1",
              actionName,
              actionFingerprint: actionFingerprint(actionName)!,
              catalogHash: catalogHash(),
              operationHash: "hash:work-package",
              operation,
              mutationPlan,
            });
            return operationId;
          },
          markExecuting(id) { if (!store.markOperationExecuting(id)) throw new Error("operation_not_prepared"); },
          scope: (id) => store.mutationStepJournal(id),
          settle: (id, status, settled) => store.settleOperationResult(id, status, settled),
        },
      },
    });
    expect(result).toMatchObject({ kind: "receipt", receipt: { ok: true } });
    expect(store.listOperationSteps(operationId).map((step) => [step.planStepId, step.targetFingerprint])).toEqual(
      plan!.steps.map((step) => [step.id, step.targetFingerprint]),
    );
    expect(fake.counts).toMatchObject({ createClientBaseAtomic: 1, createProjectAtomic: 1, createTaskAtomic: 1, startTimeEntryAtomic: 1 });
    store.close();
  });

  it("reconciles exactly one ambiguous create and rejects zero/multiple/truncated matches without later dispatch", async () => {
    for (const mode of ["zero", "multiple", "truncated"] as const) {
      const fake = createFakeWorkspace();
      let listCalls = 0;
      const clockify: WorkspaceClient = {
        ...fake.client,
        async listProjects(filter) {
          listCalls += 1;
          const listed = await fake.client.listProjects(filter);
          return mode === "truncated" && listCalls >= 3 ? { ...listed, truncated: true } : listed;
        },
        async createProjectAtomic(input) {
          if (mode !== "zero") {
            fake.state.projects.push({ id: "p-one", ...input });
            if (mode === "multiple") fake.state.projects.push({ id: "p-two", ...input });
          }
          throw new AmbiguousWriteOutcome("POST", "/projects", "socket closed after dispatch");
        },
      };
      const result = await executeAction({
        actionName: "clockify_create_work_package",
        args: { project: { name: "Apollo" }, task: { name: "Build" } },
        context: context(fake, clockify),
      });
      expect(result).toMatchObject({ kind: "receipt", receipt: { ok: false, code: "commit_outcome_unknown" } });
      expect(fake.counts.createTaskAtomic ?? 0).toBe(0);
    }

    const fake = createFakeWorkspace();
    const clockify: WorkspaceClient = {
      ...fake.client,
      async createProjectAtomic(input) {
        fake.state.projects.push({ id: "p-one", ...input });
        throw new AmbiguousWriteOutcome("POST", "/projects", "socket closed after dispatch");
      },
    };
    const result = await executeAction({
      actionName: "clockify_create_work_package",
      args: { project: { name: "Apollo" }, task: { name: "Build" } },
      context: context(fake, clockify),
    });
    expect(result).toMatchObject({ kind: "receipt", receipt: { ok: true } });
    expect(fake.counts.createTaskAtomic).toBe(1);
  });

  it("rejects an unverified direct id and blocks a drifted generic target before mutation", async () => {
    const missing = createFakeWorkspace();
    const invalid = await executeAction({
      actionName: "clockify_update_entity",
      args: { entityType: "project", id: "aaaaaaaaaaaaaaaaaaaaaaaa", name: "Renamed" },
      context: context(missing),
    });
    expect(invalid.kind).toBe("clarify");
    expect(missing.counts.updateProjectAtomic ?? 0).toBe(0);

    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Apollo" }] });
    const operation = await preview(fake, "clockify_update_entity", { entityType: "project", id: "p1", name: "Renamed" });
    fake.state.projects[0]!.name = "Changed elsewhere";
    const result = await commitConfirmedOperation(context(fake), operation);
    expect(result).toMatchObject({ ok: false, code: "stale_target" });
    expect(fake.counts.updateProjectAtomic ?? 0).toBe(0);
  });

  it("returns partial and retains known project creation after a later definitive rate failure", async () => {
    const fake = createFakeWorkspace({ users: [{ id: "admin-1", name: "Ada" }] });
    const clockify: WorkspaceClient = {
      ...fake.client,
      async updateProjectRateAtomic() {
        throw new DefinitiveWriteFailure("PUT", "/projects/rate", "rate rejected", 400);
      },
    };
    const operation = await preview(fake, "clockify_setup_project", {
      name: "Apollo",
      memberRates: [{ member: "me", amount: 25 }],
    }, clockify);
    const result = await commitConfirmedOperation(context(fake, clockify), operation);
    expect(result).toMatchObject({ kind: "partial", receipt: { ok: true } });
    expect(fake.state.projects.some((project) => project.name === "Apollo")).toBe(true);
    expect(fake.state.deleted).toEqual([]);
  });

  it("persists restart reconciliation metadata and plan-equal fingerprints for an ambiguous generic delete", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Apollo", archived: false }] });
    const clockify: WorkspaceClient = {
      ...fake.client,
      async deleteProjectAtomic() {
        throw new AmbiguousWriteOutcome("DELETE", "/projects/p1", "socket closed");
      },
    };
    const operation = await preview(fake, "clockify_delete_entity", { entityType: "project", id: "p1" }, clockify);
    const journaled = journaledContext(fake, operation, clockify);
    const result = await commitConfirmedOperation(journaled.ctx, operation);
    expect(result).toMatchObject({ kind: "partial" });
    expect(journaled.store.listOperationSteps(operation.operationId).map((step) => [step.planStepId, step.targetFingerprint])).toEqual(
      operation.mutationPlan!.steps.slice(0, 2).map((step) => [step.id, step.targetFingerprint]),
    );
    journaled.store.settleOperationRun(operation.operationId, "outcome_unknown");
    expect(journaled.store.listStartupReconciliationCandidates()).toMatchObject([{
      id: operation.operationId,
      steps: [{ planStepId: "delete-project", strategy: "delete" }],
    }]);
    expect(fake.counts.updateProjectAtomic ?? 0).toBe(0);
    journaled.store.close();
  });

  it("snapshots every setup-task assignee and blocks removed assignees before create", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "p1", name: "Apollo" }],
      users: [{ id: "admin-1", name: "Ada", status: "ACTIVE" }, { id: "u2", name: "Bob", status: "ACTIVE" }],
    });
    const operation = await preview(fake, "clockify_setup_task", {
      projectId: "p1",
      name: "Build",
      assignees: ["me", "Bob"],
    });
    expect(operation.targetSnapshots).toMatchObject([
      { relation: "parent", ref: { type: "project", id: "p1" } },
      { relation: "parent", ref: { type: "user", id: "admin-1" } },
      { relation: "parent", ref: { type: "user", id: "u2" } },
    ]);
    fake.state.users = fake.state.users.filter((user) => user.id !== "u2");
    const result = await commitConfirmedOperation(context(fake), operation);
    expect(result).toMatchObject({ ok: false, code: "stale_parent" });
    expect(fake.counts.createTaskAtomic ?? 0).toBe(0);
  });

  it("binds setup-project later steps to stored parents and re-verifies before membership dispatch", async () => {
    const fake = createFakeWorkspace({
      clients: [{ id: "c1", name: "Acme" }],
      users: [{ id: "admin-1", name: "Ada", status: "ACTIVE" }],
    });
    const base = fake.client;
    const clockify: WorkspaceClient = {
      ...base,
      async createProjectAtomic(input) {
        const created = await base.createProjectAtomic(input);
        fake.state.users = [];
        return created;
      },
    };
    const operation = await preview(fake, "clockify_setup_project", {
      name: "Apollo",
      clientId: "c1",
      members: ["me"],
      memberRates: [{ member: "me", amount: 25 }],
    }, clockify);
    const plan = operation.mutationPlan!.steps;
    expect(plan.find((step) => step.id === "add-project-members")?.targetFingerprint).toBeTruthy();
    expect(plan.find((step) => step.id === "set-project-rate-0")?.targetFingerprint).toBeTruthy();
    const result = await commitConfirmedOperation(context(fake, clockify), operation);
    expect(result).toMatchObject({ kind: "partial", receipt: { ok: true } });
    expect(fake.counts.updateProjectMembershipsAtomic ?? 0).toBe(0);
    expect(fake.counts.updateProjectRateAtomic ?? 0).toBe(0);
  });

  it("deduplicates repeated onboard groups before snapshots, plan creation, and commit", async () => {
    const fake = createFakeWorkspace({ groups: [{ id: "g1", name: "Engineering", userIds: [] }] });
    const operation = await preview(fake, "clockify_onboard_user", {
      email: "ada@example.com",
      groups: ["Engineering", "Engineering"],
    });
    expect(operation.targetSnapshots).toHaveLength(1);
    expect(operation.mutationPlan?.steps.map((step) => step.id)).toEqual(["invite-user", "add-user-to-group-0"]);
    expect((operation.payload as { groups: unknown[] }).groups).toHaveLength(1);
    const result = await commitConfirmedOperation(context(fake), operation);
    expect(result).toMatchObject({ ok: true });
    expect(fake.counts.addUserToGroupAtomic).toBe(1);
  });
});
