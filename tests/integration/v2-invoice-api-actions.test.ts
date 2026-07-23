import { describe, expect, it } from "vitest";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { actionFingerprintForDefinition, getAction } from "../../src/harness/catalog.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import type { ActionContext } from "../../src/harness/action.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";

const NOW = new Date("2026-06-06T00:00:00.000Z");

const NEW_INVOICE_API_ACTIONS = [
  "clockify_invoices_create_base",
  "clockify_invoices_fields_update",
  "clockify_invoices_status_update",
  "clockify_invoices_import_time",
] as const;

const INTERNAL_ONLY_INVOICE_ACTIONS = [
  "clockify_invoices_create",
  "clockify_invoices_update",
  "clockify_invoices_items_list",
] as const;

const READ_INVOICE_API_ACTIONS = [
  "clockify_invoices_list",
  "clockify_invoices_get",
  "clockify_invoices_export",
] as const;

function makeContext(fake: FakeWorkspace): ActionContext {
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
      items: [{ order: 0, description: "Consulting", quantity: 1, unitPrice: 10000, itemType: "TIME", applyTaxes: "NONE" }],
    }],
  };
}

describe("v2 invoice read API actions", () => {
  it("exposes list/get/export on MODEL_API and hides embedded-items convenience read", () => {
    const modelNames = new Set(MODEL_API_ACTION_CATALOG.actions.map((action) => action.name));
    for (const name of READ_INVOICE_API_ACTIONS) {
      expect(modelNames.has(name), name).toBe(true);
      expect(getAction(name)?.apiExposure).toBe("api");
    }
    expect(modelNames.has("clockify_invoices_items_list")).toBe(false);
    expect(getAction("clockify_invoices_items_list")?.apiExposure).not.toBe("api");
  });

  it("get returns embedded line items without a separate items GET", async () => {
    const fake = createFakeWorkspace(invoiceSeed() as any);
    const result = await executeAction({
      actionName: "clockify_invoices_get",
      args: { id: "inv1" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt" && result.receipt.ok && "data" in result.receipt) {
      expect((result.receipt.data as { entity?: { id?: string } }).entity).toMatchObject({ id: "inv1" });
    }
    expect(fake.counts.getInvoice).toBe(1);
  });
});

describe("v2 invoice write API actions", () => {
  it("exposes atomic invoice mutations on MODEL_API and hides v1 composites", () => {
    const modelNames = new Set(MODEL_API_ACTION_CATALOG.actions.map((action) => action.name));
    for (const name of NEW_INVOICE_API_ACTIONS) {
      expect(modelNames.has(name), name).toBe(true);
      expect(getAction(name)?.apiExposure).toBe("api");
    }
    for (const name of INTERNAL_ONLY_INVOICE_ACTIONS) {
      expect(modelNames.has(name), name).toBe(false);
      expect(getAction(name)?.apiExposure).not.toBe("api");
    }
    for (const name of [
      "clockify_invoices_delete",
      "clockify_invoices_items_add",
      "clockify_invoices_items_delete",
      "clockify_invoices_payments_create",
      "clockify_invoices_payments_delete",
      "clockify_invoices_payments_list",
    ]) {
      expect(modelNames.has(name), name).toBe(true);
    }
  });

  it("create_base executes with a single POST and no enrichment PUT", async () => {
    const fake = createFakeWorkspace(invoiceSeed() as any);
    const result = await executeAction({
      actionName: "clockify_invoices_create_base",
      args: { clientName: "Acme", number: "INV-BASE" },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected receipt");
    expect(fake.counts.createInvoiceBase).toBe(1);
    expect(fake.counts.updateInvoiceFields ?? 0).toBe(0);
    expect(fake.counts.addInvoiceItemAtomic ?? 0).toBe(0);
  });

  it("fields_update commits with a single PUT and no status PATCH", async () => {
    const fake = createFakeWorkspace(invoiceSeed() as any);
    const preview = await executeAction({
      actionName: "clockify_invoices_fields_update",
      args: { id: "inv1", note: "Thanks" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected preview");
    await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(fake.counts.updateInvoiceFields).toBe(1);
    expect(fake.counts.updateInvoiceStatus ?? 0).toBe(0);
  });

  it("status_update commits with a single PATCH and no fields PUT", async () => {
    const fake = createFakeWorkspace(invoiceSeed() as any);
    const preview = await executeAction({
      actionName: "clockify_invoices_status_update",
      args: { id: "inv1", status: "SENT" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected preview");
    await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(fake.counts.updateInvoiceStatus).toBe(1);
    expect(fake.counts.updateInvoiceFields ?? 0).toBe(0);
  });

  it("items_add commits exactly one item POST", async () => {
    const fake = createFakeWorkspace(invoiceSeed() as any);
    const preview = await executeAction({
      actionName: "clockify_invoices_items_add",
      args: { invoiceId: "inv1", itemType: "TIME", unitPrice: 50 },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected preview");
    await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(fake.counts.addInvoiceItemAtomic).toBe(1);
  });

  it("payments_create commits a single POST payment", async () => {
    const fake = createFakeWorkspace(invoiceSeed() as any);
    const preview = await executeAction({
      actionName: "clockify_invoices_payments_create",
      args: { invoiceId: "inv1", amount: 25, paymentDate: "2026-06-06" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected preview");
    await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(fake.counts.createInvoicePaymentAtomic).toBe(1);
  });

  it("import_time commits one import POST", async () => {
    const fake = createFakeWorkspace(invoiceSeed() as any);
    const preview = await executeAction({
      actionName: "clockify_invoices_import_time",
      args: { invoiceId: "inv1", from: "2026-06-01", to: "2026-06-02" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected preview");
    await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(fake.counts.importInvoiceTimeAtomic).toBe(1);
  });

  it("changes the catalog fingerprint when invoice API presentation metadata changes", () => {
    const action = getAction("clockify_invoices_fields_update");
    if (!action) throw new Error("missing fields_update action");
    const baseline = actionFingerprintForDefinition(action);
    const altered = actionFingerprintForDefinition({
      ...action,
      presentation: { presenterId: action.presentation!.presenterId, version: action.presentation!.version + 1 },
    });
    expect(altered).not.toBe(baseline);
  });
});
