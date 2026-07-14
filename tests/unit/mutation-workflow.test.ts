import { describe, expect, it } from "vitest";
import { createStore } from "../../src/db/store.js";
import { executeMutationWorkflow, executeStep } from "../../src/harness/mutation-workflow.js";
import { AmbiguousWriteOutcome, DefinitiveWriteFailure } from "../../src/clockify/write-outcome.js";
import { errorReceipt, successReceipt } from "../../src/harness/receipts.js";

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

describe("durable mutation workflow", () => {
  it("persists prepared then executing before dispatch and settles the external effect", async () => {
    const store = createStore(":memory:");
    const operationId = operation(store, "operation-order");
    store.markOperationExecuting(operationId);
    const observed: string[] = [];

    const result = await executeStep({
      journal: store,
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

  it("classifies an ambiguous dispatch as outcome_unknown and runs no later step", async () => {
    const store = createStore(":memory:");
    const operationId = operation(store, "operation-unknown");
    let laterCalls = 0;

    const result = await executeMutationWorkflow({
      journal: store,
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

    const result = await executeMutationWorkflow({
      journal: store,
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
});
