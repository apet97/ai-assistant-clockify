import { describe, expect, it, vi } from "vitest";
import { createRestCore } from "../../src/clockify/rest/core.js";
import { makeExpenseRest } from "../../src/clockify/rest/expenses.js";
import { AmbiguousWriteOutcome } from "../../src/clockify/write-outcome.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const rest = (fetchImpl: typeof fetch) =>
  makeExpenseRest(
    createRestCore({ apiBase: "https://api.clockify.me/api/v1", auth: { apiKey: "k" }, fetchImpl }),
    "ws-1",
  );

describe("expense rest", () => {
  it.each([
    ["expense", (api: ReturnType<typeof rest>) => api.createExpenseAtomic({ userId: "u1", amountMinor: 100, date: "2026-07-14", categoryId: "c1" })],
    ["expense category", (api: ReturnType<typeof rest>) => api.createExpenseCategoryAtomic({ name: "Travel" })],
  ] as const)("classifies malformed successful %s creates without an id as ambiguous", async (_label, invoke) => {
    const f = vi.fn(async () => jsonResponse({ name: "missing id" }));
    await expect(invoke(rest(f as unknown as typeof fetch))).rejects.toBeInstanceOf(AmbiguousWriteOutcome);
  });

  it("listExpenses unwraps the double-nested {expenses:{expenses:[…]}} envelope (notes→name)", async () => {
    const f = vi.fn(async () =>
      jsonResponse({
        expenses: { expenses: [{ id: "x1", notes: "Taxi", date: "2026-06-06T00:00:00Z", categoryId: "c1" }], count: 1 },
      }),
    );
    const out = await rest(f as unknown as typeof fetch).listExpenses();
    expect(out).toEqual({
      rows: [{ id: "x1", name: "Taxi", notes: "Taxi", date: "2026-06-06T00:00:00Z", categoryId: "c1" }],
      truncated: false,
    });
    const parsed = new URL((f as any).mock.calls[0][0]);
    expect(parsed.pathname).toBe("/api/v1/workspaces/ws-1/expenses");
    expect(parsed.searchParams.get("page")).toBe("1");
  });

  it("listExpenses also tolerates a plain array and passes start/end filters", async () => {
    const f = vi.fn(async () => jsonResponse([{ id: "x2", notes: "Hotel" }]));
    const out = await rest(f as unknown as typeof fetch).listExpenses({ start: "2026-06-01", end: "2026-06-30" });
    expect(out).toEqual({ rows: [{ id: "x2", name: "Hotel", notes: "Hotel" }], truncated: false });
    const parsed = new URL((f as any).mock.calls[0][0]);
    expect(parsed.searchParams.get("start")).toBe("2026-06-01");
    expect(parsed.searchParams.get("end")).toBe("2026-06-30");
  });

  it("getExpense fetches one expense, or null on 404", async () => {
    const hit = vi.fn(async () => jsonResponse({ id: "x1", notes: "Taxi", billable: true }));
    expect(await rest(hit as unknown as typeof fetch).getExpense("x1")).toEqual({
      id: "x1",
      name: "Taxi",
      notes: "Taxi",
      billable: true,
    });
    const miss = vi.fn(async () => jsonResponse({ message: "no" }, 404));
    expect(await rest(miss as unknown as typeof fetch).getExpense("x9")).toBeNull();
  });

  it("createExpense POSTs multipart with userId + MAJOR amount (minor/100) + categoryId", async () => {
    const f = vi.fn(async () => jsonResponse({ id: "x9", notes: "Lunch" }));
    const created = await rest(f as unknown as typeof fetch).createExpense({
      userId: "u1",
      amountMinor: 12500, // 125.00 major on the wire
      date: "2026-06-06",
      categoryId: "c1",
      notes: "Lunch",
      billable: true,
    });
    expect(created).toEqual({ id: "x9", name: "Lunch" });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/expenses");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.headers["content-type"]).toBeUndefined(); // multipart sets its own boundary
    const form = init.body as FormData;
    expect(form.get("userId")).toBe("u1");
    expect(form.get("amount")).toBe("125.00"); // minor 12500 -> major 125.00 on the wire
    expect(form.get("date")).toBe("2026-06-06T00:00:00Z"); // normalized to full ISO
    expect(form.get("categoryId")).toBe("c1");
    expect(form.get("notes")).toBe("Lunch");
    expect(form.get("billable")).toBe("true");
  });

  it("updateExpense re-sends base fields from existing (full-replace PUT); reconstructs amount from total/quantity", async () => {
    // The multipart PUT replaces the expense, so date/categoryId/userId/amount/quantity
    // must all be present even when only notes change. The GET returns `total` (MINOR)
    // and `quantity` (no `amount`), so the per-unit major amount is total/quantity/100,
    // and quantity is re-sent to preserve the total.
    const f = vi.fn(async (_url: string, init: any) =>
      init.method === "GET"
        ? jsonResponse({ id: "x1", userId: "u1", notes: "old", date: "2026-06-01T00:00:00Z", categoryId: "c1", total: 10000, quantity: 50 })
        : jsonResponse({ id: "x1", notes: "new" }),
    );
    const updated = await rest(f as unknown as typeof fetch).updateExpense("x1", {
      changeFields: ["NOTES"],
      notes: "new",
    });
    expect(updated).toEqual({ id: "x1", name: "new" });
    const calls = (f as any).mock.calls;
    expect(calls.map((c: any) => c[1].method)).toEqual(["GET", "PUT"]);
    expect(calls[1][0]).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/expenses/x1");
    const form = calls[1][1].body as FormData;
    expect(form.getAll("changeFields")).toEqual(["NOTES"]);
    expect(form.get("userId")).toBe("u1");
    expect(form.get("notes")).toBe("new");
    expect(form.get("date")).toBe("2026-06-01T00:00:00Z");
    expect(form.get("categoryId")).toBe("c1");
    expect(form.get("amount")).toBe("2.00"); // total 10000 / qty 50 / 100 -> 2.00 per unit
    expect(form.get("quantity")).toBe("50"); // re-sent so the total round-trips
  });

  it("updateExpense converts a CHANGED amount to major (minor/100) and preserves quantity", async () => {
    const f = vi.fn(async (_url: string, init: any) =>
      init.method === "GET"
        ? jsonResponse({ id: "x1", userId: "u1", date: "2026-06-01T00:00:00Z", categoryId: "c1", total: 100, quantity: 1 })
        : jsonResponse({ id: "x1" }),
    );
    await rest(f as unknown as typeof fetch).updateExpense("x1", { changeFields: ["AMOUNT"], amountMinor: 5000 });
    const form = (f as any).mock.calls[1][1].body as FormData;
    expect(form.getAll("changeFields")).toEqual(["AMOUNT"]);
    expect(form.get("amount")).toBe("50.00"); // changed -> minor 5000 to major 50.00
    expect(form.get("quantity")).toBe("1");
    expect(form.get("categoryId")).toBe("c1");
  });

  it("listExpenseCategories passes the spec's archived filter (default wire behavior is ACTIVE-ONLY)", async () => {
    const f = vi.fn(async () => jsonResponse([]));
    await rest(f as unknown as typeof fetch).listExpenseCategories({ archived: true });
    expect((f as any).mock.calls[0][0]).toContain("archived=true");
  });

  it("setExpenseCategoryArchived PATCHes the spec's /categories/{id}/status route", async () => {
    const f = vi.fn(async () => jsonResponse(null, 204));
    await rest(f as unknown as typeof fetch).setExpenseCategoryArchived("c1", true);
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toContain("/expenses/categories/c1/status");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ archived: true });
  });

  it("deleteExpense issues a DELETE", async () => {
    const f = vi.fn(async () => jsonResponse(null, 204));
    await rest(f as unknown as typeof fetch).deleteExpense("x1");
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/expenses/x1");
    expect(init.method).toBe("DELETE");
  });

  it("listExpenseCategories unwraps {categories:[…]} and maps id/name/archived", async () => {
    const f = vi.fn(async () =>
      jsonResponse({ categories: [{ id: "c1", name: "Travel", archived: false }] }),
    );
    const out = await rest(f as unknown as typeof fetch).listExpenseCategories();
    expect(out).toEqual({ rows: [{ id: "c1", name: "Travel", archived: false }], truncated: false });
    expect((f as any).mock.calls[0][0]).toContain("/workspaces/ws-1/expenses/categories");
  });

  it("listExpenseCategories also tolerates a plain array", async () => {
    const f = vi.fn(async () => jsonResponse([{ id: "c2", name: "Meals" }]));
    expect(await rest(f as unknown as typeof fetch).listExpenseCategories()).toEqual({
      rows: [{ id: "c2", name: "Meals" }],
      truncated: false,
    });
  });

  it("createExpenseCategory POSTs the name as JSON", async () => {
    const f = vi.fn(async () => jsonResponse({ id: "c9", name: "Software" }));
    const c = await rest(f as unknown as typeof fetch).createExpenseCategory({ name: "Software" });
    expect(c).toEqual({ id: "c9", name: "Software" });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/expenses/categories");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ name: "Software" });
  });

  it("updateExpenseCategory PUTs the provided fields", async () => {
    const f = vi.fn(async () => jsonResponse({ id: "c1", name: "Travel & Lodging" }));
    const c = await rest(f as unknown as typeof fetch).updateExpenseCategory("c1", { name: "Travel & Lodging" });
    expect(c).toEqual({ id: "c1", name: "Travel & Lodging" });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/expenses/categories/c1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ name: "Travel & Lodging" });
  });

  it("deleteExpenseCategory archives (PATCH /status) then DELETEs (Clockify rejects deleting an active category)", async () => {
    const f = vi.fn(async () => jsonResponse(null, 204));
    await rest(f as unknown as typeof fetch).deleteExpenseCategory("c1");
    const calls = (f as any).mock.calls;
    expect(calls.map((c: any) => c[1].method)).toEqual(["PATCH", "DELETE"]);
    expect(calls[0][0]).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/expenses/categories/c1/status");
    expect(JSON.parse(calls[0][1].body)).toEqual({ archived: true });
    expect(calls[1][0]).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/expenses/categories/c1");
  });
});
