import { describe, expect, it } from "vitest";
import { createStore } from "../../src/db/store.js";
import { actionFingerprint, catalogHash } from "../../src/harness/catalog.js";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { hashOperation } from "../../src/harness/confirmations.js";
import type { ActionContext } from "../../src/harness/action.js";
import { AmbiguousWriteOutcome, DefinitiveWriteFailure } from "../../src/clockify/write-outcome.js";
import { createFakeWorkspace, type FakeWorkspace, type FakeWorkspaceSeed } from "../helpers/fake-clockify.js";

const context = (fake: FakeWorkspace): ActionContext => ({
  workspaceId: "ws-1", adminUserId: "admin-1", policy: defaultAdminPolicy(), clockify: fake.client,
  now: () => new Date("2026-07-14T09:00:00Z"),
});

async function prepared(seed: FakeWorkspaceSeed, actionName: string, args: unknown) {
  const fake = createFakeWorkspace(seed);
  const preview = await executeAction({ actionName, args, context: context(fake) });
  if (preview.kind !== "preview") throw new Error(`expected ${actionName} preview, got ${preview.kind}`);
  const store = createStore(":memory:");
  store.prepareOperationRun({
    id: preview.operation.operationId,
    confirmationId: `confirmation-${preview.operation.operationId}`,
    sessionId: "session", workspaceId: "ws-1", adminUserId: "admin-1",
    actionName, actionFingerprint: actionFingerprint(actionName)!, catalogHash: catalogHash(), operationHash: hashOperation(preview.operation),
    operation: preview.operation, mutationPlan: preview.operation.mutationPlan,
  });
  store.markOperationExecuting(preview.operation.operationId);
  return {
    fake,
    operation: preview.operation,
    store,
    commitContext: {
      ...context(fake),
      mutationJournal: store.mutationStepJournal(preview.operation.operationId),
    },
  };
}

async function journaled(seed: FakeWorkspaceSeed, actionName: string, args: unknown) {
  const run = await prepared(seed, actionName, args);
  const result = await commitConfirmedOperation(run.commitContext, run.operation);
  const { fake, store } = run;
  const steps = store.listOperationSteps(run.operation.operationId).map((step) => [step.planStepId, step.status]);
  store.close();
  return { fake, result, steps };
}

describe("phase 5 leave-domain operation journals", () => {
  it("journals category rename and archive as separate ordered mutations", async () => {
    const { result, steps } = await journaled({ expenseCategories: [{ id: "cat-1", name: "Travel", archived: false }] }, "clockify_expenses_categories_update", { id: "cat-1", name: "Trips", archived: true });
    expect(result).toMatchObject({ ok: true });
    expect(steps).toEqual([["rename-expense-category", "succeeded"], ["set-expense-category-status", "succeeded"]]);
  });

  it("journals archive then delete without hiding the intermediate effect", async () => {
    const { result, steps } = await journaled({ expenseCategories: [{ id: "cat-1", name: "Travel", archived: false }] }, "clockify_expenses_categories_delete", { id: "cat-1" });
    expect(result).toMatchObject({ ok: true });
    expect(steps).toEqual([["archive-expense-category", "succeeded"], ["delete-expense-category", "succeeded"]]);
  });

  it.each([
    ["clockify_custom_fields_set_value_project", { projectId: "proj-1", fieldId: "cf-1", value: "High" }, { customFields: [{ id: "cf-1", name: "Priority", type: "TXT" }], projects: [{ id: "proj-1", name: "Project" }] }, "set-project-custom-field"],
    ["clockify_time_off_requests_create", { policyId: "pol-1", start: "tomorrow", end: "tomorrow" }, { timeOffPolicies: [{ id: "pol-1", name: "Vacation", status: "ACTIVE", timeUnit: "DAYS" }] }, "create-time-off-request"],
    ["clockify_time_off_approve", { policyId: "pol-1", requestId: "req-1" }, { timeOffPolicies: [{ id: "pol-1", name: "Vacation", status: "ACTIVE", timeUnit: "DAYS" }], timeOffRequests: [{ id: "req-1", policyId: "pol-1", status: "PENDING" }] }, "approve-time-off-request"],
    ["clockify_holidays_update", { id: "hol-1", name: "Foundation Day" }, { holidays: [{ id: "hol-1", name: "Founders Day", startDate: "2026-08-01", endDate: "2026-08-01", userIds: ["admin-1"] }] }, "update-holiday"],
  ] as const)("journals %s through its declared single step", async (actionName, args, seed, step) => {
    const { result, steps } = await journaled(seed as unknown as FakeWorkspaceSeed, actionName, args);
    expect(result).toMatchObject({ ok: true });
    expect(steps).toEqual([[step, "succeeded"]]);
  });

  it("classifies an ambiguous time-off state command once and exposes it for read-only restart reconciliation", async () => {
    const run = await prepared(
      {
        timeOffPolicies: [{ id: "pol-1", name: "Vacation", status: "ACTIVE", timeUnit: "DAYS" }],
        timeOffRequests: [{ id: "req-1", policyId: "pol-1", status: "PENDING" }],
      },
      "clockify_time_off_approve",
      { policyId: "pol-1", requestId: "req-1" },
    );
    let calls = 0;
    run.fake.client.setTimeOffRequestStatusAtomic = async () => {
      calls += 1;
      throw new AmbiguousWriteOutcome("PATCH", "/time-off/requests/req-1", "socket closed after dispatch");
    };

    const result = await commitConfirmedOperation(run.commitContext, run.operation);
    expect(result).toMatchObject({ ok: false, code: "commit_outcome_unknown", recovery: { retryable: false } });
    expect(calls).toBe(1);
    expect(run.store.listOperationSteps(run.operation.operationId)).toMatchObject([{ status: "outcome_unknown" }]);

    run.store.settleOperationRun(run.operation.operationId, "outcome_unknown");
    expect(run.store.listStartupReconciliationCandidates()).toMatchObject([{
      id: run.operation.operationId,
      steps: [{ planStepId: "approve-time-off-request", strategy: "state-command" }],
    }]);
    run.store.close();
  });

  it("returns partial when category rename succeeds and the following status mutation definitively fails", async () => {
    const run = await prepared(
      { expenseCategories: [{ id: "cat-1", name: "Travel", archived: false }] },
      "clockify_expenses_categories_update",
      { id: "cat-1", name: "Trips", archived: true },
    );
    let statusCalls = 0;
    run.fake.client.setExpenseCategoryArchivedAtomic = async () => {
      statusCalls += 1;
      throw new DefinitiveWriteFailure("PATCH", "/expense-categories/cat-1/status", "rejected", 400);
    };

    const result = await commitConfirmedOperation(run.commitContext, run.operation);
    expect(result).toMatchObject({ kind: "partial" });
    expect(statusCalls).toBe(1);
    expect(run.store.listOperationSteps(run.operation.operationId).map((step) => [step.planStepId, step.status])).toEqual([
      ["rename-expense-category", "succeeded"],
      ["set-expense-category-status", "definitive_failed"],
    ]);
    run.store.close();
  });
});
