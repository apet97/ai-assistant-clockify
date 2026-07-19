import { describe, expect, it } from "vitest";
import { executeAction } from "../../src/harness/actions.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { createStore } from "../../src/db/store.js";
import { getAction } from "../../src/harness/catalog.js";
import { executeStep } from "../../src/harness/mutation-workflow.js";
import { successReceipt } from "../../src/harness/receipts.js";
import { createRestWorkspaceClient } from "../../src/clockify/rest-workspace.js";

describe("prepared safe writes", () => {
  it("returns a verified reuse-only work package without inventing a mutation step", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "tag-existing", name: "Existing" }] });
    let preparedOperations = 0;
    const result = await executeAction({
      actionName: "clockify_create_work_package",
      args: { tag: { name: "Existing" } },
      context: {
        workspaceId: "workspace",
        adminUserId: "admin",
        policy: defaultAdminPolicy(),
        clockify: fake.client,
        operationJournal: {
          prepare() { preparedOperations += 1; throw new Error("reuse_only_must_not_prepare_mutation"); },
          markExecuting() { throw new Error("reuse_only_must_not_execute_mutation"); },
          scope() { throw new Error("reuse_only_must_not_open_mutation_scope"); },
          settle() { throw new Error("reuse_only_must_not_settle_mutation"); },
        },
      },
    });

    expect(result).toMatchObject({
      kind: "receipt",
      receipt: { ok: true, changed: { reused: [{ type: "tag", id: "tag-existing" }] } },
    });
    expect(preparedOperations).toBe(0);
  });

  it("records dispatched_at at the real REST fetch boundary", async () => {
    const store = createStore(":memory:");
    let operationId = "";
    const fetchImpl = async (url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
      const method = init.method ?? "GET";
      if (method === "GET" && String(url).includes("/tags")) {
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && String(url).endsWith("/tags")) {
        expect(store.listOperationSteps(operationId)[0]).toMatchObject({
          status: "executing",
          queuedAt: expect.any(String),
          dispatchedAt: expect.any(String),
        });
        return new Response(JSON.stringify({ id: "tag-1", name: "Boundary" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request: ${method} ${String(url)}`);
    };
    const clockify = createRestWorkspaceClient({
      baseUrl: "https://api.clockify.me/api/v1",
      workspaceId: "workspace",
      auth: { apiKey: "test" },
      fetchImpl: fetchImpl as typeof fetch,
      testOnlyEnforceMutationScope: true,
    });

    const result = await executeAction({
      actionName: "clockify_tags_create",
      args: { name: "Boundary" },
      context: {
        workspaceId: "workspace",
        adminUserId: "admin",
        policy: defaultAdminPolicy(),
        clockify,
        operationJournal: {
          prepare(actionName, operation, mutationPlan) {
            operationId = store.prepareOperationRun({
              id: "safe-tag-dispatch-boundary",
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

    expect(result).toMatchObject({ kind: "receipt", receipt: { ok: true } });
    expect(store.listOperationSteps(operationId)[0]).toMatchObject({
      status: "succeeded",
      dispatchedAt: expect.any(String),
    });
    store.close();
  });

  it("settles an incomplete successful host plan as a definitive failure", async () => {
    const store = createStore(":memory:");
    const fake = createFakeWorkspace();
    const action = getAction("clockify_clients_create")!;
    const originalExecute = action.executeSafeWrite;
    let operationId = "";
    action.executeSafeWrite = async (ctx, prepared) => {
      const payload = prepared.operation as { base: { name: string } };
      const journal = ctx.mutationJournal!;
      await executeStep({
        journal,
        operationId: journal.operationId,
        step: { id: "create-client", index: 0, name: "Create client", kind: "primary" },
        dispatch: async () => {
          const created = await ctx.clockify.createClientBaseAtomic(payload.base);
          return { externalId: created.id };
        },
      });
      return successReceipt({ action: action.name, entity: "client" });
    };

    try {
      const result = await executeAction({
        actionName: action.name,
        args: { name: "Prefix only", ccEmails: ["admin@example.test"] },
        context: {
          workspaceId: "workspace",
          adminUserId: "admin",
          policy: defaultAdminPolicy(),
          clockify: fake.client,
          operationJournal: {
            prepare(actionName, operation, mutationPlan) {
              operationId = store.prepareOperationRun({
                id: "safe-client-incomplete-plan",
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

      expect(fake.counts.createClientBaseAtomic).toBe(1);
      expect(fake.counts.enrichClientAtomic ?? 0).toBe(0);
      expect(result).toMatchObject({
        kind: "receipt",
        receipt: { ok: false, code: "execution_error", message: "mutation_plan_incomplete:enrich-client" },
      });
      expect(store.getOperationRun(operationId)?.status).toBe("definitive_failed");
    } finally {
      action.executeSafeWrite = originalExecute;
      store.close();
    }
  });

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

  it("preserves a known host success when primary step settlement stays unavailable", async () => {
    const store = createStore(":memory:");
    const fake = createFakeWorkspace();
    let operationId = "";

    const result = await executeAction({
      actionName: "clockify_tags_create",
      args: { name: "Settlement degraded" },
      context: {
        workspaceId: "workspace",
        adminUserId: "admin",
        policy: defaultAdminPolicy(),
        clockify: fake.client,
        operationJournal: {
          prepare(actionName, operation, mutationPlan) {
            operationId = store.prepareOperationRun({
              id: "safe-tag-settlement-degraded",
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
            return {
              ...store.mutationStepJournal(id),
              settleOperationStep() {
                throw new Error("persistent_step_settlement_failure");
              },
            };
          },
          settle(id, status, settledResult) {
            store.settleOperationResult(id, status, settledResult);
          },
        },
      },
    });

    expect(fake.counts.createTag).toBe(1);
    expect(result).toMatchObject({
      kind: "receipt",
      receipt: {
        ok: true,
        warnings: [{ code: "operation_journal_degraded" }],
      },
    });
    expect(store.getOperationRun(operationId)?.status).toBe("succeeded");
    expect(store.listOperationSteps(operationId)).toMatchObject([
      {
        planStepId: "create-tag",
        status: "succeeded",
        detail: { journalDegraded: true },
      },
    ]);
    store.close();
  });

});
