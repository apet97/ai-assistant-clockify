import { describe, expect, it } from "vitest";
import { createStore } from "../../src/db/store.js";
import { executeMutationWorkflow, executeStep } from "../../src/harness/mutation-workflow.js";
import { AmbiguousWriteOutcome, DefinitiveWriteFailure } from "../../src/clockify/write-outcome.js";
import { errorReceipt, successReceipt } from "../../src/harness/receipts.js";
import * as workflowModule from "../../src/harness/mutation-workflow.js";
import type { JournaledMutationStep, MutationStepJournal } from "../../src/harness/mutation-contract.js";

function operation(store: ReturnType<typeof createStore>, id: string): string {
  return store.prepareOperationRun({
    id,
    sessionId: "session",
    workspaceId: "workspace",
    adminUserId: "admin",
    actionName: "test_mutation",
    actionFingerprint: "action",
    catalogHash: "catalog",
    operationHash: "operation",
    operation: { normalized: true },
    mutationPlan: {
      mode: "curated",
      steps: [
        { id: "one", kind: "primary" },
        { id: "two", kind: "primary" },
      ],
    },
  });
}

function compensableOperation(store: ReturnType<typeof createStore>, id: string) {
  const operationId = store.prepareOperationRun({
    id,
    sessionId: "session",
    workspaceId: "workspace",
    adminUserId: "admin",
    actionName: "test_mutation",
    actionFingerprint: "action",
    catalogHash: "catalog",
    operationHash: "operation",
    mutationPlan: {
      mode: "curated",
      steps: [
        { id: "create", kind: "primary" },
        { id: "delete-created", kind: "compensation" },
      ],
    },
  });
  store.markOperationExecuting(operationId);
  const sourceId = store.prepareOperationStep({
    operationId,
    planStepId: "create",
    index: 0,
    name: "Create",
    kind: "primary",
  });
  store.markOperationStepExecuting(sourceId);
  store.settleOperationStep(sourceId, "succeeded", { externalId: "created-1" });
  store.settleOperationRun(operationId, "definitive_failed");
  return { operationId, sourceId, journal: store.mutationStepJournal(operationId) };
}

type ExecuteCompensationStep = (input: {
  journal: MutationStepJournal;
  operationId: string;
  step: {
    id: string;
    index: number;
    name: string;
    kind: "compensation";
    compensatesStepId: string;
  };
  dispatch: () => Promise<{ externalId?: string; effect?: unknown; detail?: unknown }>;
}) => Promise<JournaledMutationStep>;

describe("durable mutation workflow", () => {
  it("persists prepared then executing before dispatch and settles the external effect", async () => {
    const store = createStore(":memory:");
    const operationId = operation(store, "operation-order");
    store.markOperationExecuting(operationId);
    const observed: string[] = [];

    const result = await executeStep({
      journal: store.mutationStepJournal(operationId),
      operationId,
      step: { id: "one", index: 0, name: "First", kind: "primary" },
      async dispatch() {
        observed.push(store.listOperationSteps(operationId)[0]?.status ?? "missing");
        return { externalId: "external-1", effect: { created: "external-1" } };
      },
    });

    expect(observed).toEqual(["executing"]);
    expect(result).toMatchObject({
      status: "succeeded",
      externalId: "external-1",
      effect: { created: "external-1" },
    });
    store.close();
  });

  it("keeps a known primary success nonretryable when terminal settlement persistently fails", async () => {
    const store = createStore(":memory:");
    const operationId = operation(store, "operation-primary-settlement-degraded");
    store.markOperationExecuting(operationId);
    const baseJournal = store.mutationStepJournal(operationId);
    const journal: MutationStepJournal = {
      ...baseJournal,
      settleOperationStep() {
        throw new Error("persistent_step_settlement_failure");
      },
      settleOperationStepDegraded() {
        throw new Error("persistent_step_fallback_failure");
      },
    };
    let dispatches = 0;

    const result = await executeStep({
      journal,
      operationId,
      step: { id: "one", index: 0, name: "First", kind: "primary" },
      dispatch: async () => {
        dispatches += 1;
        return { externalId: "external-1", effect: { created: "external-1" } };
      },
    });

    expect(result).toMatchObject({
      status: "succeeded",
      externalId: "external-1",
      effect: { created: "external-1" },
      detail: { journalDegraded: true },
    });
    await expect(executeStep({
      journal,
      operationId,
      step: { id: "one", index: 0, name: "First", kind: "primary" },
      dispatch: async () => {
        dispatches += 1;
        return {};
      },
    })).rejects.toThrow();
    expect(dispatches).toBe(1);
    expect(baseJournal.listOperationSteps()).toMatchObject([{ status: "executing" }]);
    store.close();
  });

  it("stops a composed workflow after a degraded known success and settles the operation partial", async () => {
    const store = createStore(":memory:");
    const operationId = operation(store, "operation-composed-settlement-degraded");
    store.markOperationExecuting(operationId);
    const baseJournal = store.mutationStepJournal(operationId);
    const journal: MutationStepJournal = {
      ...baseJournal,
      settleOperationStep() {
        throw new Error("persistent_step_settlement_failure");
      },
    };
    let laterDispatches = 0;

    const result = await executeMutationWorkflow({
      journal,
      operationId,
      actionName: "test_mutation",
      steps: [
        {
          id: "one",
          index: 0,
          name: "First",
          kind: "primary",
          dispatch: async () => ({ externalId: "created-1", effect: { created: "created-1" } }),
        },
        {
          id: "two",
          index: 1,
          name: "Second",
          kind: "primary",
          dispatch: async () => {
            laterDispatches += 1;
            return {};
          },
        },
      ],
      onSuccess: () => successReceipt({ action: "test_mutation" }),
      onPartial: () => {
        throw new Error("definitive failure partial should not be built");
      },
      onJournalDegraded: (completed) => ({
        kind: "partial",
        receipt: successReceipt({
          action: "test_mutation",
          changed: { created: [{ type: "thing", id: completed[0]!.externalId! }] },
          warnings: [{ code: "operation_journal_degraded", message: "Step journal degraded." }],
        }),
        message: "Clockify confirmed the first step; no later step was dispatched.",
        recovery: { hint: "Verify the known effect before a fresh operation.", retryable: false },
      }),
      onFailure: () => errorReceipt({ action: "test_mutation", code: "failed", message: "failed" }),
    });

    expect(laterDispatches).toBe(0);
    expect(result).toMatchObject({
      kind: "partial",
      receipt: {
        ok: true,
        changed: { created: [{ id: "created-1" }] },
        warnings: [{ code: "operation_journal_degraded" }],
      },
      recovery: { retryable: false },
    });
    store.settleOperationResult(operationId, "partial", result);
    expect(store.getOperationRun(operationId)?.status).toBe("partial");
    store.close();
  });

  it("returns a one-step workflow's known success with a degradation warning", async () => {
    const store = createStore(":memory:");
    const operationId = operation(store, "operation-single-settlement-degraded");
    store.markOperationExecuting(operationId);
    const baseJournal = store.mutationStepJournal(operationId);
    const journal: MutationStepJournal = {
      ...baseJournal,
      settleOperationStep() {
        throw new Error("persistent_step_settlement_failure");
      },
    };

    const result = await executeMutationWorkflow({
      journal,
      operationId,
      actionName: "test_mutation",
      steps: [{
        id: "one",
        index: 0,
        name: "First",
        kind: "primary",
        dispatch: async () => ({ externalId: "created-1", effect: { created: "created-1" } }),
      }],
      onSuccess: (completed) => successReceipt({
        action: "test_mutation",
        changed: { created: [{ type: "thing", id: completed[0]!.externalId! }] },
      }),
      onPartial: () => {
        throw new Error("definitive failure partial should not be built");
      },
      onJournalDegraded: () => {
        throw new Error("single-step degradation must remain success");
      },
      onFailure: () => errorReceipt({ action: "test_mutation", code: "failed", message: "failed" }),
    });

    expect(result).toMatchObject({
      ok: true,
      changed: { created: [{ id: "created-1" }] },
      warnings: [{ code: "operation_journal_degraded" }],
    });
    store.settleOperationResult(operationId, "succeeded", result);
    expect(store.getOperationRun(operationId)?.status).toBe("succeeded");
    store.close();
  });

  it("classifies an ambiguous dispatch as outcome_unknown and runs no later step", async () => {
    const store = createStore(":memory:");
    const operationId = operation(store, "operation-unknown");
    store.markOperationExecuting(operationId);
    let laterCalls = 0;

    const result = await executeMutationWorkflow({
      journal: store.mutationStepJournal(operationId),
      operationId,
      actionName: "test_mutation",
      steps: [
        {
          id: "one",
          index: 0,
          name: "First",
          kind: "primary",
          dispatch: async () => {
            throw new AmbiguousWriteOutcome("POST", "/one", "socket closed");
          },
        },
        {
          id: "two",
          index: 1,
          name: "Second",
          kind: "primary",
          dispatch: async () => {
            laterCalls += 1;
            return { effect: { changed: true } };
          },
        },
      ],
      onSuccess: () => successReceipt({ action: "test_mutation" }),
      onPartial: () => {
        throw new Error("partial should not be built");
      },
      onJournalDegraded: () => {
        throw new Error("degraded partial should not be built");
      },
      onFailure: () => errorReceipt({ action: "test_mutation", code: "failed", message: "failed" }),
    });

    expect(laterCalls).toBe(0);
    expect(result).toMatchObject({ ok: false, code: "commit_outcome_unknown" });
    expect(store.listOperationSteps(operationId)).toHaveLength(1);
    expect(store.listOperationSteps(operationId)[0]?.status).toBe("outcome_unknown");
    store.close();
  });

  it("propagates a known earlier effect plus later definitive failure as partial", async () => {
    const store = createStore(":memory:");
    const operationId = operation(store, "operation-partial");
    store.markOperationExecuting(operationId);

    const result = await executeMutationWorkflow({
      journal: store.mutationStepJournal(operationId),
      operationId,
      actionName: "test_mutation",
      steps: [
        {
          id: "one",
          index: 0,
          name: "First",
          kind: "primary",
          dispatch: async () => ({ externalId: "created-1", effect: { created: "created-1" } }),
        },
        {
          id: "two",
          index: 1,
          name: "Second",
          kind: "primary",
          dispatch: async () => {
            throw new DefinitiveWriteFailure("POST", "/two", "rejected", 400);
          },
        },
      ],
      onSuccess: () => successReceipt({ action: "test_mutation" }),
      onPartial: (completed, failed) => {
        const receipt = successReceipt({
          action: "test_mutation",
          changed: { created: [{ type: "thing", id: completed[0]!.externalId! }] },
        });
        return {
          kind: "partial",
          receipt,
          message: `Stopped at ${failed.planStepId}`,
          recovery: { hint: "Review the recorded effect before retrying.", retryable: false },
        };
      },
      onJournalDegraded: () => {
        throw new Error("degraded partial should not be built");
      },
      onFailure: () => errorReceipt({ action: "test_mutation", code: "failed", message: "failed" }),
    });

    expect(result).toMatchObject({
      kind: "partial",
      receipt: { ok: true, changed: { created: [{ id: "created-1" }] } },
      message: "Stopped at two",
    });
    expect(store.listOperationSteps(operationId).map((step) => step.status)).toEqual([
      "succeeded",
      "definitive_failed",
    ]);
    store.close();
  });

  it("uses the dedicated compensation executor and preserves the known source on definitive rejection", async () => {
    const store = createStore(":memory:");
    const { operationId, sourceId, journal } = compensableOperation(store, "operation-compensation-definite");
    const executeCompensationStep = (workflowModule as unknown as {
      executeCompensationStep?: ExecuteCompensationStep;
    }).executeCompensationStep;
    expect(executeCompensationStep).toBeTypeOf("function");
    if (!executeCompensationStep) return;

    const result = await executeCompensationStep({
      journal,
      operationId,
      step: {
        id: "delete-created",
        index: 1,
        name: "Delete created",
        kind: "compensation",
        compensatesStepId: sourceId,
      },
      dispatch: async () => {
        throw new DefinitiveWriteFailure("DELETE", "/created-1", "rejected", 409);
      },
    });

    expect(result.status).toBe("compensation_failed");
    expect(journal.listOperationSteps()).toMatchObject([
      { id: sourceId, status: "succeeded", externalId: "created-1" },
      { id: result.id, status: "compensation_failed" },
    ]);
    store.close();
  });

  it("settles an ambiguous compensation unknown, preserves source truth, and performs one dispatch", async () => {
    const store = createStore(":memory:");
    const { operationId, sourceId, journal } = compensableOperation(store, "operation-compensation-unknown");
    const executeCompensationStep = (workflowModule as unknown as {
      executeCompensationStep?: ExecuteCompensationStep;
    }).executeCompensationStep;
    expect(executeCompensationStep).toBeTypeOf("function");
    if (!executeCompensationStep) return;
    let dispatches = 0;

    const result = await executeCompensationStep({
      journal,
      operationId,
      step: {
        id: "delete-created",
        index: 1,
        name: "Delete created",
        kind: "compensation",
        compensatesStepId: sourceId,
      },
      dispatch: async () => {
        dispatches += 1;
        throw new AmbiguousWriteOutcome("DELETE", "/created-1", "socket closed");
      },
    });

    expect(dispatches).toBe(1);
    expect(result.status).toBe("outcome_unknown");
    expect(journal.listOperationSteps()).toMatchObject([
      { id: sourceId, status: "succeeded", externalId: "created-1" },
      { id: result.id, status: "outcome_unknown" },
    ]);
    store.close();
  });

  it("keeps a known compensation success nonretryable when terminal settlement persistently fails", async () => {
    const store = createStore(":memory:");
    const { operationId, sourceId, journal: baseJournal } = compensableOperation(
      store,
      "operation-compensation-settlement-degraded",
    );
    const executeCompensationStep = (workflowModule as unknown as {
      executeCompensationStep?: ExecuteCompensationStep;
    }).executeCompensationStep;
    expect(executeCompensationStep).toBeTypeOf("function");
    if (!executeCompensationStep) return;
    const journal: MutationStepJournal = {
      ...baseJournal,
      settleCompensationStep() {
        throw new Error("persistent_compensation_settlement_failure");
      },
      settleCompensationStepDegraded() {
        throw new Error("persistent_compensation_fallback_failure");
      },
    };
    let dispatches = 0;

    const result = await executeCompensationStep({
      journal,
      operationId,
      step: {
        id: "delete-created",
        index: 1,
        name: "Delete created",
        kind: "compensation",
        compensatesStepId: sourceId,
      },
      dispatch: async () => {
        dispatches += 1;
        return { externalId: "created-1", effect: { deleted: "created-1" } };
      },
    });

    expect(result).toMatchObject({
      status: "compensated",
      externalId: "created-1",
      effect: { deleted: "created-1" },
      detail: { journalDegraded: true },
    });
    await expect(executeCompensationStep({
      journal,
      operationId,
      step: {
        id: "delete-created",
        index: 1,
        name: "Delete created",
        kind: "compensation",
        compensatesStepId: sourceId,
      },
      dispatch: async () => {
        dispatches += 1;
        return {};
      },
    })).rejects.toThrow();
    expect(dispatches).toBe(1);
    expect(baseJournal.listOperationSteps()).toMatchObject([
      { id: sourceId, status: "compensating" },
      { status: "executing" },
    ]);
    store.close();
  });

  it("persists a minimal degraded compensation marker without losing the known result", async () => {
    const store = createStore(":memory:");
    const { operationId, sourceId, journal: baseJournal } = compensableOperation(
      store,
      "operation-compensation-minimal-settlement",
    );
    const journal: MutationStepJournal = {
      ...baseJournal,
      settleCompensationStep() {
        throw new Error("full_compensation_settlement_failure");
      },
    };

    const result = await workflowModule.executeCompensationStep({
      journal,
      operationId,
      step: {
        id: "delete-created",
        index: 1,
        name: "Delete created",
        kind: "compensation",
        compensatesStepId: sourceId,
      },
      dispatch: async () => ({ externalId: "created-1", effect: { deleted: "created-1" } }),
    });

    expect(result).toMatchObject({
      status: "compensated",
      effect: { deleted: "created-1" },
      detail: { journalDegraded: true, fullEffectPersisted: false },
    });
    expect(baseJournal.listOperationSteps()).toMatchObject([
      { id: sourceId, status: "compensated" },
      {
        status: "compensated",
        externalId: "created-1",
        detail: { journalDegraded: true, fullEffectPersisted: false },
      },
    ]);
    expect(baseJournal.listOperationSteps()[1]?.effect).toBeUndefined();
    store.close();
  });

  it("rejects compensation through the generic primary executor before dispatch", async () => {
    const store = createStore(":memory:");
    const { operationId, sourceId, journal } = compensableOperation(store, "operation-compensation-bypass");
    let dispatches = 0;

    await expect(executeStep({
      journal,
      operationId,
      step: {
        id: "delete-created",
        index: 1,
        name: "Delete created",
        kind: "compensation",
        compensatesStepId: sourceId,
      },
      dispatch: async () => {
        dispatches += 1;
        return {};
      },
    })).rejects.toThrow(/compensation_requires_dedicated_executor/);
    expect(dispatches).toBe(0);
    expect(journal.listOperationSteps()).toHaveLength(1);
    store.close();
  });
});
