import { describe, expect, it, vi } from "vitest";
import { AmbiguousWriteOutcome } from "../../src/clockify/write-outcome.js";
import { createStore } from "../../src/db/store.js";
import { executeAction } from "../../src/harness/actions.js";
import { actionFingerprint, catalogHash } from "../../src/harness/catalog.js";
import { hashOperation } from "../../src/harness/confirmations.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import {
  STRUCTURE_STARTUP_RECONCILIATION,
  STRUCTURE_STARTUP_RECONCILIATION_HANDLER_COUNT,
  hasStructureStartupReconciliationHandler,
  reconcileWithStructureStartupRegistry,
  type StructureStartupReconciliationReadClient,
} from "../../src/harness/workflows/structure-startup-reconciliation.js";
import { createFakeWorkspace, type FakeWorkspaceSeed } from "../helpers/fake-clockify.js";

const EXPECTED_BINDINGS = [
  ["clockify_start_timer", "start-timer", "create"],
  ["clockify_stop_timer", "stop-timer", "state-command"],
  ["clockify_log_work", "log-time-entry", "create"],
  ["clockify_fix_entry", "update-time-entry", "update"],
  ["clockify_entries_delete", "delete-time-entry", "delete"],
  ["clockify_entries_mark_invoiced", "mark-entries-invoiced", "state-command"],
  ["clockify_projects_create", "create-project", "create"],
  ["clockify_projects_from_template", "create-project-from-template", "create"],
  ["clockify_projects_update", "update-project", "update"],
  ["clockify_projects_archive", "archive-project", "state-command"],
  ["clockify_projects_delete", "archive-project-for-delete", "state-command"],
  ["clockify_projects_delete", "delete-project", "delete"],
  ["clockify_projects_rate_update", "update-project-rate", "update"],
  ["clockify_projects_estimate_update", "update-project-estimate", "update"],
  ["clockify_projects_memberships_update", "update-project-memberships", "update"],
  ["clockify_tasks_create", "create-task", "create"],
  ["clockify_tasks_update", "update-task", "update"],
  ["clockify_tasks_delete", "complete-task-for-delete", "state-command"],
  ["clockify_tasks_delete", "delete-task", "delete"],
  ["clockify_tasks_rate_update", "update-task-rate", "update"],
  ["clockify_clients_create", "create-client", "create"],
  ["clockify_clients_create", "enrich-client", "update"],
  ["clockify_clients_update", "update-client", "update"],
  ["clockify_clients_delete", "archive-client", "state-command"],
  ["clockify_clients_delete", "delete-client", "delete"],
  ["clockify_tags_create", "create-tag", "create"],
  ["clockify_tags_update", "update-tag", "update"],
  ["clockify_tags_delete", "delete-tag", "delete"],
  ["clockify_create_work_package", "create-tag", "create"],
  ["clockify_create_work_package", "create-client", "create"],
  ["clockify_create_work_package", "create-project", "create"],
  ["clockify_create_work_package", "create-task", "create"],
  ["clockify_create_work_package", "start-timer", "create"],
  ["clockify_create_work_package", "verify-reused-entities", "composed"],
  ["clockify_setup_project", "create-project", "create"],
  ["clockify_setup_project", "add-project-members", "update"],
  ["clockify_setup_project", "set-project-rate-*", "update"],
  ["clockify_setup_task", "create-task", "create"],
  ["clockify_setup_task", "set-task-rate", "update"],
] as const;

type Strategy = typeof EXPECTED_BINDINGS[number][2];

function startupInput(input: {
  actionName: string;
  planStepId: string;
  strategy: Strategy;
  operation: unknown;
  evidence?: unknown;
  clockify: StructureStartupReconciliationReadClient;
}) {
  const binding = {
    operationId: "operation",
    stepId: "step",
    planStepId: input.planStepId,
    strategy: input.strategy,
    actionName: input.actionName,
    actionFingerprint: "action-fingerprint",
    catalogHash: "catalog-hash",
  } as const;
  const step = {
    id: "step",
    status: "outcome_unknown",
    kind: "primary" as const,
    planStepId: input.planStepId,
    strategy: input.strategy,
    evidence: input.evidence ?? {},
  };
  return {
    binding,
    candidate: {
      id: "operation",
      status: "outcome_unknown",
      workspaceId: "workspace",
      adminUserId: "admin",
      actionName: input.actionName,
      actionFingerprint: "action-fingerprint",
      catalogHash: "catalog-hash",
      operation: input.operation,
      steps: [step],
    },
    step,
    clockify: input.clockify,
  };
}

async function runSafeWrite(input: {
  actionName: string;
  args: Record<string, unknown>;
  seed?: FakeWorkspaceSeed;
  ambiguousMethod: "createTimeEntryAtomic" | "createProjectAtomic" | "createProjectFromTemplateAtomic" | "createTaskAtomic";
}) {
  const fake = createFakeWorkspace(input.seed);
  (fake.client[input.ambiguousMethod] as (...args: never[]) => Promise<never>) = async () => {
    throw new AmbiguousWriteOutcome("POST", input.actionName, "socket closed");
  };
  const store = createStore(":memory:");
  let operationId = "";
  const result = await executeAction({
    actionName: input.actionName,
    args: input.args,
    context: {
      workspaceId: "workspace",
      adminUserId: "admin",
      policy: defaultAdminPolicy(),
      clockify: fake.client,
      timeZone: "UTC",
      now: () => new Date("2026-07-14T09:00:00.000Z"),
      operationJournal: {
        prepare(actionName, operation, mutationPlan) {
          operationId = store.prepareOperationRun({
            id: `safe:${actionName}`,
            sessionId: "session",
            workspaceId: "workspace",
            adminUserId: "admin",
            actionName,
            actionFingerprint: actionFingerprint(actionName)!,
            catalogHash: catalogHash(),
            operationHash: hashOperation({ actionName, operation, mutationPlan }),
            operation,
            mutationPlan,
          });
          return operationId;
        },
        markExecuting(id) {
          if (!store.markOperationExecuting(id)) throw new Error("operation_not_prepared");
        },
        scope: (id) => store.mutationStepJournal(id),
        settle: (id, status, settledResult) => store.settleOperationResult(id, status, settledResult),
      },
    },
  });
  return { store, operationId, result };
}

describe("structure startup reconciliation", () => {
  it("exports one immutable read handler for every Task 7 declared binding", () => {
    const actual = Object.entries(STRUCTURE_STARTUP_RECONCILIATION).flatMap(([actionName, steps]) =>
      Object.entries(steps).map(([planStepId, strategy]) => [actionName, planStepId, strategy]),
    );
    expect(actual).toEqual(EXPECTED_BINDINGS);
    expect(STRUCTURE_STARTUP_RECONCILIATION_HANDLER_COUNT).toBe(EXPECTED_BINDINGS.length);
    expect(Object.isFrozen(STRUCTURE_STARTUP_RECONCILIATION)).toBe(true);
    for (const [actionName, steps] of Object.entries(STRUCTURE_STARTUP_RECONCILIATION)) {
      expect(Object.isFrozen(steps), actionName).toBe(true);
      for (const planStepId of Object.keys(steps)) {
        expect(hasStructureStartupReconciliationHandler(actionName, planStepId), `${actionName}/${planStepId}`).toBe(true);
      }
    }
    expect(hasStructureStartupReconciliationHandler("clockify_setup_project", "set-project-rate-19")).toBe(true);
  });

  it("exposes no Clockify write method to a structure startup handler", () => {
    type ExposesCreate = "createProjectAtomic" extends keyof StructureStartupReconciliationReadClient ? true : false;
    type ExposesUpdate = "updateTaskAtomic" extends keyof StructureStartupReconciliationReadClient ? true : false;
    type ExposesDelete = "deleteTagAtomic" extends keyof StructureStartupReconciliationReadClient ? true : false;
    const exposesMutation: [ExposesCreate, ExposesUpdate, ExposesDelete] = [false, false, false];
    expect(exposesMutation).toEqual([false, false, false]);
  });

  it.each([
    [[], false, false, "non_unique_or_missing"],
    [[{ id: "new", name: "Focus" }], false, true, "authoritative_match"],
    [[{ id: "one", name: "Focus" }, { id: "two", name: "Focus" }], false, false, "non_unique_or_missing"],
    [[{ id: "new", name: "Focus" }], true, false, "incomplete_evidence"],
  ] as const)("uses exact complete-list create semantics for 0/1/multiple/truncated matches", async (rows, truncated, authoritative, reason) => {
    const result = await reconcileWithStructureStartupRegistry(startupInput({
      actionName: "clockify_tags_create",
      planStepId: "create-tag",
      strategy: "create",
      operation: { body: { name: "Focus" }, beforeIds: ["old"] },
      clockify: { listTags: vi.fn(async () => ({ rows, truncated })) } as never,
    }));
    expect(result).toMatchObject({ authoritative, reason });
  });

  it("fails closed when a complete-list create read fails", async () => {
    const result = await reconcileWithStructureStartupRegistry(startupInput({
      actionName: "clockify_tags_create",
      planStepId: "create-tag",
      strategy: "create",
      operation: { body: { name: "Focus" }, beforeIds: [] },
      clockify: { listTags: vi.fn(async () => { throw new Error("offline"); }) } as never,
    }));
    expect(result).toMatchObject({ authoritative: false, reason: "read_failed" });
  });

  it("matches raw replacement updates exactly and proves delete only from absence", async () => {
    const body = { id: "project", name: "Renamed", retained: { revision: 2 } };
    const updated = await reconcileWithStructureStartupRegistry(startupInput({
      actionName: "clockify_projects_update",
      planStepId: "update-project",
      strategy: "update",
      operation: { payload: { id: "project", body } },
      clockify: { getProjectMutationState: vi.fn(async () => body) } as never,
    }));
    expect(updated).toMatchObject({ authoritative: true, reason: "authoritative_match" });

    const deleted = await reconcileWithStructureStartupRegistry(startupInput({
      actionName: "clockify_tags_delete",
      planStepId: "delete-tag",
      strategy: "delete",
      operation: { payload: { id: "tag" } },
      clockify: { getTag: vi.fn(async () => null) } as never,
    }));
    expect(deleted).toMatchObject({ authoritative: true, reason: "authoritative_match" });
  });

  it.each([
    ["clockify_log_work", { description: "Focus", start: "2026-07-14T09:00:00.000Z", end: "2026-07-14T10:00:00.000Z" }, undefined, "createTimeEntryAtomic"],
    ["clockify_projects_create", { name: "Project" }, undefined, "createProjectAtomic"],
    ["clockify_projects_from_template", { templateId: "template", name: "Project" }, { projects: [{ id: "template", name: "Template" }] }, "createProjectFromTemplateAtomic"],
    ["clockify_tasks_create", { projectId: "project", name: "Task" }, { projects: [{ id: "project", name: "Project" }] }, "createTaskAtomic"],
  ] as const)("persists the immediately-pre-dispatch baseline for %s", async (actionName, args, seed, ambiguousMethod) => {
    const run = await runSafeWrite({ actionName, args, seed: seed as unknown as FakeWorkspaceSeed | undefined, ambiguousMethod });
    expect(run.result).toMatchObject({ kind: "receipt", receipt: { ok: false, code: "commit_outcome_unknown" } });
    expect(run.store.listOperationSteps(run.operationId)).toMatchObject([{
      status: "outcome_unknown",
      detail: { preDispatch: { ids: expect.any(Array), truncated: false } },
    }]);
    expect(run.store.listStartupReconciliationCandidates()).toMatchObject([{
      steps: [{ evidence: { preDispatch: { ids: expect.any(Array), truncated: false } } }],
    }]);
    run.store.close();
  });
});
