import { describe, expect, it } from "vitest";
import { createStore } from "../../src/db/store.js";
import { executeAction } from "../../src/harness/actions.js";
import { actionFingerprint, catalogHash } from "../../src/harness/catalog.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace, type FakeWorkspaceSeed } from "../helpers/fake-clockify.js";

type Case = {
  name: string;
  actionName: string;
  args: Record<string, unknown>;
  seed?: FakeWorkspaceSeed;
  expectedSteps: string[];
  expectedCounts: Record<string, number>;
};

const cases: Case[] = [
  {
    name: "start timer",
    actionName: "clockify_start_timer",
    args: { description: "Focus" },
    expectedSteps: ["start-timer"],
    expectedCounts: { startTimeEntryAtomic: 1 },
  },
  {
    name: "log work",
    actionName: "clockify_log_work",
    args: { description: "Focus", start: "2026-06-06T09:00:00Z", end: "2026-06-06T10:00:00Z" },
    expectedSteps: ["log-time-entry"],
    expectedCounts: { createTimeEntryAtomic: 1 },
  },
  {
    name: "create project",
    actionName: "clockify_projects_create",
    args: { name: "New project" },
    expectedSteps: ["create-project"],
    expectedCounts: { createProjectAtomic: 1 },
  },
  {
    name: "create project from template",
    actionName: "clockify_projects_from_template",
    args: { templateId: "template-1", name: "New project" },
    seed: { projects: [{ id: "template-1", name: "Template" }] },
    expectedSteps: ["create-project-from-template"],
    expectedCounts: { createProjectFromTemplateAtomic: 1 },
  },
  {
    name: "create task",
    actionName: "clockify_tasks_create",
    args: { projectId: "project-1", name: "New task" },
    seed: { projects: [{ id: "project-1", name: "Project" }] },
    expectedSteps: ["create-task"],
    expectedCounts: { createTaskAtomic: 1 },
  },
  {
    name: "create and enrich client",
    actionName: "clockify_clients_create",
    args: { name: "New client", ccEmails: ["billing@example.com"], currency: "EUR" },
    seed: { currencies: [{ id: "currency-eur", code: "EUR" }] },
    expectedSteps: ["create-client", "enrich-client"],
    expectedCounts: { createClientBaseAtomic: 1, updateClientAtomic: 1 },
  },
];

async function executeWithStore(testCase: Case) {
  const fake = createFakeWorkspace(testCase.seed);
  const store = createStore(":memory:");
  let operationId = "";
  const result = await executeAction({
    actionName: testCase.actionName,
    args: testCase.args,
    context: {
      workspaceId: "workspace",
      adminUserId: "admin",
      policy: defaultAdminPolicy(),
      clockify: fake.client,
      now: () => new Date("2026-06-06T00:00:00.000Z"),
      timeZone: "UTC",
      operationJournal: {
        prepare(actionName, operation, mutationPlan) {
          operationId = store.prepareOperationRun({
            id: `safe:${testCase.actionName}`,
            sessionId: "session",
            workspaceId: "workspace",
            adminUserId: "admin",
            actionName,
            actionFingerprint: actionFingerprint(actionName)!,
            catalogHash: catalogHash(),
            operationHash: `hash:${testCase.actionName}`,
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
  return { fake, store, operationId, result };
}

describe("structure/time prepared safe writes use durable host steps", () => {
  it.each(cases)("journals normalized atomic steps for $name", async (testCase) => {
    const run = await executeWithStore(testCase);

    expect(run.result).toMatchObject({ kind: "receipt", receipt: { ok: true } });
    expect(run.store.getOperationRun(run.operationId)).toMatchObject({ status: "succeeded" });
    expect(run.store.listOperationSteps(run.operationId).map((step) => [step.planStepId, step.status])).toEqual(
      testCase.expectedSteps.map((id) => [id, "succeeded"]),
    );
    for (const [method, count] of Object.entries(testCase.expectedCounts)) {
      expect(run.fake.counts[method]).toBe(count);
    }
    run.store.close();
  });
});
