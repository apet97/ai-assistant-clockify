import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { testing } from "@apet97/clockify-addon-sdk";
import { testKeys } from "../helpers/test-keys.js";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { makeTestConfig } from "../helpers/config.js";
import type { ToolCompletion } from "../../src/assistant/model-client.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import { scriptedToolModel } from "../helpers/scripted-model.js";
import { getAction } from "../../src/harness/catalog.js";
import {
  executeMutationWorkflow,
  type MutationStepJournal,
} from "../../src/harness/mutation-workflow.js";
import type { ActionContext } from "../../src/harness/action.js";
import { errorReceipt, successReceipt } from "../../src/harness/receipts.js";

/**
 * Post-host bookkeeping must preserve the truthful receipt. Canonical
 * confirmation settlement is retried synchronously and owns idempotency
 * completion; audit and undo enrichment remain best-effort after that durable
 * safety transition.
 *
 * To inject the throw without a test-only hook in `src/`, we wrap the real store
 * passed into `createApp`'s deps and override the one bookkeeping method
 * (`createStore` returns an object literal of closures, so spreading keeps every
 * other method's binding intact). A pure risky-write preview (no read executed
 * before the interrupt) never audits during the chat turn, so the wrapped method
 * throws ONLY at confirm time.
 */
const ADDON_KEY = "ai-assistant";

let stores: Store[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of stores) s.close();
  stores = [];
});

interface TestApp {
  app: Express;
  cookie: string;
  store: Store;
}

async function makeApp(
  script: ToolCompletion[],
  fake: FakeWorkspace,
  wrapStore: (store: Store) => Store = (s) => s,
): Promise<TestApp> {
  const keys = await testKeys();
  const config = makeTestConfig({
    clockifyAddonPublicKeyPem: keys.pem,
    clockifyAddonKey: ADDON_KEY,
  });
  const store = createStore(":memory:", { encryptionKey: "test-key" });
  stores.push(store);
  store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
  const parser = createSignatureParser(ADDON_KEY, keys.pem);
  const app = createApp({
    config,
    store: wrapStore(store),
    parser,
    modelClient: scriptedToolModel(script),
    clockifyForWorkspace: () => fake.client,
  });
  const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
    workspaceId: "ws-1",
    user: "admin-1",
    workspaceRole: "ADMIN",
    addonId: "addon-1",
  });
  const res = await request(app).get("/component/assistant").query({ auth_token: token });
  const setCookie = res.headers["set-cookie"];
  const cookie = Array.isArray(setCookie) ? setCookie[0].split(";")[0] : "";
  return { app, cookie, store };
}

type ResultItem = { kind: string; previewId?: string; nonce?: string };

function previewsOf(results: ResultItem[]): ResultItem[] {
  return results.filter((r) => r.kind === "preview");
}

const DELETE_TAG: ToolCompletion = {
  text: "Deleting the tag now.",
  toolCalls: [{ id: "r1", name: "clockify_tags_delete", arguments: { name: "urgent" } }],
};

// A reversible RISKY create (an invoice — `invoice` is a REVERSIBLE_ENTITY_GROUP
// type). Unlike a delete, a successful invoice commit reaches the THIRD post-commit
// write, `recordUndoIfReversible` -> `store.recordUndoable`, to mint an undo handle.
const CREATE_INVOICE: ToolCompletion = {
  text: "Creating the invoice now.",
  toolCalls: [{ id: "r1", name: "clockify_invoices_create", arguments: { clientName: "Acme" } }],
};

const CREATE_MULTI_STEP_INVOICE: ToolCompletion = {
  text: "Preparing the invoice.",
  toolCalls: [{
    id: "invoice-multi",
    name: "clockify_invoices_create",
    arguments: {
      clientName: "Acme",
      number: "INV-ROUTE-1",
      note: "Route proof",
      items: [{ itemType: "TIME", description: "Consulting", quantity: 2, amount: 25 }],
    },
  }],
};

describe("post-commit bookkeeping is best-effort (a DB hiccup can't drop a committed receipt)", () => {
  it("runs a multi-step invoice plan through the real confirmation claim and cannot redispatch it", async () => {
    const fake = createFakeWorkspace({
      clients: [{ id: "c1", name: "Acme" }],
      invoices: [{
        id: "template",
        number: "OLD",
        clientId: "c1",
        currency: "USD",
        status: "UNSENT",
        items: [{ order: 0, itemType: "TIME", description: "Old", quantity: 1, unitPrice: 100 }],
      }],
    });
    const { app, cookie, store } = await makeApp([CREATE_MULTI_STEP_INVOICE], fake);
    const observed: string[] = [];
    const originalCreate = fake.client.createInvoiceBase;
    const originalUpdate = fake.client.updateInvoiceFields;
    const originalAdd = fake.client.addInvoiceItemAtomic;
    let operationId: string | undefined;
    fake.client.createInvoiceBase = async (...args) => {
      const steps = store.listOperationSteps(operationId!);
      expect(steps.at(-1)?.detail).toMatchObject({
        preDispatch: { strategy: "invoice_create_baseline", ids: ["template"], truncated: false },
      });
      observed.push(`${steps.at(-1)?.planStepId}:${steps.at(-1)?.status}`);
      return originalCreate(...args);
    };
    fake.client.updateInvoiceFields = async (...args) => {
      const steps = store.listOperationSteps(operationId!);
      observed.push(`${steps.at(-1)?.planStepId}:${steps.at(-1)?.status}`);
      return originalUpdate(...args);
    };
    fake.client.addInvoiceItemAtomic = async (...args) => {
      const steps = store.listOperationSteps(operationId!);
      observed.push(`${steps.at(-1)?.planStepId}:${steps.at(-1)?.status}`);
      return originalAdd(...args);
    };

    const requestId = "836ba965-f0e3-4822-9ccd-e1bb059bd440";
    const chat = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "Create the route-proof invoice", requestId });
    expect(chat.status).toBe(200);
    const preview = previewsOf(chat.body.results as ResultItem[])[0]!;
    const pending = store.getPendingConfirmation(preview.previewId!);
    expect(pending).toBeDefined();
    operationId = pending!.operationId;
    const expectedPlan = {
      mode: "curated",
      steps: [
        { id: "create-invoice", kind: "primary" },
        { id: "enrich-invoice", kind: "primary" },
        { id: "add-invoice-item-0", kind: "primary" },
      ],
    };
    expect(pending!.operation).toMatchObject({
      operationId,
      mutationPlan: expectedPlan,
    });
    expect(store.getOperationRun(operationId)).toMatchObject({
      id: operationId,
      status: "prepared",
      operation: { operationId },
      mutationPlan: expectedPlan,
    });

    const confirm = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });

    expect(confirm.status).toBe(200);
    expect(confirm.body.receipt).toMatchObject({ ok: true, action: "clockify_invoices_create" });
    expect(observed).toEqual([
      "create-invoice:executing",
      "enrich-invoice:executing",
      "add-invoice-item-0:executing",
    ]);
    expect(store.listOperationSteps(operationId).map((step) => [step.planStepId, step.status]))
      .toEqual([
        ["create-invoice", "succeeded"],
        ["enrich-invoice", "succeeded"],
        ["add-invoice-item-0", "succeeded"],
      ]);
    const run = store.getOperationRun(operationId);
    expect(run).toMatchObject({ status: "succeeded", actionResultId: expect.any(String) });
    expect(store.getActionResult(run!.actionResultId!)).toMatchObject({
      kind: "receipt",
      receipt: { ok: true, action: "clockify_invoices_create" },
    });
    expect(fake.counts).toMatchObject({
      createInvoiceBase: 1,
      updateInvoiceFields: 1,
      addInvoiceItemAtomic: 1,
    });

    const duplicateConfirm = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });
    const duplicateRequest = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "Create the route-proof invoice", requestId });

    expect(duplicateConfirm.status).toBe(400);
    expect(duplicateRequest.status).toBe(200);
    expect(fake.counts).toMatchObject({
      createInvoiceBase: 1,
      updateInvoiceFields: 1,
      addInvoiceItemAtomic: 1,
    });
  });

  it("gives the one-use confirmation winner a scoped journal and dispatches one durable planned step", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const action = getAction("clockify_tags_delete")!;
    const originalHandler = action.handler;
    vi.spyOn(action, "handler").mockImplementation(async (ctx, args) => {
      const result = await originalHandler(ctx, args);
      return result.kind === "preview"
        ? {
            ...result,
            operation: {
              ...result.operation,
              mutationPlan: {
                mode: "single" as const,
                steps: [{ id: "delete-tag", kind: "primary" as const }],
              },
            },
          }
        : result;
    });
    let operationIdAtDispatch: string | undefined;
    const observed: string[] = [];
    type ExpectedScopedJournal = MutationStepJournal & {
      operationId: string;
      getOperationStatus(): string | undefined;
      listOperationSteps(): ReturnType<Store["listOperationSteps"]>;
    };
    vi.spyOn(action, "commit").mockImplementation(async (ctx, operation) => {
      const journal = (ctx as ActionContext & { mutationJournal?: ExpectedScopedJournal }).mutationJournal;
      if (!journal) throw new Error("missing_scoped_mutation_journal");
      expect(journal.operationId).toBe(operation.operationId);
      return executeMutationWorkflow({
        journal,
        operationId: operation.operationId,
        actionName: operation.actionName,
        steps: [{
          id: "delete-tag",
          index: 0,
          name: "Delete tag",
          kind: "primary",
          dispatch: async () => {
            operationIdAtDispatch = operation.operationId;
            observed.push(`operation:${journal.getOperationStatus()}`);
            observed.push(`step:${journal.listOperationSteps()[0]?.status ?? "missing"}`);
            await ctx.clockify.deleteTag(operation.payload.id as string);
            return { externalId: operation.payload.id as string, effect: { deleted: operation.payload.id } };
          },
        }],
        onSuccess: () => successReceipt({ action: operation.actionName }),
        onPartial: () => {
          throw new Error("single step cannot be partial");
        },
        onJournalDegraded: (completed) => ({
          kind: "partial",
          receipt: successReceipt({
            action: operation.actionName,
            warnings: [{
              code: "operation_journal_degraded",
              message: "Clockify confirmed the step, but its full local journal record is degraded.",
            }],
            changed: completed[0]?.externalId
              ? { deleted: [{ type: "tag", id: completed[0].externalId }] }
              : undefined,
          }),
          message: "Clockify confirmed the step; no later step was dispatched.",
          recovery: { hint: "Verify the known external effect before a fresh operation.", retryable: false },
        }),
        onFailure: () => errorReceipt({ action: operation.actionName, code: "delete_failed", message: "Delete failed." }),
      });
    });

    const { app, cookie, store } = await makeApp([DELETE_TAG], fake);
    const chat = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the urgent tag" });
    const preview = previewsOf(chat.body.results as ResultItem[])[0]!;
    const pending = store.getPendingConfirmation(preview.previewId!);
    expect(pending).toBeDefined();

    const confirm = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });
    const replay = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });

    expect(confirm.status).toBe(200);
    expect(replay.status).toBe(400);
    expect(operationIdAtDispatch).toBe(pending!.operationId);
    expect(observed).toEqual(["operation:executing", "step:executing"]);
    expect(fake.counts.deleteTag).toBe(1);
    expect(store.getOperationRun(pending!.operationId)).toMatchObject({ status: "succeeded" });
    expect(store.listOperationSteps(pending!.operationId)).toMatchObject([
      {
        planStepId: "delete-tag",
        kind: "primary",
        status: "succeeded",
        externalId: "t1",
        effect: { deleted: "t1" },
      },
    ]);
  });

  it("addAuditEvent throwing at confirm does NOT 500: the receipt returns and the commit ran exactly once", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, cookie } = await makeApp([DELETE_TAG], fake, (store) => ({
      ...store,
      addAuditEvent: () => {
        throw new Error("db busy");
      },
    }));

    const chat = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the urgent tag" });
    expect(chat.status).toBe(200);
    const preview = previewsOf(chat.body.results as ResultItem[])[0];
    expect(preview).toBeDefined();
    expect(fake.counts.deleteTag ?? 0).toBe(0);

    const confirm = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });

    // The bookkeeping write threw AFTER the commit. The confirm must still be a
    // 200 carrying the committed receipt — not a 500 that swallows it.
    expect(confirm.status).toBe(200);
    expect(confirm.body.receipt.ok).toBe(true);
    expect(confirm.body.receipt.action).toBe("clockify_tags_delete");
    // The commit happened exactly once on the underlying host.
    expect(fake.counts.deleteTag).toBe(1);
    expect(fake.state.tags.find((t) => t.id === "t1")).toBeUndefined();
  });

  it("retries a transient canonical confirmation settlement and scrubs the consumed operation", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    let settlementAttempts = 0;
    const { app, cookie, store } = await makeApp([DELETE_TAG], fake, (underlying) => ({
      ...underlying,
      settleConfirmedOperation: (...args: Parameters<Store["settleConfirmedOperation"]>) => {
        settlementAttempts += 1;
        if (settlementAttempts === 1) throw new Error("db busy");
        return underlying.settleConfirmedOperation(...args);
      },
    }));

    const chat = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the urgent tag" });
    expect(chat.status).toBe(200);
    const preview = previewsOf(chat.body.results as ResultItem[])[0];
    expect(preview).toBeDefined();

    const confirm = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });

    expect(confirm.status).toBe(200);
    expect(confirm.body.receipt.ok).toBe(true);
    expect(fake.counts.deleteTag).toBe(1);
    expect(settlementAttempts).toBe(2);
    expect(store.getPendingConfirmation(preview.previewId!)).toMatchObject({
      status: "succeeded",
      nonceHash: "",
      operation: {},
      agentState: undefined,
      actionResultId: expect.any(String),
    });
  });

  it("pre-scrubs a persistent settlement failure behind exactly one durable unknown result identity", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    let settlementAttempts = 0;
    const { app, cookie, store } = await makeApp([DELETE_TAG], fake, (underlying) => ({
      ...underlying,
      settleConfirmedOperation: () => {
        settlementAttempts += 1;
        throw new Error("db unavailable");
      },
    }));
    const chat = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the urgent tag" });
    const preview = previewsOf(chat.body.results as ResultItem[])[0];

    const confirm = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });

    expect(confirm.status).toBe(200);
    expect(confirm.body).toMatchObject({
      ok: true,
      persistenceDegraded: true,
      receipt: { ok: true, action: "clockify_tags_delete" },
    });
    expect(settlementAttempts).toBe(2);
    expect(fake.counts.deleteTag).toBe(1);
    const degraded = store.getPendingConfirmation(preview.previewId!);
    expect(degraded).toMatchObject({
      status: "executing",
      nonceHash: "",
      operation: {},
      agentState: undefined,
      actionResultId: expect.any(String),
    });
    const durableId = degraded!.actionResultId!;
    expect(store.getActionResult(durableId)).toMatchObject({
      kind: "receipt",
      receipt: { ok: false, action: "clockify_tags_delete", code: "commit_outcome_unknown" },
    });
    expect(store.getOperationRun(degraded!.operationId)).toMatchObject({
      status: "executing",
      actionResultId: durableId,
    });

    store.recoverOrphanedRuns();
    expect(store.getPendingConfirmation(preview.previewId!)).toMatchObject({
      status: "outcome_unknown",
      nonceHash: "",
      operation: {},
      agentState: undefined,
      actionResultId: durableId,
    });
    expect(store.getOperationRun(degraded!.operationId)).toMatchObject({
      status: "outcome_unknown",
      actionResultId: durableId,
    });
  });

  it("recordUndoIfReversible (the 3rd write) throwing at confirm does NOT 500: the committed receipt returns and the commit ran exactly once", async () => {
    // The first two writes are covered above; this pins the THIRD post-commit
    // bookkeeping write. `recordUndoIfReversible` calls `store.recordUndoable`,
    // which is reached ONLY by a successful REVERSIBLE create — so we drive a
    // risky invoice create (not a delete) through preview -> confirm and wrap
    // the store so `recordUndoable` throws once at confirm time. The invoice has
    // ALREADY committed by then, so the throw must NOT 500 / drop the receipt.
    const fake = createFakeWorkspace({ clients: [{ id: "c1", name: "Acme" }] });
    let undoableThrows = 0;
    const { app, cookie } = await makeApp([CREATE_INVOICE], fake, (store) => ({
      ...store,
      recordUndoable: () => {
        undoableThrows += 1;
        throw new Error("db busy");
      },
    }));

    const chat = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "create an invoice for Acme" });
    expect(chat.status).toBe(200);
    const preview = previewsOf(chat.body.results as ResultItem[])[0];
    expect(preview).toBeDefined();
    // Nothing committed at preview time.
    expect(fake.counts.createInvoice ?? 0).toBe(0);

    const confirm = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });

    // The undo-bookkeeping write threw AFTER the commit. The confirm must still
    // be a 200 carrying the committed receipt — not a 500 that swallows it.
    expect(confirm.status).toBe(200);
    expect(confirm.body.receipt.ok).toBe(true);
    expect(confirm.body.receipt.action).toBe("clockify_invoices_create");
    // The throwing path WAS exercised (sanity: the 3rd write actually ran), and
    // the commit happened exactly once on the underlying host.
    expect(undoableThrows).toBe(1);
    expect(fake.counts.createInvoiceBase).toBe(1);
  });

  it("binds the idempotency claim during canonical confirmation settlement without a separate fill write", async () => {
    // A risky idempotent create claims before host dispatch. The confirmation
    // settlement must fill that claim in the same transaction as its canonical
    // result; the legacy standalone fill seam must not run afterward.
    const fake = createFakeWorkspace({ clients: [{ id: "c1", name: "Acme" }] });
    let fillThrows = 0;
    let claimedKey: string | undefined;
    const { app, cookie, store } = await makeApp([CREATE_INVOICE], fake, (underlying) => ({
      ...underlying,
      claimIdempotency: (...args: Parameters<Store["claimIdempotency"]>) => {
        claimedKey = args[0];
        return underlying.claimIdempotency(...args);
      },
      fillIdempotency: () => {
        fillThrows += 1;
        throw new Error("db busy");
      },
    }));

    const chat = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "create an invoice for Acme" });
    expect(chat.status).toBe(200);
    const preview = previewsOf(chat.body.results as ResultItem[])[0];
    expect(preview).toBeDefined();
    expect(fake.counts.createInvoice ?? 0).toBe(0);

    const confirm = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });

    expect(confirm.status).toBe(200);
    expect(confirm.body.receipt.ok).toBe(true);
    expect(confirm.body.receipt.action).toBe("clockify_invoices_create");
    // Settlement owns the ledger binding in its transaction; the old, separate
    // post-commit fill seam is never called and cannot strand a live claim.
    expect(fillThrows).toBe(0);
    expect(claimedKey).toBeDefined();
    expect(store.claimIdempotency(claimedKey!, "ws-1", "admin-1", Date.now(), 0, 0)).toBe("replay");
    expect(store.claimIdempotencyReceipt(claimedKey!, "ws-1", "admin-1")).toMatchObject({
      ok: true,
      action: "clockify_invoices_create",
    });
    expect(fake.counts.createInvoiceBase).toBe(1);
  });
});
