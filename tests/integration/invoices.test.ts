import { describe, expect, it } from "vitest";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { type AdminPolicy, defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext } from "../../src/harness/action.js";

const NOW = new Date("2026-06-06T00:00:00.000Z");
function makeContext(fake: FakeWorkspace, policy: AdminPolicy = defaultAdminPolicy()): ActionContext {
  return { workspaceId: "ws-1", adminUserId: "admin-1", policy, clockify: fake.client, now: () => NOW };
}
const seed = () => ({
  invoices: [
    {
      id: "inv1",
      number: "INV-1",
      clientId: "c1",
      currency: "GBP",
      status: "UNSENT" as const,
      items: [{ order: 0, description: "Discovery", quantity: 1, unitPrice: 10000, itemType: "TIME" }],
    },
  ],
});

describe("invoice actions", () => {
  it("clockify_invoices_list lists invoices and is read-gated", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({ actionName: "clockify_invoices_list", args: {}, context: makeContext(fake) });
    if (result.kind === "receipt" && result.receipt.ok) expect((result.receipt.data as any).count).toBe(1);
    else throw new Error("expected receipt");

    const off = defaultAdminPolicy();
    off.groups.invoices = "off";
    const denied = await executeAction({ actionName: "clockify_invoices_list", args: {}, context: makeContext(fake, off) });
    if (denied.kind === "receipt" && !denied.receipt.ok) expect(denied.receipt.code).toBe("policy_denied");
    else throw new Error("expected policy_denied");
  });

  it("clockify_invoices_get fetches one invoice with its items", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({ actionName: "clockify_invoices_get", args: { id: "inv1" }, context: makeContext(fake) });
    if (result.kind === "receipt" && result.receipt.ok) {
      expect((result.receipt.data as any).entity).toMatchObject({ id: "inv1", number: "INV-1" });
      expect((result.receipt.data as any).entity.items).toHaveLength(1);
    } else throw new Error("expected receipt");
  });

  it("clockify_invoices_items_list reads embedded items", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({ actionName: "clockify_invoices_items_list", args: { id: "inv1" }, context: makeContext(fake) });
    if (result.kind === "receipt" && result.receipt.ok) expect((result.receipt.data as any).count).toBe(1);
    else throw new Error("expected receipt");
  });

  it("clockify_invoices_payments_list reads payments", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({ actionName: "clockify_invoices_payments_list", args: { id: "inv1" }, context: makeContext(fake) });
    if (result.kind === "receipt" && result.receipt.ok) expect((result.receipt.data as any).count).toBe(0);
    else throw new Error("expected receipt");
  });

  it("clockify_invoices_export returns the PDF base64 envelope (read)", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({ actionName: "clockify_invoices_export", args: { id: "inv1" }, context: makeContext(fake) });
    if (result.kind === "receipt" && result.receipt.ok) {
      expect((result.receipt.data as any).contentType).toBe("application/pdf");
      expect((result.receipt.data as any).base64).toBeTruthy();
    } else throw new Error("expected receipt");
    expect(fake.counts.exportInvoice).toBe(1);
  });

  it("clockify_invoices_create previews billing then creates once on commit", async () => {
    const fake = createFakeWorkspace();
    const preview = await executeAction({
      actionName: "clockify_invoices_create",
      args: { clientId: "c1", number: "AIASSIST_SMOKE_inv", issuedDate: "2026-06-06", currency: "GBP", dueDate: "2026-07-06" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("billing");
    expect(fake.counts.createInvoice ?? 0).toBe(0);
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.createInvoice).toBe(1);
    expect(fake.state.invoices.find((i) => i.number === "AIASSIST_SMOKE_inv")).toBeDefined();
  });

  it("clockify_invoices_update previews then updates (note via PUT)", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_invoices_update",
      args: { id: "inv1", note: "Thanks for your business" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("billing");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.updateInvoice).toBe(1);
    expect((fake.state.invoices[0] as any).note).toBe("Thanks for your business");
  });

  it("clockify_invoices_update routes status through the payload", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_invoices_update",
      args: { id: "inv1", status: "SENT" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.payload).toMatchObject({ status: "SENT" });
    await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(fake.state.invoices[0].status).toBe("SENT");
  });

  it("clockify_invoices_delete previews destructive+billing then deletes once", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({ actionName: "clockify_invoices_delete", args: { id: "inv1", number: "INV-1" }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toEqual(expect.arrayContaining(["destructive", "billing"]));
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.deleteInvoice).toBe(1);
    expect(fake.state.invoices.find((i) => i.id === "inv1")).toBeUndefined();
  });

  it("clockify_invoices_items_add converts major unit price to minor in the payload", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_invoices_items_add",
      args: { invoiceId: "inv1", itemType: "TIME", description: "Consulting", quantity: 2, unitPrice: 125 },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("billing");
    // major (125.00) -> 12500 minor, stored already-converted in the payload
    expect(preview.operation.payload).toMatchObject({ item: { unitPriceMinor: 12500 } });
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.addInvoiceItem).toBe(1);
    expect(fake.state.invoices[0].items).toHaveLength(2);
  });

  it("clockify_invoices_items_delete previews destructive+billing then deletes by index", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({ actionName: "clockify_invoices_items_delete", args: { invoiceId: "inv1", index: 0 }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toEqual(expect.arrayContaining(["destructive", "billing"]));
    await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(fake.counts.deleteInvoiceItem).toBe(1);
    expect(fake.state.invoices[0].items).toHaveLength(0);
  });

  it("clockify_invoices_payments_create previews payment and stores minor units", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_invoices_payments_create",
      args: { invoiceId: "inv1", amount: 50, paymentDate: "2026-06-06", note: "deposit" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("payment");
    expect(preview.operation.payload).toMatchObject({ payment: { amountMinor: 5000 } });
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.createInvoicePayment).toBe(1);
    expect(fake.state.invoicePayments["inv1"]).toHaveLength(1);
    expect(fake.state.invoicePayments["inv1"][0].amount).toBe(5000);
  });

  it("clockify_invoices_payments_delete previews destructive+payment then deletes", async () => {
    const fake = createFakeWorkspace(seed());
    // seed a payment via the create path first
    const created = await executeAction({
      actionName: "clockify_invoices_payments_create",
      args: { invoiceId: "inv1", amount: 10, paymentDate: "2026-06-06" },
      context: makeContext(fake),
    });
    if (created.kind === "preview") await commitConfirmedOperation(makeContext(fake), created.operation);
    const paymentId = fake.state.invoicePayments["inv1"][0].id as string;

    const preview = await executeAction({ actionName: "clockify_invoices_payments_delete", args: { invoiceId: "inv1", paymentId }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toEqual(expect.arrayContaining(["destructive", "payment"]));
    await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(fake.counts.deleteInvoicePayment).toBe(1);
    expect(fake.state.invoicePayments["inv1"]).toHaveLength(0);
  });

  it("clockify_invoices_import_time previews billing then imports once", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_invoices_import_time",
      args: { invoiceId: "inv1", from: "2026-06-01", to: "2026-06-30" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("billing");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.importInvoiceTime).toBe(1);
  });
});
