import { describe, expect, it } from "vitest";
import { executeAction } from "../../src/harness/actions.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { createStore } from "../../src/db/store.js";

describe("prepared safe writes", () => {
  it("journals the production tag mutation as one executing then terminal host step", async () => {
    const store = createStore(":memory:");
    const fake = createFakeWorkspace();
    const observed: string[] = [];
    let operationId = "";
    const originalCreate = fake.client.createTag.bind(fake.client);
    fake.client.createTag = async (input) => {
      observed.push(store.listOperationSteps(operationId)[0]?.status ?? "missing");
      return originalCreate(input);
    };

    const result = await executeAction({
      actionName: "clockify_tags_create",
      args: { name: "  Normalized tag  " },
      context: {
        workspaceId: "workspace",
        adminUserId: "admin",
        policy: defaultAdminPolicy(),
        clockify: fake.client,
        operationJournal: {
          prepare(actionName, operation, mutationPlan) {
            operationId = store.prepareOperationRun({
              id: "safe-tag-operation",
              sessionId: "session",
              workspaceId: "workspace",
              adminUserId: "admin",
              actionName,
              actionFingerprint: "action",
              catalogHash: "catalog",
              operationHash: "operation",
              operation,
              mutationPlan,
            });
            return operationId;
          },
          markExecuting(id) {
            if (!store.markOperationExecuting(id)) throw new Error("operation_not_prepared");
          },
          scope(id) {
            return store.mutationStepJournal(id);
          },
          settle(id, status, settledResult) {
            store.settleOperationResult(id, status, settledResult);
          },
        },
      },
    });

    expect(observed).toEqual(["executing"]);
    expect(fake.counts.createTag).toBe(1);
    expect(result).toMatchObject({ kind: "receipt", receipt: { ok: true } });
    expect(store.getOperationRun(operationId)).toMatchObject({
      operation: { body: { name: "Normalized tag" } },
      mutationPlan: { mode: "single", steps: [{ id: "create-tag", kind: "primary" }] },
      status: "succeeded",
    });
    expect(store.listOperationSteps(operationId)).toMatchObject([
      {
        planStepId: "create-tag",
        kind: "primary",
        status: "succeeded",
        externalId: expect.any(String),
        effect: { created: { type: "tag", id: expect.any(String), name: "Normalized tag" } },
      },
    ]);
    store.close();
  });

});
