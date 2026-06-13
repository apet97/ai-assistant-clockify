import { describe, expect, it } from "vitest";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { type AdminPolicy, defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import { catalogForModel } from "../../src/harness/catalog.js";
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
    // The client must exist: a short id resolves via the listed exact-id fallback.
    const fake = createFakeWorkspace({ clients: [{ id: "c1", name: "Acme" }] });
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

  it("clockify_invoices_create resolves the client by name and defaults number/dates/currency", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "c-asd", name: "asdqwe123" }] });
    const preview = await executeAction({
      actionName: "clockify_invoices_create",
      args: { clientName: "asdqwe123" }, // no id, no number/dates/currency — the planner's natural shape
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    const input = (preview.operation.payload as { input: Record<string, string> }).input;
    expect(input.clientId).toBe("c-asd");
    expect(input.number).toBeTruthy();
    expect(input.issuedDate).toBeTruthy();
    expect(input.dueDate).toBeTruthy();
    expect(input.currency).toBeTruthy();
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.createInvoice).toBe(1);
  });

  it("clockify_invoices_create adds inline items in the same step (resolves the new invoice id server-side)", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "c-asd", name: "asdqwe123" }] });
    const preview = await executeAction({
      actionName: "clockify_invoices_create",
      args: { clientName: "asdqwe123", items: [{ description: "charge", quantity: 1, amount: 100 }] },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.createInvoice).toBe(1);
    expect(fake.counts.addInvoiceItem).toBe(1);
    // The created invoice carries the item, converted to minor units (100.00 -> 10000),
    // with Clockify's default item type when the caller didn't name one.
    const inv = fake.state.invoices[fake.state.invoices.length - 1];
    expect(inv.items).toHaveLength(1);
    expect(inv.items[0]).toMatchObject({ description: "charge", quantity: 1, unitPrice: 10000, itemType: "NEW DEFAULT" });
  });

  it("clockify_invoices_create still creates the invoice and warns actionably when the item can't be added", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "c-asd", name: "asdqwe123" }], failAddInvoiceItem: true });
    const preview = await executeAction({
      actionName: "clockify_invoices_create",
      args: { clientName: "asdqwe123", items: [{ description: "charge", quantity: 1, amount: 100 }] },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true); // the invoice itself was created
    expect(receipt.ok && receipt.changed?.created?.[0]?.type).toBe("invoice");
    const warnings = (receipt.ok && receipt.warnings) || [];
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => /item type/i.test(w.message))).toBe(true);
  });

  it("clockify_invoices_create clarifies (not punt) when the client name matches none / many", async () => {
    const none = await executeAction({
      actionName: "clockify_invoices_create",
      args: { clientName: "ghost" },
      context: makeContext(createFakeWorkspace({ clients: [{ id: "c1", name: "asdqwe123" }] })),
    });
    expect(none.kind).toBe("clarify");
    const many = await executeAction({
      actionName: "clockify_invoices_create",
      args: { clientName: "Dup" },
      context: makeContext(createFakeWorkspace({ clients: [{ id: "a", name: "Dup" }, { id: "b", name: "Dup" }] })),
    });
    expect(many.kind).toBe("clarify");
    if (many.kind === "clarify") expect(many.options?.length).toBe(2);
  });

  it("clockify_invoices_create resolves RELATIVE issuedDate/dueDate server-side (billing must never wire 'next month')", async () => {
    // NOW is 2026-06-06 (a Saturday).
    const fake = createFakeWorkspace({ clients: [{ id: "c1", name: "Acme" }] });
    const preview = await executeAction({
      actionName: "clockify_invoices_create",
      args: { clientId: "c1", issuedDate: "today", dueDate: "next month" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    const input = (preview.operation.payload as any).input;
    expect(input.issuedDate).toBe("2026-06-06T00:00:00.000Z");
    expect(input.dueDate.slice(0, 10)).toBe("2026-07-01");
    // Truthful preview: the resolved dates are what the admin verifies.
    expect(preview.preview.expectedChanges.join(" ")).toContain("due 2026-07-01");
  });

  it("clockify_invoices_create clarifies on an unparseable date instead of wiring it", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "c1", name: "Acme" }] });
    const result = await executeAction({
      actionName: "clockify_invoices_create",
      args: { clientId: "c1", dueDate: "whenever it suits" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.createInvoice ?? 0).toBe(0);
  });

  it("clockify_invoices_create resolves a client NAME placed in the clientId SLOT (billing must never wire an unverified ref)", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "c-asd", name: "asdqwe123" }] });
    const preview = await executeAction({
      actionName: "clockify_invoices_create",
      args: { clientId: "asdqwe123" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect((preview.operation.payload as any).input.clientId).toBe("c-asd");

    const unknown = await executeAction({
      actionName: "clockify_invoices_create",
      args: { clientId: "Ghost Co" },
      context: makeContext(fake),
    });
    expect(unknown.kind).toBe("clarify");
    if (unknown.kind === "clarify") expect(unknown.message).toMatch(/create the client first/i);
  });

  it("clockify_invoices_create rejects a call with neither clientId nor clientName", async () => {
    const result = await executeAction({
      actionName: "clockify_invoices_create",
      args: { number: "X" },
      context: makeContext(createFakeWorkspace()),
    });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt" && !result.receipt.ok) expect(result.receipt.code).toBe("invalid_args");
    else throw new Error("expected invalid_args");
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

  it("clockify_invoices_update preview shows the VALUE each field will be set to (catchable before confirm)", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_invoices_update",
      args: { id: "inv1", currency: "EUR", note: "Net 30" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    const changes = preview.preview.expectedChanges.join(" ");
    // The admin confirms a BUTTON, so the value the commit will write must be on
    // the card — a model-garbled "EUR"/"GBP" must be catchable at preview time.
    expect(changes).toContain("EUR");
    expect(changes).toContain("Net 30");
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

  // Live-verified API facts (probed via X-Api-Key): invoice `itemType` must be a
  // workspace-CONFIGURED NAME (not an enum/id); names vary per workspace; there is
  // NO list/create API — but names ARE stored on existing line items, so the
  // harness discovers the valid ones instead of blindly sending "NEW DEFAULT".
  const typedSeed = () => ({
    clients: [{ id: "c9", name: "ratta" }],
    invoices: [
      { id: "inv9", number: "INV-9", clientId: "c9", currency: "USD" as const, status: "UNSENT" as const,
        items: [{ order: 0, description: "x", quantity: 1, unitPrice: 1000, itemType: "Consulting" }] },
      { id: "inv10", number: "INV-10", clientId: "c9", currency: "USD" as const, status: "UNSENT" as const,
        items: [{ order: 0, description: "y", quantity: 1, unitPrice: 1000, itemType: "Travel" }] },
    ],
  });

  it("the items_add description says an AMOUNT ALONE is enough — the model must not interrogate the admin for defaults (live item 139)", () => {
    const entry = catalogForModel().find((a) => a.name === "clockify_invoices_items_add");
    expect(entry?.description.toLowerCase()).toContain("amount alone is enough");
    expect(entry?.description.toLowerCase()).toContain("don't ask the admin");
  });

  it("items_add defaults to a DISCOVERED item type, not the per-workspace-specific 'NEW DEFAULT'", async () => {
    const fake = createFakeWorkspace(typedSeed());
    const preview = await executeAction({
      actionName: "clockify_invoices_items_add",
      args: { invoiceId: "inv9", description: "charge", quantity: 1, unitPrice: 100 },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    // A real, valid type from the workspace — never the hardcoded "NEW DEFAULT".
    expect((preview.operation.payload as { item: { itemType: string } }).item.itemType).toBe("Consulting");
  });

  it("items_add defaults the wire-REQUIRED description (to the item type) and quantity (to 1) — live: POST /items 400s 'Description is required.' without one", async () => {
    const fake = createFakeWorkspace(typedSeed());
    const preview = await executeAction({
      actionName: "clockify_invoices_items_add",
      args: { invoiceId: "inv9", unitPrice: 100 },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    const item = (preview.operation.payload as { item: Record<string, unknown> }).item;
    expect(item.description).toBe("Consulting");
    expect(item.quantity).toBe(1);
  });

  it("create-with-items defaults each item's description and quantity the same way", async () => {
    const fake = createFakeWorkspace(typedSeed());
    const preview = await executeAction({
      actionName: "clockify_invoices_create",
      args: { clientName: "ratta", items: [{ amount: 1000 }] },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    const items = (preview.operation.payload as { items: Array<Record<string, unknown>> }).items;
    expect(items[0].description).toBe("Consulting");
    expect(items[0].quantity).toBe(1);
    expect(items[0].unitPriceMinor).toBe(100000);
  });

  it("items_add resolves a requested type case-insensitively to the workspace's canonical name", async () => {
    const fake = createFakeWorkspace(typedSeed());
    const preview = await executeAction({
      actionName: "clockify_invoices_items_add",
      args: { invoiceId: "inv9", itemType: "travel", description: "charge", quantity: 1, unitPrice: 100 },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect((preview.operation.payload as { item: { itemType: string } }).item.itemType).toBe("Travel");
  });

  it("items_add CLARIFIES with the real item-type list when the requested type isn't configured (no raw 404)", async () => {
    const fake = createFakeWorkspace(typedSeed());
    const result = await executeAction({
      actionName: "clockify_invoices_items_add",
      args: { invoiceId: "inv9", itemType: "service", description: "charge", quantity: 1, unitPrice: 100 },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    if (result.kind === "clarify") {
      expect(result.message).toContain("Consulting");
      expect(result.message).toContain("Travel");
      expect(result.options?.map((o) => o.label)).toEqual(expect.arrayContaining(["Consulting", "Travel"]));
    }
    expect(fake.counts.addInvoiceItem ?? 0).toBe(0);
  });

  it("create CLARIFIES with the real item types instead of creating a doomed $0 invoice for a bad type", async () => {
    const fake = createFakeWorkspace(typedSeed());
    const result = await executeAction({
      actionName: "clockify_invoices_create",
      args: { clientName: "ratta", items: [{ description: "CHARGE", quantity: 1, amount: 1000, itemType: "service" }] },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    if (result.kind === "clarify") expect(result.message).toContain("Consulting");
    expect(fake.counts.createInvoice ?? 0).toBe(0); // nothing created — no orphan $0 invoice
  });

  it("items_add converts major unit price to minor in the payload", async () => {
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

  it("items_add SHOWS the unit price (and quantity) on the preview card — the admin confirms a billing amount, so it must be catchable before Confirm", async () => {
    const fake = createFakeWorkspace(typedSeed());
    const preview = await executeAction({
      actionName: "clockify_invoices_items_add",
      args: { invoiceId: "inv9", itemType: "Consulting", description: "web development", quantity: 1, unitPrice: 250 },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    const changes = preview.preview.expectedChanges.join(" ");
    // The $250 the admin typed is stored in the payload (25000 minor) and WILL be
    // committed — a billing preview that hides it is uninformative.
    expect(preview.operation.payload).toMatchObject({ item: { unitPriceMinor: 25000 } });
    expect(changes).toContain("250.00");
    expect(changes).toContain("×1");
    // …and never the raw 100x wire integer (would read as $25000 on a $250 item).
    expect(changes).not.toContain("25000");
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
    // The money preview shows the HUMAN amount, not the 100x wire integer — a
    // $50 payment must read "50.00", never "5000 (minor units)".
    expect(preview.preview.expectedChanges[0]).toContain("50.00");
    expect(preview.preview.expectedChanges[0]).not.toContain("5000 (minor units)");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.createInvoicePayment).toBe(1);
    expect(fake.state.invoicePayments["inv1"]).toHaveLength(1);
    expect(fake.state.invoicePayments["inv1"][0].amount).toBe(5000);
  });

  it("clockify_invoices_payments_create does not fabricate a 'payment' id when the list-diff can't identify it", async () => {
    const fake = createFakeWorkspace(seed());
    // Simulate the live list-diff returning nothing identifiable (e.g. a
    // concurrent payment or id-less rows) → the adapter returns {}.
    fake.client.createInvoicePayment = async () => ({});
    const preview = await executeAction({
      actionName: "clockify_invoices_payments_create",
      args: { invoiceId: "inv1", amount: 50, paymentDate: "2026-06-06" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) throw new Error("expected success receipt");
    // No fabricated EntityRef with the literal id "payment" anywhere in the change set.
    const refs = [
      ...(receipt.changed?.created ?? []),
      ...(receipt.changed?.updated ?? []),
      ...(receipt.changed?.deleted ?? []),
      ...(receipt.changed?.reused ?? []),
    ];
    expect(refs.map((r) => r.id)).not.toContain("payment");
    // The receipt stays honest about the unknown id via a warning.
    expect((receipt.warnings ?? []).map((w) => w.code)).toContain("payment_id_unknown");
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

  it("clockify_invoices_import_time resolves RELATIVE dates server-side (billing must never wire raw 'today' → Clockify 400 '[to] can't be null')", async () => {
    // NOW is 2026-06-06. "import all time entries" makes the planner invent a
    // from/to, and it's encouraged to emit date WORDS; they must resolve or the
    // import endpoint rejects `to` as null. from→start-of-day, to→end-of-day
    // (Clockify wants `to` strictly after `from`).
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_invoices_import_time",
      args: { invoiceId: "inv1", from: "today", to: "today" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    const range = (preview.operation.payload as { range: { from: string; to: string } }).range;
    expect(range.from).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(range.to).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(range.from).toBe("2026-06-06T00:00:00.000Z");
    expect(range.to).toBe("2026-06-06T23:59:59.999Z");
    expect(range.to > range.from).toBe(true);
  });

  it("clockify_invoices_import_time clarifies on an unparseable date instead of wiring it", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({
      actionName: "clockify_invoices_import_time",
      args: { invoiceId: "inv1", from: "today", to: "whenever it suits" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.importInvoiceTime ?? 0).toBe(0);
  });
});

describe("invoice actions — number→id resolution at preview time (live-loop FIX 1: every invoice call used the NUMBER)", () => {
  it("clockify_invoices_get fetches by `number`, and by a number passed in the id slot", async () => {
    const fake = createFakeWorkspace(seed());
    const byNumber = await executeAction({
      actionName: "clockify_invoices_get",
      args: { number: "INV-1" },
      context: makeContext(fake),
    });
    if (byNumber.kind !== "receipt" || !byNumber.receipt.ok) throw new Error("expected a success receipt");
    expect((byNumber.receipt.data as any).entity).toMatchObject({ id: "inv1" });

    const inIdSlot = await executeAction({
      actionName: "clockify_invoices_get",
      args: { id: "INV-1" },
      context: makeContext(fake),
    });
    if (inIdSlot.kind !== "receipt" || !inIdSlot.receipt.ok) throw new Error("expected a success receipt");
    expect((inIdSlot.receipt.data as any).entity).toMatchObject({ id: "inv1" });
  });

  it("clockify_invoices_get clarifies on an unknown number instead of a raw 400", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({
      actionName: "clockify_invoices_get",
      args: { id: "INV-20260610021808" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
  });

  it("clockify_invoices_update resolves a NUMBER in the id slot and pins the real id", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_invoices_update",
      args: { id: "INV-1", note: "Net 30" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.payload).toMatchObject({ id: "inv1" });
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
  });

  it("clockify_invoices_delete deletes by `number` alone", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_invoices_delete",
      args: { number: "INV-1" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect((preview.operation.payload as { id: string }).id).toBe("inv1");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.deleteInvoice).toBe(1);
  });

  it("items_list / payments_list / export resolve a number in the id slot", async () => {
    const fake = createFakeWorkspace(seed());
    const items = await executeAction({
      actionName: "clockify_invoices_items_list",
      args: { id: "INV-1" },
      context: makeContext(fake),
    });
    if (items.kind !== "receipt" || !items.receipt.ok) throw new Error("expected items receipt");
    expect((items.receipt.data as any).count).toBe(1);

    const payments = await executeAction({
      actionName: "clockify_invoices_payments_list",
      args: { id: "INV-1" },
      context: makeContext(fake),
    });
    expect(payments.kind).toBe("receipt");

    const exported = await executeAction({
      actionName: "clockify_invoices_export",
      args: { id: "INV-1" },
      context: makeContext(fake),
    });
    if (exported.kind !== "receipt" || !exported.receipt.ok) throw new Error("expected export receipt");
  });

  it("items_add / items_delete / payments_create / payments_delete / import_time resolve a number in the invoiceId slot", async () => {
    const fake = createFakeWorkspace(seed());
    const add = await executeAction({
      actionName: "clockify_invoices_items_add",
      args: { invoiceId: "INV-1", description: "Work", unitPrice: 10 },
      context: makeContext(fake),
    });
    if (add.kind !== "preview") throw new Error("expected items_add preview");
    expect((add.operation.payload as any).invoiceId).toBe("inv1");

    const del = await executeAction({
      actionName: "clockify_invoices_items_delete",
      args: { invoiceId: "INV-1", index: 0 },
      context: makeContext(fake),
    });
    if (del.kind !== "preview") throw new Error("expected items_delete preview");
    expect((del.operation.payload as any).invoiceId).toBe("inv1");

    const pay = await executeAction({
      actionName: "clockify_invoices_payments_create",
      args: { invoiceId: "INV-1", amount: 5, paymentDate: "2026-06-06" },
      context: makeContext(fake),
    });
    if (pay.kind !== "preview") throw new Error("expected payments_create preview");
    expect((pay.operation.payload as any).invoiceId).toBe("inv1");

    const payDel = await executeAction({
      actionName: "clockify_invoices_payments_delete",
      args: { invoiceId: "INV-1", paymentId: "pay-1" },
      context: makeContext(fake),
    });
    if (payDel.kind !== "preview") throw new Error("expected payments_delete preview");
    expect((payDel.operation.payload as any).invoiceId).toBe("inv1");

    const imp = await executeAction({
      actionName: "clockify_invoices_import_time",
      args: { invoiceId: "INV-1", from: "2026-06-01", to: "2026-06-30" },
      context: makeContext(fake),
    });
    if (imp.kind !== "preview") throw new Error("expected import_time preview");
    expect((imp.operation.payload as any).invoiceId).toBe("inv1");
  });

  it("a risky invoice action clarifies (never previews a doomed commit) when the number matches nothing", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({
      actionName: "clockify_invoices_items_add",
      args: { invoiceId: "INV-999", description: "Work" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
  });
});
