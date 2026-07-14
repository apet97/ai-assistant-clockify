import { describe, expect, it } from "vitest";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import type { ActionContext } from "../../src/harness/action.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";

const NOW = new Date("2026-06-06T00:00:00.000Z");

function context(fake: FakeWorkspace): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy: defaultAdminPolicy(),
    clockify: fake.client,
    now: () => NOW,
  };
}

function invoiceSeed() {
  return {
    clients: [{ id: "c1", name: "Acme" }],
    invoices: [{
      id: "inv1",
      number: "INV-1",
      clientId: "c1",
      currency: "USD",
      status: "UNSENT",
      items: [{
        order: 0,
        description: "Consulting",
        quantity: 1,
        unitPrice: 10000,
        amount: 10000,
        itemType: "TIME",
        applyTaxes: "TAX1",
        taxAmount: 300,
      }],
    }],
  };
}

describe("invoice durable operation contracts", () => {
  it("stores one operation identity, exact ordered plan, and stable provenance", async () => {
    const fake = createFakeWorkspace(invoiceSeed() as any);
    const result = await executeAction({
      actionName: "clockify_invoices_create",
      args: {
        clientName: "Acme",
        number: "INV-EXPLICIT",
        note: "Thanks",
        taxPercent: 3,
        items: [{ description: "Consulting", quantity: 2, amount: 25 }],
      },
      context: context(fake),
    });
    if (result.kind !== "preview") throw new Error("expected preview");

    expect(result.operation.payload).not.toHaveProperty("operationId");
    expect(result.operation.mutationPlan).toEqual({
      mode: "curated",
      steps: [
        { id: "create-invoice", kind: "primary" },
        { id: "enrich-invoice", kind: "primary", reconciliationStrategy: "update" },
        { id: "add-invoice-item-0", kind: "primary", reconciliationStrategy: "update" },
      ],
    });
    expect(result.operation.payload).toMatchObject({
      provenance: {
        number: "explicit",
        issuedDate: "generated",
        dueDate: "generated",
        currency: "generated",
        note: "explicit",
        subject: "generated",
        taxPercent: "explicit",
        tax2Percent: "generated",
        discountPercent: "generated",
        items: [{
          description: "explicit",
          quantity: "explicit",
          amount: "explicit",
          amountUnit: "generated",
          itemType: "generated",
          applyTaxes: "generated",
        }],
      },
    });
  });

  it("captures the complete ordered raw item array before delete", async () => {
    const fake = createFakeWorkspace(invoiceSeed() as any);
    const result = await executeAction({
      actionName: "clockify_invoices_items_delete",
      args: { invoiceId: "inv1", index: 0 },
      context: context(fake),
    });
    if (result.kind !== "preview") throw new Error("expected preview");

    expect(result.operation.payload).toMatchObject({
      rawItems: [{ applyTaxes: "TAX1", taxAmount: 300 }],
      rawItemsFingerprint: expect.any(String),
    });
  });

  it("rejects item deletion when raw item order or tax fields drift", async () => {
    for (const mutate of [
      (fake: FakeWorkspace) => fake.state.invoices[0]!.items.reverse(),
      (fake: FakeWorkspace) => { fake.state.invoices[0]!.items[0]!.taxAmount = 301; },
    ]) {
      const seeded = invoiceSeed();
      seeded.invoices[0]!.items.push({
        order: 1,
        description: "Second",
        quantity: 1,
        unitPrice: 2000,
        amount: 2000,
        itemType: "TIME",
        applyTaxes: "NONE",
        taxAmount: 0,
      });
      const fake = createFakeWorkspace(seeded as any);
      const result = await executeAction({
        actionName: "clockify_invoices_items_delete",
        args: { invoiceId: "inv1", index: 0 },
        context: context(fake),
      });
      if (result.kind !== "preview") throw new Error("expected preview");
      mutate(fake);

      const receipt = await commitConfirmedOperation(context(fake), result.operation);

      expect(receipt).toMatchObject({ ok: false, code: "stale_target" });
      expect(fake.counts.deleteInvoiceItemAtomic ?? 0).toBe(0);
    }
  });

  it("stores a complete payment baseline and exact target snapshot before payment writes", async () => {
    const fake = createFakeWorkspace(invoiceSeed() as any);
    fake.state.invoicePayments.inv1 = [{
      id: "pay-existing",
      amount: 1000,
      paymentDate: "2026-06-01T00:00:00Z",
      note: "old",
    }];
    const create = await executeAction({
      actionName: "clockify_invoices_payments_create",
      args: { invoiceId: "inv1", amount: 50, paymentDate: "2026-06-06", note: "deposit" },
      context: context(fake),
    });
    if (create.kind !== "preview") throw new Error("expected payment preview");
    expect(create.operation.payload).toMatchObject({
      paymentBaseline: { ids: ["pay-existing"], truncated: false },
    });

    const del = await executeAction({
      actionName: "clockify_invoices_payments_delete",
      args: { invoiceId: "inv1", paymentId: "pay-existing" },
      context: context(fake),
    });
    if (del.kind !== "preview") throw new Error("expected delete preview");
    expect(del.operation.payload).toMatchObject({
      paymentSnapshot: {
        id: "pay-existing",
        amount: 1000,
        paymentDate: "2026-06-01T00:00:00Z",
        note: "old",
      },
      paymentListTruncated: false,
    });
  });

  it("rejects payment deletion when amount/date/note drift after preview", async () => {
    const fake = createFakeWorkspace(invoiceSeed() as any);
    fake.state.invoicePayments.inv1 = [{
      id: "pay-1",
      amount: 1000,
      paymentDate: "2026-06-01T00:00:00Z",
      note: "old",
    }];
    const preview = await executeAction({
      actionName: "clockify_invoices_payments_delete",
      args: { invoiceId: "inv1", paymentId: "pay-1" },
      context: context(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected preview");
    fake.state.invoicePayments.inv1[0]!.note = "changed";

    const receipt = await commitConfirmedOperation(context(fake), preview.operation);
    expect(receipt).toMatchObject({ ok: false, code: "stale_target" });
    expect(fake.counts.deleteInvoicePayment ?? 0).toBe(0);
  });

  it.each(["missing", "duplicate", "truncated"] as const)(
    "rejects payment deletion when the commit-time target evidence is %s",
    async (condition) => {
      const fake = createFakeWorkspace(invoiceSeed() as any);
      fake.state.invoicePayments.inv1 = [{
        id: "pay-1",
        amount: 1000,
        paymentDate: "2026-06-01T00:00:00Z",
        note: "old",
      }];
      const preview = await executeAction({
        actionName: "clockify_invoices_payments_delete",
        args: { invoiceId: "inv1", paymentId: "pay-1" },
        context: context(fake),
      });
      if (preview.kind !== "preview") throw new Error("expected preview");
      if (condition === "missing") fake.state.invoicePayments.inv1 = [];
      if (condition === "duplicate") {
        fake.state.invoicePayments.inv1.push({ ...fake.state.invoicePayments.inv1[0]! });
      }
      if (condition === "truncated") {
        const listPayments = fake.client.listInvoicePayments;
        fake.client.listInvoicePayments = async (...args) => ({
          ...(await listPayments(...args)),
          truncated: true,
        });
      }

      const receipt = await commitConfirmedOperation(context(fake), preview.operation);

      expect(receipt).toMatchObject({ ok: false, code: "stale_target" });
      expect(fake.counts.deleteInvoicePaymentAtomic ?? 0).toBe(0);
    },
  );
});
