import { describe, expect, it } from "vitest";
import { createStore } from "../../src/db/store.js";
import { AmbiguousWriteOutcome, DefinitiveWriteFailure } from "../../src/clockify/write-outcome.js";
import type { ActionContext } from "../../src/harness/action.js";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { actionFingerprint, catalogHash } from "../../src/harness/catalog.js";
import { hashOperation } from "../../src/harness/confirmations.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";

function context(fake: FakeWorkspace, clockify = fake.client): ActionContext {
  return { workspaceId: "ws-1", adminUserId: "admin-1", policy: defaultAdminPolicy(), clockify };
}

async function preparedDelete(
  fake: FakeWorkspace,
  actionName: "clockify_projects_delete" | "clockify_clients_delete" | "clockify_tasks_delete",
  args: Record<string, unknown>,
  clockify = fake.client,
) {
  const preview = await executeAction({ actionName, args, context: context(fake) });
  if (preview.kind !== "preview") throw new Error("expected preview");
  const operation = preview.operation;
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
  return {
    operation,
    store,
    commitContext: { ...context(fake, clockify), mutationJournal: store.mutationStepJournal(operation.operationId) },
  };
}

async function preparedProjectDelete(fake: FakeWorkspace, clockify = fake.client) {
  return preparedDelete(fake, "clockify_projects_delete", { id: "project-1" }, clockify);
}

function expectTransitionBoundCompensationPlan(operation: {
  mutationPlan?: { steps: Array<{ kind: string; targetFingerprint?: string }> };
}) {
  const [source, later, compensation] = operation.mutationPlan?.steps ?? [];
  expect(source?.kind).toBe("primary");
  expect(later?.kind).toBe("primary");
  expect(compensation?.kind).toBe("compensation");
  expect(source?.targetFingerprint).toBeTruthy();
  expect(later?.targetFingerprint).toBeTruthy();
  expect(source?.targetFingerprint).not.toBe(later?.targetFingerprint);
  expect(compensation?.targetFingerprint).toBe(later?.targetFingerprint);
}

function expectJournalFingerprintsMatchPlan(
  store: ReturnType<typeof createStore>,
  operation: { operationId: string; mutationPlan?: { steps: Array<{ id: string; targetFingerprint?: string }> } },
) {
  const declared = operation.mutationPlan?.steps ?? [];
  expect(store.listOperationSteps(operation.operationId).map((step) => [step.planStepId, step.targetFingerprint])).toEqual(
    declared.map((step) => [step.id, step.targetFingerprint]),
  );
}

describe("structure multi-step writes use the real durable journal", () => {
  it("journals archive then delete in exact plan order", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "project-1", name: "Project", archived: false }] });
    const prepared = await preparedProjectDelete(fake);

    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);

    expect(result).toMatchObject({ ok: true });
    expect(prepared.store.listOperationSteps(prepared.operation.operationId).map((step) => [step.planStepId, step.status])).toEqual([
      ["archive-project-for-delete", "succeeded"],
      ["delete-project", "succeeded"],
    ]);
    prepared.store.close();
  });

  it("keeps an ambiguous delete unknown and exposes a restart reconciliation candidate without compensation", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "project-1", name: "Project", archived: false }] });
    const clockify = {
      ...fake.client,
      deleteProjectAtomic: async (id: string) => {
        throw new AmbiguousWriteOutcome("DELETE", `/projects/${id}`, "socket closed");
      },
    };
    const prepared = await preparedProjectDelete(fake, clockify);

    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);

    expect(result).toMatchObject({ ok: false, code: "commit_outcome_unknown" });
    expect(prepared.store.listOperationSteps(prepared.operation.operationId).map((step) => [step.planStepId, step.status])).toEqual([
      ["archive-project-for-delete", "succeeded"],
      ["delete-project", "outcome_unknown"],
    ]);
    prepared.store.settleOperationRun(prepared.operation.operationId, "outcome_unknown");
    expect(prepared.store.listStartupReconciliationCandidates()).toMatchObject([{
      id: prepared.operation.operationId,
      steps: [{ planStepId: "delete-project", strategy: "delete" }],
    }]);
    prepared.store.close();
  });

  it("runs the declared compensation only after definitive delete rejection", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "project-1", name: "Project", archived: false }] });
    const clockify = {
      ...fake.client,
      deleteProjectAtomic: async (id: string) => {
        throw new DefinitiveWriteFailure("DELETE", `/projects/${id}`, "rejected", 400);
      },
    };
    const prepared = await preparedProjectDelete(fake, clockify);
    expectTransitionBoundCompensationPlan(prepared.operation);

    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);

    expect(result).toMatchObject({ ok: false, code: "write_failed" });
    expect(prepared.store.listOperationSteps(prepared.operation.operationId).map((step) => [step.planStepId, step.status])).toEqual([
      ["archive-project-for-delete", "compensated"],
      ["delete-project", "definitive_failed"],
      ["restore-project", "compensated"],
    ]);
    expectJournalFingerprintsMatchPlan(prepared.store, prepared.operation);
    expect(fake.state.projects[0]).toMatchObject({ archived: false });
    prepared.store.close();
  });

  it("runs client archive compensation through the real store after definitive delete rejection", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "client-1", name: "Client", archived: false }] });
    const clockify = {
      ...fake.client,
      deleteClientAtomic: async (id: string) => {
        throw new DefinitiveWriteFailure("DELETE", `/clients/${id}`, "rejected", 400);
      },
    };
    const prepared = await preparedDelete(fake, "clockify_clients_delete", { id: "client-1" }, clockify);
    expectTransitionBoundCompensationPlan(prepared.operation);

    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);

    expect(result).toMatchObject({ ok: false, code: "write_failed" });
    expect(prepared.store.listOperationSteps(prepared.operation.operationId).map((step) => [step.planStepId, step.status])).toEqual([
      ["archive-client", "compensated"],
      ["delete-client", "definitive_failed"],
      ["restore-client", "compensated"],
    ]);
    expectJournalFingerprintsMatchPlan(prepared.store, prepared.operation);
    expect(fake.state.clients[0]).toMatchObject({ archived: false });
    prepared.store.close();
  });

  it("runs task status compensation through the real store after definitive delete rejection", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "project-1", name: "Project" }],
      tasks: [{ id: "task-1", name: "Task", projectId: "project-1", status: "ACTIVE" } as never],
    });
    const clockify = {
      ...fake.client,
      deleteTaskAtomic: async (projectId: string, id: string) => {
        throw new DefinitiveWriteFailure("DELETE", `/projects/${projectId}/tasks/${id}`, "rejected", 400);
      },
    };
    const prepared = await preparedDelete(
      fake,
      "clockify_tasks_delete",
      { projectId: "project-1", id: "task-1" },
      clockify,
    );
    expectTransitionBoundCompensationPlan(prepared.operation);

    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);

    expect(result).toMatchObject({ ok: false, code: "write_failed" });
    expect(prepared.store.listOperationSteps(prepared.operation.operationId).map((step) => [step.planStepId, step.status])).toEqual([
      ["complete-task-for-delete", "compensated"],
      ["delete-task", "definitive_failed"],
      ["restore-task-status", "compensated"],
    ]);
    expectJournalFingerprintsMatchPlan(prepared.store, prepared.operation);
    expect(fake.state.tasks[0]).toMatchObject({ status: "ACTIVE" });
    prepared.store.close();
  });
});
