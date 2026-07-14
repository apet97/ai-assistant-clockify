import { describe, expect, it, vi } from "vitest";
import { createRestCore } from "../../src/clockify/rest/core.js";
import { makeInvoiceRest } from "../../src/clockify/rest/invoices.js";
import { AmbiguousWriteOutcome } from "../../src/clockify/write-outcome.js";

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function port(fetchImpl: typeof fetch) {
  return makeInvoiceRest(
    createRestCore({ apiBase: "https://api.clockify.me/api/v1", auth: { apiKey: "k" }, fetchImpl }),
    "ws-1",
  ) as any;
}

describe("atomic invoice REST methods", () => {
  it("exposes one-mutation primitives and a lossless raw item read", () => {
    const invoice = port(vi.fn() as unknown as typeof fetch);
    for (const method of [
      "createInvoiceBase",
      "updateInvoiceFields",
      "prepareInvoiceFieldUpdate",
      "updateInvoiceStatus",
      "addInvoiceItemAtomic",
      "createInvoicePaymentAtomic",
      "listRawInvoiceItems",
    ]) {
      expect(typeof invoice[method], method).toBe("function");
    }
  });

  it("base create dispatches exactly one minimal POST", async () => {
    const fetchImpl = vi.fn(async () => json({ id: "inv-new", number: "INV-NEW" }));
    const invoice = port(fetchImpl as unknown as typeof fetch);
    await invoice.createInvoiceBase({
      clientId: "c1",
      number: "INV-NEW",
      issuedDate: "2026-06-06",
      dueDate: "2026-07-06",
      currency: "USD",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchImpl as any).mock.calls[0][1].body)).toEqual({
      clientId: "c1",
      number: "INV-NEW",
      issuedDate: "2026-06-06T00:00:00Z",
      dueDate: "2026-07-06T00:00:00Z",
      currency: "USD",
    });
  });

  it("payment atomic mutation is POST-only", async () => {
    const fetchImpl = vi.fn(async () => json({ id: "inv1" }));
    const invoice = port(fetchImpl as unknown as typeof fetch);
    await invoice.createInvoicePaymentAtomic("inv1", {
      amountMinor: 5000,
      paymentDate: "2026-06-06",
      note: "deposit",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl as any).mock.calls[0][1].method).toBe("POST");
  });

  it("classifies a successful create response without an id as ambiguous", async () => {
    const fetchImpl = vi.fn(async () => json({ number: "INV-NEW" }));
    const invoice = port(fetchImpl as unknown as typeof fetch);
    await expect(invoice.createInvoiceBase({
      clientId: "c1",
      number: "INV-NEW",
      issuedDate: "2026-06-06",
      dueDate: "2026-07-06",
      currency: "USD",
    })).rejects.toBeInstanceOf(AmbiguousWriteOutcome);
  });

  it.each([
    { label: "malformed id", response: () => json({ id: { value: "inv-new" }, number: "INV-NEW" }) },
    { label: "proxy 5xx", response: () => json({ error: "bad gateway" }, 502) },
    { label: "non-JSON success", response: () => new Response("upstream tunnel", { status: 200 }) },
  ])("classifies $label after dispatch as ambiguous without retry", async ({ response }) => {
    const fetchImpl = vi.fn(async () => response());
    const invoice = port(fetchImpl as unknown as typeof fetch);
    await expect(invoice.createInvoiceBase({
      clientId: "c1",
      number: "INV-NEW",
      issuedDate: "2026-06-06",
      dueDate: "2026-07-06",
      currency: "USD",
    })).rejects.toBeInstanceOf(AmbiguousWriteOutcome);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps atomic field/status writes mutation-only and compatibility methods binding-safe", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) =>
      init.method === "GET"
        ? json({ id: "inv1", number: "INV-1", clientId: "c1", currency: "USD" })
        : json({ id: "inv1", number: "INV-1" }),
    );
    const invoice = port(fetchImpl as unknown as typeof fetch);
    const body = await invoice.prepareInvoiceFieldUpdate("inv1", { note: "new" });
    fetchImpl.mockClear();
    await invoice.updateInvoiceFields("inv1", body);
    expect((fetchImpl as any).mock.calls.map((call: any) => call[1].method)).toEqual(["PUT"]);
    fetchImpl.mockClear();
    await invoice.updateInvoiceStatus("inv1", "SENT");
    expect((fetchImpl as any).mock.calls.map((call: any) => call[1].method)).toEqual(["PATCH"]);

    const { deleteInvoice, addInvoiceItem, deleteInvoicePayment } = invoice;
    await expect(deleteInvoice("inv1")).resolves.toBeUndefined();
    await expect(addInvoiceItem("inv1", { itemType: "TIME" })).resolves.toBeUndefined();
    await expect(deleteInvoicePayment("inv1", "pay1")).resolves.toBeUndefined();
  });

  it("preserves every raw invoice item field and order", async () => {
    const rawItems = [
      { order: 0, description: "A", applyTaxes: "TAX1", taxAmount: 300, custom: { x: 1 } },
      { order: 1, description: "B", applyTaxes: "NONE", taxAmount: 0 },
    ];
    const fetchImpl = vi.fn(async () => json({ id: "inv1", items: rawItems }));
    const invoice = port(fetchImpl as unknown as typeof fetch);
    await expect(invoice.listRawInvoiceItems("inv1")).resolves.toEqual({
      rows: rawItems,
      truncated: false,
    });
  });
});
