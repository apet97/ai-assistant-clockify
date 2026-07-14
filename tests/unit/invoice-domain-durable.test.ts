import { describe, expect, it } from "vitest";
import { createStore } from "../../src/db/store.js";
import { executeAction, commitConfirmedOperation } from "../../src/harness/actions.js";
import { actionFingerprint, catalogHash } from "../../src/harness/catalog.js";
import type { ActionContext, ConfirmableOperation } from "../../src/harness/action.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";

function fakeSeed() {
  return {
    clients: [{ id: "c1", name: "Acme" }],
    invoices: [{
      id: "inv1",
      number: "INV-1",
      clientId: "c1",
      currency: "USD",
      status: "UNSENT",
      items: [{ order: 0, description: "Existing", quantity: 1, unitPrice: 1000, itemType: "TIME", applyTaxes: "NONE" }],
    }],
  };
}

function context(fake: FakeWorkspace): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy: defaultAdminPolicy(),
    clockify: fake.client,
    now: () => new Date("2026-06-06T00:00:00.000Z"),
  };
}

async function commitDurably(
  fake: FakeWorkspace,
  actionName: string,
  args: unknown,
): Promise<{ operation: ConfirmableOperation; steps: Array<{ planStepId: string; status: string }> }> {
  const prepared = await prepareDurably(fake, actionName, args);
  const { operation, store } = prepared;
  const receipt = await commitConfirmedOperation(prepared.commitContext, operation);
  expect(receipt).toMatchObject({ ok: true });
  const steps = store.listOperationSteps(operation.operationId).map((step) => ({
    planStepId: step.planStepId,
    status: step.status,
  }));
  store.close();
  return { operation, steps };
}

async function prepareDurably(
  fake: FakeWorkspace,
  actionName: string,
  args: unknown,
) {
  const result = await executeAction({ actionName, args, context: context(fake) });
  if (result.kind !== "preview") throw new Error(`expected ${actionName} preview, got ${result.kind}`);
  const operation = result.operation;
  const store = createStore(":memory:");
  store.prepareOperationRun({
    id: operation.operationId,
    sessionId: "session",
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    actionName,
    actionFingerprint: actionFingerprint(actionName)!,
    catalogHash: catalogHash(),
    operationHash: "hash",
    operation,
    mutationPlan: operation.mutationPlan,
  });
  store.markOperationExecuting(operation.operationId);
  const commitContext = {
    ...context(fake),
    mutationJournal: store.mutationStepJournal(operation.operationId),
  };
  return { operation, store, commitContext };
}

describe("all invoice-domain writes use production durable steps", () => {
  it("journals field PUT and status PATCH separately", async () => {
    const fake = createFakeWorkspace(fakeSeed() as any);
    const { steps } = await commitDurably(fake, "clockify_invoices_update", {
      id: "inv1",
      note: "new",
      status: "SENT",
    });
    expect(steps).toEqual([
      { planStepId: "update-invoice-fields", status: "succeeded" },
      { planStepId: "update-invoice-status", status: "succeeded" },
    ]);
    expect(fake.counts.updateInvoice ?? 0).toBe(0);
    expect(fake.counts.updateInvoiceFields).toBe(1);
    expect(fake.counts.updateInvoiceStatus).toBe(1);
  });

  it("returns partial when fields succeed and the separate status step fails definitively", async () => {
    const fake = createFakeWorkspace({
      ...fakeSeed(),
      invoiceFaults: { updateInvoiceStatus: { outcome: "definitive" } },
    } as any);
    const prepared = await prepareDurably(fake, "clockify_invoices_update", {
      id: "inv1",
      note: "new",
      status: "SENT",
    });

    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);

    expect(result).toMatchObject({ kind: "partial", receipt: { ok: true }, recovery: { retryable: false } });
    expect(prepared.store.listOperationSteps(prepared.operation.operationId).map((step) => [step.planStepId, step.status]))
      .toEqual([
        ["update-invoice-fields", "succeeded"],
        ["update-invoice-status", "definitive_failed"],
      ]);
    expect(fake.counts.updateInvoiceFields).toBe(1);
    expect(fake.counts.updateInvoiceStatus).toBe(1);
    prepared.store.close();
  });

  it("stops before status when the field PUT outcome is ambiguous", async () => {
    const fake = createFakeWorkspace({
      ...fakeSeed(),
      invoiceFaults: { updateInvoiceFields: { outcome: "ambiguous" } },
    } as any);
    const prepared = await prepareDurably(fake, "clockify_invoices_update", {
      id: "inv1",
      note: "new",
      status: "SENT",
    });

    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);

    expect(result).toMatchObject({ ok: false, code: "commit_outcome_unknown", recovery: { retryable: false } });
    expect(prepared.store.listOperationSteps(prepared.operation.operationId).map((step) => [step.planStepId, step.status]))
      .toEqual([["update-invoice-fields", "outcome_unknown"]]);
    expect(fake.counts.updateInvoiceFields).toBe(1);
    expect(fake.counts.updateInvoiceStatus ?? 0).toBe(0);
    prepared.store.close();
  });

  it.each([
    { label: "combined field/status", args: { id: "inv1", note: "new", status: "SENT" }, partial: true },
    { label: "status-only", args: { id: "inv1", status: "SENT" }, partial: false },
  ])("classifies a known-success degraded status settlement for $label", async ({ args, partial }) => {
    const fake = createFakeWorkspace(fakeSeed() as any);
    const prepared = await prepareDurably(fake, "clockify_invoices_update", args);
    const journal = prepared.commitContext.mutationJournal;
    prepared.commitContext.mutationJournal = {
      ...journal,
      settleOperationStep(id, status, detail) {
        const step = journal.listOperationSteps().find((candidate) => candidate.id === id);
        if (step?.planStepId === "update-invoice-status") throw new Error("full status settlement unavailable");
        journal.settleOperationStep(id, status, detail);
      },
    };

    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);

    if (partial) {
      expect(result).toMatchObject({
        kind: "partial",
        receipt: { ok: true, warnings: [{ code: "operation_journal_degraded" }] },
        recovery: { retryable: false },
      });
    } else {
      expect(result).toMatchObject({ ok: true, warnings: [{ code: "operation_journal_degraded" }] });
    }
    expect(prepared.store.listOperationSteps(prepared.operation.operationId).at(-1)).toMatchObject({
      planStepId: "update-invoice-status",
      status: "succeeded",
      detail: { journalDegraded: true },
    });
    prepared.store.close();
  });

  it.each([
    ["clockify_invoices_delete", { id: "inv1" }, "delete-invoice", "deleteInvoiceAtomic"],
    ["clockify_invoices_items_add", { invoiceId: "inv1", itemType: "TIME", unitPrice: 5 }, "add-invoice-item", "addInvoiceItemAtomic"],
    ["clockify_invoices_items_delete", { invoiceId: "inv1", index: 0 }, "delete-invoice-item", "deleteInvoiceItemAtomic"],
    ["clockify_invoices_payments_create", { invoiceId: "inv1", amount: 5, paymentDate: "2026-06-06" }, "record-payment", "createInvoicePaymentAtomic"],
    ["clockify_invoices_import_time", { invoiceId: "inv1", from: "2026-06-01", to: "2026-06-02" }, "import-invoice-time", "importInvoiceTimeAtomic"],
  ] as const)("journals %s as one atomic step", async (action, args, planStep, count) => {
    const fake = createFakeWorkspace(fakeSeed() as any);
    const { steps } = await commitDurably(fake, action, args);
    expect(steps).toEqual([{ planStepId: planStep, status: "succeeded" }]);
    expect(fake.counts[count]).toBe(1);
  });

  it("journals payment deletion after exact snapshot revalidation", async () => {
    const fake = createFakeWorkspace(fakeSeed() as any);
    fake.state.invoicePayments.inv1 = [{ id: "pay1", amount: 500, paymentDate: "2026-06-06", note: "cash" }];
    const { steps } = await commitDurably(fake, "clockify_invoices_payments_delete", {
      invoiceId: "inv1",
      paymentId: "pay1",
    });
    expect(steps).toEqual([{ planStepId: "delete-invoice-payment", status: "succeeded" }]);
    expect(fake.counts.deleteInvoicePaymentAtomic).toBe(1);
  });
});
