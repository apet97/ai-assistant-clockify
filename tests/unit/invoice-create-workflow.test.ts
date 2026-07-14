import { describe, expect, it } from "vitest";
import { createStore } from "../../src/db/store.js";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { actionFingerprint, catalogHash } from "../../src/harness/catalog.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import type { ActionContext, ConfirmableOperation, IdempotencyLedger } from "../../src/harness/action.js";
import type { SuccessReceipt } from "../../src/harness/receipts.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import { AmbiguousWriteOutcome, DefinitiveWriteFailure } from "../../src/clockify/write-outcome.js";

const NOW = new Date("2026-06-06T00:00:00.000Z");

function seed() {
  return {
    clients: [{ id: "c1", name: "Acme" }],
    invoices: [{
      id: "template-invoice",
      number: "OLD",
      clientId: "c1",
      currency: "USD",
      issuedDate: "2026-01-01T00:00:00.000Z",
      dueDate: "2026-01-31T00:00:00.000Z",
      status: "UNSENT",
      items: [{ order: 0, itemType: "TIME", description: "Old", quantity: 1, unitPrice: 100 }],
    }],
  };
}

function baseContext(fake: FakeWorkspace): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy: defaultAdminPolicy(),
    clockify: fake.client,
    now: () => NOW,
  };
}

async function preview(fake: FakeWorkspace, items = 1): Promise<ConfirmableOperation> {
  const result = await executeAction({
    actionName: "clockify_invoices_create",
    args: {
      clientName: "Acme",
      number: "INV-NEW",
      note: "Thanks",
      taxPercent: 3,
      items: Array.from({ length: items }, (_, index) => ({
        description: `Line ${index + 1}`,
        quantity: 1,
        amount: 25,
        itemType: "TIME",
      })),
    },
    context: baseContext(fake),
  });
  if (result.kind !== "preview") throw new Error(`expected preview, got ${result.kind}`);
  return result.operation;
}

async function previewBaseOnly(fake: FakeWorkspace): Promise<ConfirmableOperation> {
  const result = await executeAction({
    actionName: "clockify_invoices_create",
    args: { clientName: "Acme", number: "INV-BASE-ONLY" },
    context: baseContext(fake),
  });
  if (result.kind !== "preview") throw new Error(`expected preview, got ${result.kind}`);
  return result.operation;
}

function durableContext(fake: FakeWorkspace, operation: ConfirmableOperation) {
  const store = createStore(":memory:");
  store.prepareOperationRun({
    id: operation.operationId,
    sessionId: "session-1",
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    actionName: operation.actionName,
    actionFingerprint: actionFingerprint(operation.actionName)!,
    catalogHash: catalogHash(),
    operationHash: "hash",
    operation,
    mutationPlan: operation.mutationPlan,
  });
  store.markOperationExecuting(operation.operationId);
  return {
    store,
    context: {
      ...baseContext(fake),
      mutationJournal: store.mutationStepJournal(operation.operationId),
    },
  };
}

describe("durable invoice creation", () => {
  it("never claims a concurrent same-base/different-final invoice for a composite create", async () => {
    const fake = createFakeWorkspace(seed() as any);
    fake.client.createInvoiceBase = async (base) => {
      fake.state.invoices.push({
        id: "concurrent-different-final",
        number: base.number,
        clientId: base.clientId,
        currency: base.currency,
        issuedDate: base.issuedDate,
        dueDate: base.dueDate,
        note: "Someone else's invoice",
        status: "UNSENT",
        items: [{ order: 0, itemType: "TIME", description: "Other", quantity: 1, unitPrice: 999 }],
      });
      throw new AmbiguousWriteOutcome("POST", "/invoices", "proxy returned 502", 502);
    };
    const operation = await preview(fake);
    const { store, context } = durableContext(fake, operation);

    const result = await commitConfirmedOperation(context, operation);

    expect(result).toMatchObject({ ok: false, code: "commit_outcome_unknown" });
    expect(fake.counts.updateInvoiceFields ?? 0).toBe(0);
    expect(fake.counts.addInvoiceItemAtomic ?? 0).toBe(0);
    expect(store.listOperationSteps(operation.operationId)).toMatchObject([{ status: "outcome_unknown" }]);
    store.close();
  });

  it("persists ordered one-dispatch steps and never calls composite wrappers", async () => {
    const fake = createFakeWorkspace(seed() as any);
    const operation = await preview(fake);
    const { store, context } = durableContext(fake, operation);

    const result = await commitConfirmedOperation(context, operation);
    expect(result).toMatchObject({ ok: true, changed: { created: [{ type: "invoice" }] } });
    expect(store.listOperationSteps(operation.operationId).map((step) => [step.planStepId, step.status]))
      .toEqual([
        ["create-invoice", "succeeded"],
        ["enrich-invoice", "succeeded"],
        ["add-invoice-item-0", "succeeded"],
      ]);
    expect(fake.counts).toMatchObject({
      createInvoiceBase: 1,
      updateInvoiceFields: 1,
      addInvoiceItemAtomic: 1,
    });
    expect(fake.counts.createInvoice ?? 0).toBe(0);
    expect(fake.counts.updateInvoice ?? 0).toBe(0);
    expect(fake.counts.addInvoiceItem ?? 0).toBe(0);
    store.close();
  });

  it("reconciles an apply-before-throw base-only POST and terminalizes its step", async () => {
    const fake = createFakeWorkspace({
      ...seed(),
      invoiceFaults: { createInvoiceBase: { outcome: "ambiguous", applyBeforeThrow: true } },
    } as any);
    const operation = await previewBaseOnly(fake);
    const { store, context } = durableContext(fake, operation);

    const result = await commitConfirmedOperation(context, operation);
    expect(result).toMatchObject({ ok: true });
    expect(store.listOperationSteps(operation.operationId).map((step) => step.status))
      .toEqual(["succeeded"]);
    expect(store.getOperationRun(operation.operationId)?.reconciliation).toMatchObject({ authoritative: true });
    expect(fake.counts.createInvoiceBase).toBe(1);
    store.close();
  });

  it.each([
    { applyBeforeThrow: false, failure: "record" as const },
    { applyBeforeThrow: true, failure: "record" as const },
    { applyBeforeThrow: true, failure: "settle" as const },
  ])(
    "keeps create unknown and nonretryable when reconciliation $failure persistence fails (apply=$applyBeforeThrow)",
    async ({ applyBeforeThrow, failure }) => {
      const fake = createFakeWorkspace({
        ...seed(),
        invoiceFaults: { createInvoiceBase: { outcome: "ambiguous", applyBeforeThrow } },
      } as any);
      const operation = await previewBaseOnly(fake);
      const run = durableContext(fake, operation);
      const journal = run.context.mutationJournal;
      let faultCalls = 0;
      run.context.mutationJournal = {
        ...journal,
        ...(failure === "record"
          ? { recordReconciliation: () => { faultCalls += 1; throw new Error("record unavailable"); } }
          : { settleReconciledStep: () => { faultCalls += 1; throw new Error("settle unavailable"); } }),
      };

      const result = await commitConfirmedOperation(run.context, operation);

      expect(result).toMatchObject({
        ok: false,
        code: "commit_outcome_unknown",
        recovery: { retryable: false },
      });
      expect(run.store.listOperationSteps(operation.operationId)[0]).toMatchObject({
        status: "outcome_unknown",
      });
      expect(fake.counts.updateInvoiceFields ?? 0).toBe(0);
      expect(faultCalls).toBe(1);
      run.store.close();
    },
  );

  it("returns partial after a definitive enrichment failure and does not add items", async () => {
    const fake = createFakeWorkspace({
      ...seed(),
      invoiceFaults: { updateInvoiceFields: { outcome: "definitive" } },
    } as any);
    const operation = await preview(fake);
    const { store, context } = durableContext(fake, operation);
    const result = await commitConfirmedOperation(context, operation);

    expect(result).toMatchObject({
      kind: "partial",
      receipt: { ok: true, changed: { created: [{ type: "invoice" }] } },
      recovery: { retryable: false },
    });
    expect(fake.counts.addInvoiceItemAtomic ?? 0).toBe(0);
    expect(store.listOperationSteps(operation.operationId).map((step) => step.status))
      .toEqual(["succeeded", "definitive_failed"]);
    store.close();
  });

  it("returns partial after item N and preserves the completed item count", async () => {
    const fake = createFakeWorkspace(seed() as any);
    const original = fake.client.addInvoiceItemAtomic;
    let calls = 0;
    fake.client.addInvoiceItemAtomic = async (...args) => {
      calls += 1;
      if (calls === 2) throw new DefinitiveWriteFailure("POST", "/items", "rejected", 400);
      return original(...args);
    };
    const operation = await preview(fake, 2);
    const { store, context } = durableContext(fake, operation);
    const result = await commitConfirmedOperation(context, operation);

    expect(result).toMatchObject({
      kind: "partial",
      receipt: { data: { itemsRequested: 2, itemsAdded: 1 } },
      recovery: { retryable: false },
    });
    expect(calls).toBe(2);
    store.close();
  });

  it("stops before items when enrichment is ambiguous", async () => {
    const fake = createFakeWorkspace({
      ...seed(),
      invoiceFaults: { updateInvoiceFields: { outcome: "ambiguous" } },
    } as any);
    const operation = await preview(fake, 2);
    const { store, context } = durableContext(fake, operation);

    const result = await commitConfirmedOperation(context, operation);

    expect(result).toMatchObject({
      ok: false,
      code: "commit_outcome_unknown",
      recovery: { retryable: false },
    });
    expect(fake.counts.addInvoiceItemAtomic ?? 0).toBe(0);
    expect(store.listOperationSteps(operation.operationId).map((step) => step.status))
      .toEqual(["succeeded", "outcome_unknown"]);
    store.close();
  });

  it("stops after an ambiguous item and never dispatches a later item", async () => {
    const fake = createFakeWorkspace(seed() as any);
    const original = fake.client.addInvoiceItemAtomic;
    let calls = 0;
    fake.client.addInvoiceItemAtomic = async (...args) => {
      calls += 1;
      if (calls === 2) {
        throw new AmbiguousWriteOutcome("POST", "/items", "proxy closed after dispatch", 502);
      }
      return original(...args);
    };
    const operation = await preview(fake, 3);
    const { store, context } = durableContext(fake, operation);

    const result = await commitConfirmedOperation(context, operation);

    expect(result).toMatchObject({ ok: false, code: "commit_outcome_unknown" });
    expect(calls).toBe(2);
    expect(store.listOperationSteps(operation.operationId).map((step) => step.status))
      .toEqual(["succeeded", "succeeded", "succeeded", "outcome_unknown"]);
    store.close();
  });

  it("treats a successful response with no invoice id as ambiguous and reconciles it", async () => {
    const fake = createFakeWorkspace({ ...seed(), omitCreatedInvoiceId: true } as any);
    const operation = await previewBaseOnly(fake);
    const { store, context } = durableContext(fake, operation);

    const result = await commitConfirmedOperation(context, operation);

    expect(result).toMatchObject({ ok: true });
    expect(store.listOperationSteps(operation.operationId)[0]).toMatchObject({
      status: "succeeded",
      detail: { authoritativeReconciliation: true },
    });
    expect(fake.counts.createInvoiceBase).toBe(1);
    store.close();
  });

  it("keeps a create unknown when authoritative reconciliation finds zero matches", async () => {
    const fake = createFakeWorkspace({
      ...seed(),
      invoiceFaults: { createInvoiceBase: { outcome: "ambiguous" } },
    } as any);
    const operation = await previewBaseOnly(fake);
    const { store, context } = durableContext(fake, operation);

    const result = await commitConfirmedOperation(context, operation);

    expect(result).toMatchObject({ ok: false, code: "commit_outcome_unknown" });
    expect(store.listOperationSteps(operation.operationId)).toMatchObject([{ status: "outcome_unknown" }]);
    expect(store.getOperationRun(operation.operationId)?.reconciliation).toMatchObject({
      authoritative: false,
      result: { reason: "non_unique", matchCount: 0 },
    });
    expect(fake.counts.updateInvoiceFields ?? 0).toBe(0);
    store.close();
  });

  it.each([
    { applyBeforeThrow: false, expectedOk: false, expectedStatus: "outcome_unknown" },
    { applyBeforeThrow: true, expectedOk: true, expectedStatus: "succeeded" },
  ])(
    "refreshes and durably binds the create baseline immediately before dispatch (apply=$applyBeforeThrow)",
    async ({ applyBeforeThrow, expectedOk, expectedStatus }) => {
      const fake = createFakeWorkspace({
        ...seed(),
        invoiceFaults: { createInvoiceBase: { outcome: "ambiguous", applyBeforeThrow } },
      } as any);
      const operation = await previewBaseOnly(fake);
      const base = (operation.payload as { base: Record<string, string> }).base;
      fake.state.invoices.push({
        id: "inserted-between-preview-and-confirm",
        number: base.number,
        clientId: base.clientId,
        currency: base.currency,
        issuedDate: base.issuedDate,
        dueDate: base.dueDate,
        status: "UNSENT",
        items: [],
      });
      const { store, context } = durableContext(fake, operation);

      const result = await commitConfirmedOperation(context, operation);

      expect(result.ok).toBe(expectedOk);
      const create = store.listOperationSteps(operation.operationId)[0]!;
      expect(create).toMatchObject({
        status: expectedStatus,
        detail: {
          preDispatch: {
            strategy: "invoice_create_baseline",
            ids: expect.arrayContaining(["inserted-between-preview-and-confirm"]),
          },
        },
      });
      expect(fake.counts.updateInvoiceFields ?? 0).toBe(0);
      store.close();
    },
  );

  it.each(["truncated", "read_failed"] as const)(
    "does not dispatch create when the immediate baseline is %s",
    async (failure) => {
      const fake = createFakeWorkspace(seed() as any);
      const operation = await previewBaseOnly(fake);
      const listInvoices = fake.client.listInvoices;
      fake.client.listInvoices = failure === "truncated"
        ? async (...args) => ({ ...(await listInvoices(...args)), truncated: true })
        : async () => { throw new Error("baseline read failed"); };
      const { store, context } = durableContext(fake, operation);

      const result = await commitConfirmedOperation(context, operation);

      expect(result).toMatchObject({ ok: false, code: "create_baseline_unavailable" });
      expect(fake.counts.createInvoiceBase ?? 0).toBe(0);
      expect(store.listOperationSteps(operation.operationId)).toEqual([]);
      store.close();
    },
  );

  it("keeps a create unknown when authoritative reconciliation finds multiple exact matches", async () => {
    const fake = createFakeWorkspace(seed() as any);
    fake.client.createInvoiceBase = async (base) => {
      for (const id of ["concurrent-1", "concurrent-2"]) {
        fake.state.invoices.push({
          id,
          number: base.number,
          clientId: base.clientId,
          currency: base.currency,
          issuedDate: base.issuedDate,
          dueDate: base.dueDate,
          status: "UNSENT",
          items: [],
        });
      }
      throw new AmbiguousWriteOutcome("POST", "/invoices", "proxy returned 502", 502);
    };
    const operation = await previewBaseOnly(fake);
    const { store, context } = durableContext(fake, operation);

    const result = await commitConfirmedOperation(context, operation);

    expect(result).toMatchObject({ ok: false, code: "commit_outcome_unknown" });
    expect(store.getOperationRun(operation.operationId)?.reconciliation).toMatchObject({
      authoritative: false,
      result: { reason: "non_unique", matchCount: 2 },
    });
    expect(fake.counts.updateInvoiceFields ?? 0).toBe(0);
    store.close();
  });

  it("keeps a create unknown when the post-create invoice list is truncated", async () => {
    const fake = createFakeWorkspace({
      ...seed(),
      invoiceFaults: { createInvoiceBase: { outcome: "ambiguous", applyBeforeThrow: true } },
    } as any);
    const operation = await previewBaseOnly(fake);
    const listInvoices = fake.client.listInvoices;
    let readsAfterPreview = 0;
    fake.client.listInvoices = async (...args) => {
      readsAfterPreview += 1;
      return {
        ...(await listInvoices(...args)),
        truncated: readsAfterPreview > 1,
      };
    };
    const { store, context } = durableContext(fake, operation);

    const result = await commitConfirmedOperation(context, operation);

    expect(result).toMatchObject({ ok: false, code: "commit_outcome_unknown" });
    expect(store.getOperationRun(operation.operationId)?.reconciliation).toMatchObject({
      authoritative: false,
      result: { reason: "post_list_truncated" },
    });
    expect(fake.counts.updateInvoiceFields ?? 0).toBe(0);
    store.close();
  });

  it("does the enrichment preflight read before preparing its mutation step", async () => {
    const fake = createFakeWorkspace(seed() as any);
    fake.client.prepareInvoiceFieldUpdate = async () => {
      throw new Error("preflight unavailable");
    };
    const operation = await preview(fake);
    const { store, context } = durableContext(fake, operation);

    const result = await commitConfirmedOperation(context, operation);

    expect(result).toMatchObject({ kind: "partial" });
    expect(store.listOperationSteps(operation.operationId).map((step) => step.planStepId))
      .toEqual(["create-invoice"]);
    expect(fake.counts.updateInvoiceFields ?? 0).toBe(0);
    expect(fake.counts.addInvoiceItemAtomic ?? 0).toBe(0);
    store.close();
  });

  it("does not dispatch later steps after a definitive base rejection", async () => {
    const fake = createFakeWorkspace({
      ...seed(),
      invoiceFaults: { createInvoiceBase: { outcome: "definitive" } },
    } as any);
    const operation = await preview(fake);
    const { store, context } = durableContext(fake, operation);

    const result = await commitConfirmedOperation(context, operation);

    expect(result).toMatchObject({ ok: false, code: "write_failed" });
    expect(store.listOperationSteps(operation.operationId)).toMatchObject([{ status: "definitive_failed" }]);
    expect(fake.counts.updateInvoiceFields ?? 0).toBe(0);
    expect(fake.counts.addInvoiceItemAtomic ?? 0).toBe(0);
    store.close();
  });

  it("replays one operation without redispatch but permits an independently authored preview", async () => {
    const completed = new Map<string, SuccessReceipt>();
    const ledger: IdempotencyLedger = {
      lookup: (key) => completed.get(key),
      record: (key, receipt) => void completed.set(key, receipt),
    };
    const fake = createFakeWorkspace(seed() as any);
    const first = await preview(fake);
    const firstRun = durableContext(fake, first);
    const firstContext = { ...firstRun.context, idempotency: ledger };

    const applied = await commitConfirmedOperation(firstContext, first);
    const replayed = await commitConfirmedOperation(firstContext, first);

    expect(applied).toMatchObject({ ok: true });
    expect(replayed).toMatchObject({ ok: true, warnings: [{ code: "idempotent_replay" }] });
    expect(fake.counts.createInvoiceBase).toBe(1);
    firstRun.store.close();

    const second = await preview(fake);
    expect(second.operationId).not.toBe(first.operationId);
    const secondRun = durableContext(fake, second);
    const independentlyApplied = await commitConfirmedOperation({
      ...secondRun.context,
      idempotency: ledger,
    }, second);

    expect(independentlyApplied).toMatchObject({ ok: true });
    expect(fake.counts.createInvoiceBase).toBe(2);
    secondRun.store.close();
  });
});
