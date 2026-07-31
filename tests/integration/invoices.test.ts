import { afterEach, describe, expect, it, vi } from "vitest";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { type AdminPolicy, defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import { catalogForModel } from "../../src/harness/catalog.js";
import { INTERNAL_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import type { ActionContext } from "../../src/harness/action.js";
import { BinaryResponseTooLargeError } from "../../src/clockify/rest/core.js";

// Two tests below spy on console.warn to assert the D3 artifact-oversize alert.
// Without this, that spy stays installed for the rest of the file and silently
// mutes console.warn for every later test — the exact kind of cross-test leak
// that hides a regression rather than reporting one.
afterEach(() => {
  vi.restoreAllMocks();
});

const NOW = new Date("2026-06-06T00:00:00.000Z");
function makeContext(fake: FakeWorkspace, policy: AdminPolicy = defaultAdminPolicy()): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy,
    clockify: fake.client,
    now: () => NOW,
    saveArtifact: () => ({ id: "artifact-1", expiresAt: "2026-06-06T01:00:00.000Z" }),
  };
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

  it("clockify_invoices_export returns only authenticated artifact metadata", async () => {
    const fake = createFakeWorkspace(seed());
    const context = makeContext(fake);
    const saveArtifact = vi.fn(context.saveArtifact!);
    context.saveArtifact = saveArtifact;
    const result = await executeAction({ actionName: "clockify_invoices_export", args: { id: "inv1" }, context });
    if (result.kind === "receipt" && result.receipt.ok) {
      expect((result.receipt.data as any).contentType).toBe("application/pdf");
      expect((result.receipt.data as any).base64).toBeUndefined();
      expect((result.receipt.data as any).artifact).toMatchObject({
        id: "artifact-1",
        downloadUrl: "/api/artifacts/artifact-1",
        filename: "clockify-invoice-inv1.pdf",
      });
      const encoded = JSON.stringify(result);
      expect(encoded).not.toContain('"0":');
      expect(encoded).not.toContain("%PDF");
    } else throw new Error("expected receipt");
    expect(saveArtifact).toHaveBeenCalledWith(expect.objectContaining({ filename: "clockify-invoice-inv1.pdf" }));
    expect(fake.counts.exportInvoice).toBe(1);
  });

  it("clockify_invoices_export returns artifact_too_large without calling persistence", async () => {
    // D3 alert 8: the admin's receipt is not an operator signal, so this guard
    // emits the alert line too. It is NOT the production path — all four caps
    // are 1,000,000 bytes, so against the real REST adapter `getBinary` always
    // refuses first (`site=download`). This guard only fires for an alternate
    // WorkspaceClient, which is exactly what this test injects.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined).mockClear();
    const fake = createFakeWorkspace(seed());
    vi.spyOn(fake.client, "exportInvoice").mockResolvedValue({
      contentType: "application/pdf",
      bytes: new Uint8Array(1_000_001),
    });
    const saveArtifact = vi.fn(() => ({ id: "must-not-exist", expiresAt: "2026-06-06T01:00:00.000Z" }));
    const context = makeContext(fake);
    context.saveArtifact = saveArtifact;

    const result = await executeAction({
      actionName: "clockify_invoices_export",
      args: { id: "inv1" },
      context,
    });

    expect(result).toMatchObject({
      kind: "receipt",
      receipt: {
        ok: false,
        action: "clockify_invoices_export",
        code: "artifact_too_large",
      },
    });
    expect(saveArtifact).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((call) => call.map(String).join(" "))).toEqual([
      "[storage] event=artifact_oversize_rejected site=export limit=1000000 bytes=1000001",
    ]);
  });

  it("maps the live adapter's cancelled oversize response to artifact_too_large", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined).mockClear();
    const fake = createFakeWorkspace(seed());
    vi.spyOn(fake.client, "exportInvoice").mockRejectedValue(
      new BinaryResponseTooLargeError("/workspaces/ws-1/invoices/inv1/export", 1_000_000),
    );
    const saveArtifact = vi.fn(() => ({ id: "must-not-exist", expiresAt: "2026-06-06T01:00:00.000Z" }));
    const context = makeContext(fake);
    context.saveArtifact = saveArtifact;

    const result = await executeAction({
      actionName: "clockify_invoices_export",
      args: { id: "inv1" },
      context,
    });

    expect(result).toMatchObject({
      kind: "receipt",
      receipt: { ok: false, code: "artifact_too_large" },
    });
    expect(saveArtifact).not.toHaveBeenCalled();
    // This construction carries no observed size (the streaming branch cancels
    // mid-body and only has a lower bound), so `bytes=` is honestly absent.
    expect(warn.mock.calls.map((call) => call.map(String).join(" "))).toEqual([
      "[storage] event=artifact_oversize_rejected site=download limit=1000000",
    ]);
  });

  it("reports the size the adapter cap DID know (declared Content-Length or full buffer)", async () => {
    // `site=download` is the only production-reachable oversize guard, and two
    // of its three throw sites know the real length. Dropping it there would
    // omit a size we actually had on the likely production path.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined).mockClear();
    const fake = createFakeWorkspace(seed());
    vi.spyOn(fake.client, "exportInvoice").mockRejectedValue(
      new BinaryResponseTooLargeError("/workspaces/ws-1/invoices/inv1/export", 1_000_000, 4_200_000),
    );
    const context = makeContext(fake);
    context.saveArtifact = vi.fn(() => ({ id: "must-not-exist", expiresAt: "2026-06-06T01:00:00.000Z" }));

    const result = await executeAction({
      actionName: "clockify_invoices_export",
      args: { id: "inv1" },
      context,
    });

    expect(result).toMatchObject({ kind: "receipt", receipt: { ok: false, code: "artifact_too_large" } });
    expect(warn.mock.calls.map((call) => call.map(String).join(" "))).toEqual([
      "[storage] event=artifact_oversize_rejected site=download limit=1000000 bytes=4200000",
    ]);
  });

  it.each([
    ["empty body", "application/pdf", new Uint8Array()],
    ["HTML response", "text/html", new TextEncoder().encode("<html>gateway error</html>")],
    ["JSON response", "application/json", new TextEncoder().encode('{"error":"down"}')],
    ["PDF MIME without a PDF signature", "application/pdf", new TextEncoder().encode("not-a-pdf")],
  ])("rejects an invalid exported artifact (%s) before persistence", async (_label, contentType, bytes) => {
    const fake = createFakeWorkspace(seed());
    vi.spyOn(fake.client, "exportInvoice").mockResolvedValue({ contentType, bytes });
    const saveArtifact = vi.fn(() => ({ id: "must-not-exist", expiresAt: "2026-06-06T01:00:00.000Z" }));
    const context = makeContext(fake);
    context.saveArtifact = saveArtifact;

    const result = await executeAction({
      actionName: "clockify_invoices_export",
      args: { id: "inv1" },
      context,
    });

    expect(result).toMatchObject({
      kind: "receipt",
      receipt: { ok: false, code: "artifact_invalid" },
    });
    expect(saveArtifact).not.toHaveBeenCalled();
  });

  it("accepts a parameterized PDF MIME type but persists normalized application/pdf", async () => {
    const fake = createFakeWorkspace(seed());
    vi.spyOn(fake.client, "exportInvoice").mockResolvedValue({
      contentType: "Application/PDF; charset=binary",
      bytes: new TextEncoder().encode("%PDF-1.7\nfixture"),
    });
    const context = makeContext(fake);
    const saveArtifact = vi.fn(context.saveArtifact!);
    context.saveArtifact = saveArtifact;

    const result = await executeAction({
      actionName: "clockify_invoices_export",
      args: { id: "inv1" },
      context,
    });

    expect(result).toMatchObject({
      kind: "receipt",
      receipt: { ok: true, data: { contentType: "application/pdf" } },
    });
    expect(saveArtifact).toHaveBeenCalledWith(expect.objectContaining({ contentType: "application/pdf" }));
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
    expect(fake.counts.createInvoiceBase ?? 0).toBe(0);
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.createInvoiceBase).toBe(1);
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
    const input = (preview.operation.payload as { base: Record<string, string> }).base;
    expect(input.clientId).toBe("c-asd");
    expect(input.number).toBeTruthy();
    expect(input.issuedDate).toBeTruthy();
    expect(input.dueDate).toBeTruthy();
    expect(input.currency).toBeTruthy();
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.createInvoiceBase).toBe(1);
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
    expect(fake.counts.createInvoiceBase).toBe(1);
    expect(fake.counts.addInvoiceItemAtomic).toBe(1);
    // The created invoice carries the item, converted to minor units (100.00 -> 10000),
    // with Clockify's default item type when the caller didn't name one.
    const inv = fake.state.invoices[fake.state.invoices.length - 1];
    expect(inv.items).toHaveLength(1);
    expect(inv.items[0]).toMatchObject({ description: "charge", quantity: 1, unitPrice: 10000, itemType: "NEW DEFAULT" });
  });

  it("clockify_invoices_create truthfully returns partial when the item can't be added", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "c-asd", name: "asdqwe123" }], failAddInvoiceItem: true });
    const preview = await executeAction({
      actionName: "clockify_invoices_create",
      args: { clientName: "asdqwe123", items: [{ description: "charge", quantity: 1, amount: 100 }] },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt).toMatchObject({
      kind: "partial",
      receipt: { ok: true, changed: { created: [{ type: "invoice" }] } },
      recovery: { retryable: false },
    });
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
    const input = (preview.operation.payload as any).base;
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
    expect((preview.operation.payload as any).base.clientId).toBe("c-asd");

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
    expect(fake.counts.updateInvoiceFields).toBe(1);
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

  it("clockify_invoices_update resolves RELATIVE issuedDate/dueDate server-side (billing must never wire 'next month' on UPDATE)", async () => {
    // NOW is 2026-06-06. The update path must resolve dates server-side just like create.
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_invoices_update",
      args: { id: "inv1", issuedDate: "today", dueDate: "next month" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    const patch = (preview.operation.payload as any).patch;
    expect(patch.issuedDate).toBe("2026-06-06T00:00:00.000Z");
    expect(String(patch.dueDate).slice(0, 10)).toBe("2026-07-01");
  });

  it("clockify_invoices_update clarifies on an unparseable date instead of wiring it raw", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({
      actionName: "clockify_invoices_update",
      args: { id: "inv1", dueDate: "whenever it suits" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.updateInvoice ?? 0).toBe(0);
  });

  it("clockify_invoices_update resolves a client NAME in the clientId slot and clarifies on unknown (never wire an unverified ref)", async () => {
    const fake = createFakeWorkspace({ ...seed(), clients: [{ id: "c-acme", name: "Acme" }] });
    const preview = await executeAction({
      actionName: "clockify_invoices_update",
      args: { id: "inv1", clientId: "Acme" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect((preview.operation.payload as any).patch.clientId).toBe("c-acme");

    const unknown = await executeAction({
      actionName: "clockify_invoices_update",
      args: { id: "inv1", clientId: "Ghost Co" },
      context: makeContext(fake),
    });
    expect(unknown.kind).toBe("clarify");
  });

  it("clockify_invoices_delete previews destructive+billing then deletes once", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({ actionName: "clockify_invoices_delete", args: { id: "inv1", number: "INV-1" }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toEqual(expect.arrayContaining(["destructive", "billing"]));
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.deleteInvoiceAtomic).toBe(1);
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
    const entry = catalogForModel(INTERNAL_ACTION_CATALOG).find((a) => a.name === "clockify_invoices_items_add");
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
    expect(fake.counts.addInvoiceItemAtomic).toBe(1);
    expect(fake.state.invoices[0].items).toHaveLength(2);
  });

  const taxedInvoiceSeed = () => ({
    invoices: [
      {
        id: "invT",
        number: "INV-T",
        clientId: "c1",
        currency: "USD",
        status: "UNSENT" as const,
        tax: 300, // 3% (×100 ints, as the GET returns)
        items: [{ order: 0, description: "Discovery", quantity: 1, unitPrice: 10000, itemType: "TIME" }],
      },
    ],
  });

  it("items_add defaults a new item to taxed when the invoice already has a tax rate (Clockify item-based default)", async () => {
    const fake = createFakeWorkspace(taxedInvoiceSeed());
    const preview = await executeAction({
      actionName: "clockify_invoices_items_add",
      args: { invoiceId: "invT", unitPrice: 50 },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    expect((preview.operation.payload as any).item.applyTaxes).toBe("TAX1");
  });

  it("items_add does NOT add a tax flag to a new item on an untaxed invoice", async () => {
    const fake = createFakeWorkspace(seed()); // inv1 has no tax rate
    const preview = await executeAction({
      actionName: "clockify_invoices_items_add",
      args: { invoiceId: "inv1", unitPrice: 50 },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    expect((preview.operation.payload as any).item.applyTaxes).toBeUndefined();
  });

  it("items_add honors an explicit applyTaxes over the invoice's tax default", async () => {
    const fake = createFakeWorkspace(taxedInvoiceSeed());
    const preview = await executeAction({
      actionName: "clockify_invoices_items_add",
      args: { invoiceId: "invT", unitPrice: 50, applyTaxes: "NONE" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    expect((preview.operation.payload as any).item.applyTaxes).toBe("NONE");
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
    expect(fake.counts.deleteInvoiceItemAtomic).toBe(1);
    expect(fake.state.invoices[0].items).toHaveLength(0);
  });

  it("rejects an invoice-item delete when the complete line changed after preview", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_invoices_items_delete",
      args: { invoiceId: "inv1", index: 0 },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    fake.state.invoices[0].items[0].description = "Changed after preview";

    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(false);
    if (!receipt.ok) expect(receipt.code).toBe("stale_target");
    expect(fake.counts.deleteInvoiceItem ?? 0).toBe(0);
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
    expect(fake.counts.createInvoicePaymentAtomic).toBe(1);
    expect(fake.state.invoicePayments["inv1"]).toHaveLength(1);
    expect(fake.state.invoicePayments["inv1"][0].amount).toBe(5000);
  });

  it("resolves payment calendar dates and rejects impossible dates before preview", async () => {
    const fake = createFakeWorkspace(seed());
    const relative = await executeAction({
      actionName: "clockify_invoices_payments_create",
      args: { invoiceId: "inv1", amount: 50, paymentDate: "today" },
      context: makeContext(fake),
    });
    if (relative.kind !== "preview") throw new Error("expected preview");
    expect((relative.operation.payload as any).payment.paymentDate).toBe("2026-06-06");

    const impossible = await executeAction({
      actionName: "clockify_invoices_payments_create",
      args: { invoiceId: "inv1", amount: 50, paymentDate: "2026-02-30" },
      context: makeContext(fake),
    });
    expect(impossible.kind).toBe("clarify");
  });

  it("clockify_invoices_payments_create does not fabricate a 'payment' id when the list-diff can't identify it", async () => {
    const fake = createFakeWorkspace(seed());
    const listPayments = fake.client.listInvoicePayments;
    let paymentReads = 0;
    fake.client.listInvoicePayments = async (id) => {
      const result = await listPayments(id);
      paymentReads += 1;
      return paymentReads < 3
        ? result
        : {
            rows: [...result.rows, {
              id: "concurrent-match",
              amount: 5000,
              paymentDate: "2026-06-06",
            }],
            truncated: false,
          };
    };
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
    expect(fake.counts.deleteInvoicePaymentAtomic).toBe(1);
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
    expect(fake.counts.importInvoiceTimeAtomic).toBe(1);
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

  it("clockify_invoices_update forwards tax/discount percents into the patch ('tax 3' lands on the invoice; subtax no ⇒ no tax2)", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_invoices_update",
      args: { id: "inv1", taxPercent: "3", discountPercent: 10 }, // planner's flat "3"
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    const patch = (preview.operation.payload as { patch: Record<string, unknown> }).patch;
    expect(patch.taxPercent).toBe(3);
    expect(patch.discountPercent).toBe(10);
    expect(patch.tax2Percent).toBeUndefined(); // "subtax no" — no second tax
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect((fake.state.invoices.find((i) => i.id === "inv1") as any).taxPercent).toBe(3);
  });

  it("clockify_invoices_create applies a tax % and defaults its line items to taxed (Clockify item-based tax)", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "c1", name: "Acme" }] });
    const preview = await executeAction({
      actionName: "clockify_invoices_create",
      args: { clientId: "c1", taxPercent: 3, items: [{ amount: 200, quantity: 1 }] },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    const payload = preview.operation.payload as {
      enrichment: Record<string, number>;
      items: Array<{ applyTaxes?: string }>;
    };
    expect(payload.enrichment.taxPercent).toBe(3);
    expect(payload.items[0].applyTaxes).toBe("TAX1"); // rate set ⇒ item taxed by default
    expect(preview.preview.expectedChanges.join(" ")).toContain("Tax 3%"); // truthful preview
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.updateInvoiceFields).toBe(1);
    expect((fake.state.invoices[fake.state.invoices.length - 1] as any).tax).toBe(300);
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
    expect(fake.counts.deleteInvoiceAtomic).toBe(1);
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
    fake.state.invoicePayments.inv1 = [{
      id: "pay-1",
      amount: 500,
      paymentDate: "2026-06-06",
    }];
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
