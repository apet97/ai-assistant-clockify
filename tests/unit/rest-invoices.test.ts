import { describe, expect, it, vi } from "vitest";
import { createRestCore } from "../../src/clockify/rest/core.js";
import { makeInvoiceRest } from "../../src/clockify/rest/invoices.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function binaryResponse(bytes: Uint8Array, contentType = "application/pdf"): Response {
  return new Response(bytes.buffer as ArrayBuffer, { status: 200, headers: { "content-type": contentType } });
}

const rest = (fetchImpl: typeof fetch) =>
  makeInvoiceRest(
    createRestCore({ apiBase: "https://api.clockify.me/api/v1", auth: { apiKey: "k" }, fetchImpl }),
    "ws-1",
  );

describe("invoice rest", () => {
  it("listInvoices unwraps the {total, invoices:[…]} envelope and maps minor amounts", async () => {
    const f = vi.fn(async () =>
      jsonResponse({
        total: 1,
        invoices: [
          { id: "inv1", number: "INV-1", clientId: "c1", clientName: "Acme", status: "UNSENT", currency: "GBP", amount: 12500, balance: 12500 },
        ],
      }),
    );
    const out = await rest(f as unknown as typeof fetch).listInvoices();
    expect(out).toEqual([
      { id: "inv1", number: "INV-1", clientId: "c1", clientName: "Acme", status: "UNSENT", currency: "GBP", amount: 12500, balance: 12500 },
    ]);
    const parsed = new URL((f as any).mock.calls[0][0]);
    expect(parsed.pathname).toBe("/api/v1/workspaces/ws-1/invoices");
    expect(parsed.searchParams.get("page")).toBe("1");
  });

  it("listInvoices passes the live `statuses` filter param (not `status`)", async () => {
    const f = vi.fn(async () => jsonResponse({ total: 0, invoices: [] }));
    await rest(f as unknown as typeof fetch).listInvoices({ status: "PAID" });
    const parsed = new URL((f as any).mock.calls[0][0]);
    expect(parsed.searchParams.get("statuses")).toBe("PAID");
  });

  it("getInvoice returns the detail with embedded items normalized to MINOR units, or null on 404", async () => {
    // Live wire relation (probed 2026-06-10): item `unitPrice` is minor×100
    // (hundredths of a cent) while `amount` is plain minor —
    // amount = unitPrice × quantity / 100. The mapped item is all-minor.
    const hit = vi.fn(async () =>
      jsonResponse({
        id: "inv1",
        number: "INV-1",
        currency: "GBP",
        status: "UNSENT",
        items: [{ order: 0, description: "Work", quantity: 2, unitPrice: 500000, amount: 10000, itemType: "TIME" }],
      }),
    );
    expect(await rest(hit as unknown as typeof fetch).getInvoice("inv1")).toEqual({
      id: "inv1",
      number: "INV-1",
      currency: "GBP",
      status: "UNSENT",
      items: [{ order: 0, description: "Work", quantity: 2, unitPrice: 5000, amount: 10000, itemType: "TIME" }],
    });
    const miss = vi.fn(async () => jsonResponse({ message: "no" }, 404));
    expect(await rest(miss as unknown as typeof fetch).getInvoice("inv9")).toBeNull();
  });

  it("getInvoice surfaces the tax/tax2 rate (×100 ints from the GET) so item-add can default the tax flag", async () => {
    const f = vi.fn(async () =>
      jsonResponse({ id: "inv1", number: "INV-1", currency: "USD", status: "UNSENT", tax: 300, tax2: 0, items: [] }),
    );
    const detail = await rest(f as unknown as typeof fetch).getInvoice("inv1");
    expect(detail).toMatchObject({ id: "inv1", tax: 300, tax2: 0 });
  });

  it("listInvoiceItems reads items from the single-GET (GET /items 405s)", async () => {
    const f = vi.fn(async () =>
      jsonResponse({ id: "inv1", items: [{ order: 0, description: "A" }, { order: 1, description: "B" }] }),
    );
    const items = await rest(f as unknown as typeof fetch).listInvoiceItems("inv1");
    expect(items).toEqual([{ order: 0, description: "A" }, { order: 1, description: "B" }]);
    // It must hit the single-invoice path, NOT the 405 /items path.
    expect((f as any).mock.calls[0][0]).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/invoices/inv1");
  });

  it("createInvoice POSTs only the spec-required fields (no note/subject — the POST silently drops them), normalizes dates, pins status UNSENT", async () => {
    const f = vi.fn(async () => jsonResponse({ id: "inv9", number: "INV-9" }));
    const inv = await rest(f as unknown as typeof fetch).createInvoice({
      clientId: "c1",
      number: "INV-9",
      issuedDate: "2026-06-06",
      currency: "GBP",
      dueDate: "2026-07-06",
    });
    expect(inv).toEqual({ id: "inv9", name: "INV-9" });
    expect((f as any).mock.calls).toHaveLength(1);
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/invoices");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      clientId: "c1",
      number: "INV-9",
      issuedDate: "2026-06-06T00:00:00Z",
      currency: "GBP",
      dueDate: "2026-07-06T00:00:00Z",
      status: "UNSENT",
    });
  });

  it("createInvoice with note/subject POSTs the clean body, then GET-then-PUTs them through the verified update path (live-probed: POST /invoices ignores note/subject, keeping the workspace default placeholder)", async () => {
    const f = vi.fn(async (url: string, init: any) => {
      if (init.method === "POST") return jsonResponse({ id: "inv9", number: "INV-9" });
      if (init.method === "GET")
        return jsonResponse({
          id: "inv9",
          number: "INV-9",
          clientId: "c1",
          currency: "GBP",
          issuedDate: "2026-06-06T00:00:00Z",
          dueDate: "2026-07-06T00:00:00Z",
          note: "INPUT BILL INFO HERE",
          subject: "SUBJECT EXAMPLE - CHANGABLE",
        });
      return jsonResponse({ id: "inv9", number: "INV-9" }); // PUT
    });
    const inv = await rest(f as unknown as typeof fetch).createInvoice({
      clientId: "c1",
      number: "INV-9",
      issuedDate: "2026-06-06",
      currency: "GBP",
      dueDate: "2026-07-06",
      note: "thanks",
      subject: "Consulting Q2",
    });
    expect(inv).toEqual({ id: "inv9", name: "INV-9" });
    const calls = (f as any).mock.calls;
    // POST (create) → GET (read clean body) → PUT (apply note/subject)
    expect(calls.map((c: any) => c[1].method)).toEqual(["POST", "GET", "PUT"]);
    // the POST must NOT carry note/subject — Clockify ignores them there
    const postBody = JSON.parse(calls[0][1].body);
    expect(postBody).not.toHaveProperty("note");
    expect(postBody).not.toHaveProperty("subject");
    // the PUT carries the requested note/subject so the billing doc is truthful
    const putBody = JSON.parse(calls[2][1].body);
    expect(putBody.note).toBe("thanks");
    expect(putBody.subject).toBe("Consulting Q2");
  });

  it("updateInvoice GET-then-PUTs a CLEAN body (drops read-only fields, keeps required ones)", async () => {
    const f = vi.fn(async (_url: string, init: any) =>
      init.method === "GET"
        ? jsonResponse({
            id: "inv1",
            number: "INV-1",
            clientId: "c1",
            currency: "GBP",
            issuedDate: "2026-06-06T00:00:00Z",
            dueDate: "2026-07-06T00:00:00Z",
            note: "old",
            subject: "s",
            status: "UNSENT",
            amount: 12345,
            balance: 12345,
            items: [{ order: 0 }],
          })
        : jsonResponse({ id: "inv1", number: "INV-1" }),
    );
    const updated = await rest(f as unknown as typeof fetch).updateInvoice("inv1", { patch: { note: "new" } });
    expect(updated).toEqual({ id: "inv1", name: "INV-1" });
    const calls = (f as any).mock.calls;
    expect(calls.map((c: any) => c[1].method)).toEqual(["GET", "PUT"]);
    const putBody = JSON.parse(calls[1][1].body);
    expect(putBody).toEqual({
      clientId: "c1",
      currency: "GBP",
      dueDate: "2026-07-06T00:00:00Z",
      issuedDate: "2026-06-06T00:00:00Z",
      note: "new",
      number: "INV-1",
      subject: "s",
    });
    // read-only/computed fields must NOT be echoed back into the PUT
    for (const key of ["amount", "balance", "items", "status", "id"]) {
      expect(putBody).not.toHaveProperty(key);
    }
  });

  it("updateInvoice PRESERVES tax/discount: GET names them discount/tax/tax2 (×100 ints); the PUT wants discountPercent/taxPercent/tax2Percent (live-probed: copying the *Percent names from GET silently ZEROED them)", async () => {
    const f = vi.fn(async (_url: string, init: any) =>
      init.method === "GET"
        ? jsonResponse({
            id: "inv1",
            number: "INV-1",
            clientId: "c1",
            currency: "USD",
            issuedDate: "2026-06-06T00:00:00Z",
            dueDate: "2026-07-06T00:00:00Z",
            // live wire shape after PUT discountPercent=10/taxPercent=5: ×100 scaled ints
            discount: 1000,
            tax: 500,
            tax2: 0,
          })
        : jsonResponse({ id: "inv1", number: "INV-1" }),
    );
    await rest(f as unknown as typeof fetch).updateInvoice("inv1", { patch: { note: "new" } });
    const putBody = JSON.parse((f as any).mock.calls[1][1].body);
    expect(putBody.discountPercent).toBe(10);
    expect(putBody.taxPercent).toBe(5);
    expect(putBody.tax2Percent).toBe(0);
    // the GET-side names must not leak into the PUT body
    for (const key of ["discount", "tax", "tax2"]) {
      expect(putBody).not.toHaveProperty(key);
    }
  });

  it("updateInvoice routes a status change through PATCH /status (GET for the number, never a PUT replace)", async () => {
    const f = vi.fn(async (_url: string, init: any) =>
      init.method === "GET" ? jsonResponse({ id: "inv1", number: "INV-1" }) : jsonResponse(null, 204),
    );
    const out = await rest(f as unknown as typeof fetch).updateInvoice("inv1", { status: "SENT" });
    // the receipt must carry the invoice NUMBER, not the raw id, for a status-only change
    expect(out).toEqual({ id: "inv1", name: "INV-1" });
    const calls = (f as any).mock.calls;
    expect(calls.map((c: any) => c[1].method)).toEqual(["GET", "PATCH"]);
    // crucially, a status-only change must NOT trigger the destructive PUT replace
    expect(calls.map((c: any) => c[1].method)).not.toContain("PUT");
    const patch = calls.find((c: any) => c[1].method === "PATCH");
    expect(patch[0]).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/invoices/inv1/status");
    expect(JSON.parse(patch[1].body)).toEqual({ invoiceStatus: "SENT" });
  });

  it("deleteInvoice issues a DELETE", async () => {
    const f = vi.fn(async () => jsonResponse(null, 204));
    await rest(f as unknown as typeof fetch).deleteInvoice("inv1");
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/invoices/inv1");
    expect(init.method).toBe("DELETE");
  });

  it("addInvoiceItem POSTs unitPrice in the wire's minor×100 scale (live-probed: sending plain minor made a $1000 item bill as $10)", async () => {
    const f = vi.fn(async () => jsonResponse({ order: 1 }));
    await rest(f as unknown as typeof fetch).addInvoiceItem("inv1", {
      itemType: "NEW DEFAULT",
      description: "Consulting",
      quantity: 3,
      unitPriceMinor: 12500, // $125.00/unit
    });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/invoices/inv1/items");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      description: "Consulting",
      quantity: 3,
      unitPrice: 1250000, // minor × 100 — Clockify computes amount = unitPrice·q/100
      applyTaxes: "NONE",
      itemType: "NEW DEFAULT",
    });
  });

  it("deleteInvoiceItem deletes by line index (order), not a Mongo id", async () => {
    const f = vi.fn(async () => jsonResponse(null, 204));
    await rest(f as unknown as typeof fetch).deleteInvoiceItem("inv1", 2);
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/invoices/inv1/items/2");
    expect(init.method).toBe("DELETE");
  });

  it("listInvoicePayments maps the LIVE bare array whose item date field is `date` (probed: keys id,amount,date,note,author)", async () => {
    const f = vi.fn(async () =>
      jsonResponse([{ id: "pay1", amount: 5000, note: "deposit", date: "2026-06-06T00:00:00Z", author: "Ann" }]),
    );
    const out = await rest(f as unknown as typeof fetch).listInvoicePayments("inv1");
    expect(out).toEqual([{ id: "pay1", amount: 5000, note: "deposit", paymentDate: "2026-06-06T00:00:00Z" }]);
    expect((f as any).mock.calls[0][0]).toContain("/workspaces/ws-1/invoices/inv1/payments");
  });

  it("listInvoicePayments still unwraps an envelope (defensive fallback)", async () => {
    const f = vi.fn(async () =>
      jsonResponse({ payments: [{ id: "pay1", amount: 5000, note: "deposit", paymentDate: "2026-06-06T00:00:00Z" }] }),
    );
    const out = await rest(f as unknown as typeof fetch).listInvoicePayments("inv1");
    expect(out).toEqual([{ id: "pay1", amount: 5000, note: "deposit", paymentDate: "2026-06-06T00:00:00Z" }]);
  });

  it("createInvoicePayment POSTs amount + paymentDate (NOT date) and returns the NEW payment from the list diff — the POST response is the INVOICE body, not the payment (live-probed)", async () => {
    const before = [{ id: "pay0", amount: 100, date: "2026-06-01T00:00:00Z" }];
    const after = [...before, { id: "pay1", amount: 5000, note: "deposit", date: "2026-06-06T00:00:00Z" }];
    let listCalls = 0;
    const f = vi.fn(async (_url: string, init: any) => {
      if (init.method === "GET") return jsonResponse(listCalls++ === 0 ? before : after);
      // the live POST response is the updated INVOICE, whose id/amount must NOT be mistaken for the payment's
      return jsonResponse({ id: "inv1", amount: 0, clientId: "c1", status: "UNSENT" });
    });
    const out = await rest(f as unknown as typeof fetch).createInvoicePayment("inv1", {
      amountMinor: 5000,
      paymentDate: "2026-06-06",
      note: "deposit",
    });
    expect(out).toEqual({ id: "pay1", amount: 5000, note: "deposit", paymentDate: "2026-06-06T00:00:00Z" });
    const post = (f as any).mock.calls.find((c: any) => c[1].method === "POST");
    expect(post[0]).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/invoices/inv1/payments");
    const body = JSON.parse(post[1].body);
    expect(body).toEqual({ amount: 5000, paymentDate: "2026-06-06T00:00:00Z", note: "deposit" });
    expect(body).not.toHaveProperty("date");
  });

  it("deleteInvoicePayment deletes the payment by id", async () => {
    const f = vi.fn(async () => jsonResponse(null, 204));
    await rest(f as unknown as typeof fetch).deleteInvoicePayment("inv1", "pay1");
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/invoices/inv1/payments/pay1");
    expect(init.method).toBe("DELETE");
  });

  it("importInvoiceTime POSTs the date range + project filter to /items/import", async () => {
    const f = vi.fn(async () => jsonResponse({ ok: true }));
    await rest(f as unknown as typeof fetch).importInvoiceTime("inv1", {
      from: "2026-06-01",
      to: "2026-06-30",
      projectIds: ["p1", "p2"],
    });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/invoices/inv1/items/import");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.from).toBe("2026-06-01T00:00:00Z");
    expect(body.to).toBe("2026-06-30T00:00:00Z");
    expect(body.importExpenses).toBe(false);
    expect(body.timeEntryGroupType).toBe("DETAILED");
    expect(body.projectFilter).toEqual({ contains: "CONTAINS", status: "ALL", ids: ["p1", "p2"] });
  });

  it("exportInvoice GETs the PDF export and base64-encodes the bytes under the cap", async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    const f = vi.fn(async () => binaryResponse(pdf));
    const out = await rest(f as unknown as typeof fetch).exportInvoice("inv1");
    expect(out.contentType).toBe("application/pdf");
    expect(out.bytes).toBe(4);
    expect(out.truncated).toBe(false);
    expect(out.base64).toBe(Buffer.from(pdf).toString("base64"));
    const parsed = new URL((f as any).mock.calls[0][0]);
    expect(parsed.pathname).toBe("/api/v1/workspaces/ws-1/invoices/inv1/export");
    expect(parsed.searchParams.get("format")).toBe("PDF");
    expect(parsed.searchParams.get("userLocale")).toBe("en-US");
  });

  it("exportInvoice omits base64 and flags truncation when the file exceeds the cap (no silent cap)", async () => {
    const big = new Uint8Array(1_000_001); // just over the 1 MB cap
    const f = vi.fn(async () => binaryResponse(big));
    const out = await rest(f as unknown as typeof fetch).exportInvoice("inv1");
    expect(out.bytes).toBe(1_000_001);
    expect(out.truncated).toBe(true);
    expect(out.base64).toBeUndefined();
  });

  it("exportInvoice rejects a non-PDF format (Clockify export is PDF-only)", async () => {
    const f = vi.fn(async () => binaryResponse(new Uint8Array([1])));
    await expect(rest(f as unknown as typeof fetch).exportInvoice("inv1", "CSV")).rejects.toThrow(/PDF/);
  });
});
