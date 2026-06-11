import { describe, expect, it, vi } from "vitest";
import { createRestCore } from "../../src/clockify/rest/core.js";

function res(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("rest core host routing + auth", () => {
  it("routes /reports/* to the reports host and keeps the add-on auth header", async () => {
    const fetchImpl = vi.fn(async () => res({ ok: true }));
    const core = createRestCore({
      apiBase: "https://api.clockify.me/api/v1",
      auth: { addonToken: "tok" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await core.call("reports", "POST", "/workspaces/ws-1/reports/summary", { a: 1 });
    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe("https://reports.api.clockify.me/v1/workspaces/ws-1/reports/summary");
    expect(init.headers["X-Addon-Token"]).toBe("tok");
    expect(init.headers["X-Api-Key"]).toBeUndefined();
  });

  it("routes audit to the auditlog host and uses the api-key header", async () => {
    const fetchImpl = vi.fn(async () => res([]));
    const core = createRestCore({
      apiBase: "https://api.clockify.me/api/v1",
      auth: { apiKey: "k" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await core.call("audit", "POST", "/workspaces/ws-1/audit-log", {});
    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe("https://auditlog-api.api.clockify.me/v1/workspaces/ws-1/audit-log");
    expect(init.headers["X-Api-Key"]).toBe("k");
    expect(init.headers["X-Addon-Token"]).toBeUndefined();
  });

  it("surfaces a clean error (and never fetches) when the audit host is unavailable on a dev/path host", async () => {
    const fetchImpl = vi.fn(async () => res({ ok: true }));
    const core = createRestCore({
      apiBase: "https://developer.clockify.me/api/v1", // dev: no audit subdomain exists
      auth: { addonToken: "tok" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(core.call("audit", "POST", "/workspaces/ws-1/audit-log", {})).rejects.toThrow(
      /audit log is not available/i,
    );
    expect(fetchImpl).not.toHaveBeenCalled(); // a guessed host must never be hit (no "fetch failed")
  });

  it("uses an explicit auditBase when provided (overrides derivation)", async () => {
    const fetchImpl = vi.fn(async () => res([]));
    const core = createRestCore({
      apiBase: "https://developer.clockify.me/api/v1",
      auditBase: "https://auditlog-api.api.clockify.me/v1",
      auth: { addonToken: "tok" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await core.call("audit", "POST", "/workspaces/ws-1/audit-log", {});
    const [url] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe("https://auditlog-api.api.clockify.me/v1/workspaces/ws-1/audit-log");
  });

  it("derives sibling hosts from a non-default api base (never hardcodes the tenant)", async () => {
    const fetchImpl = vi.fn(async () => res({ ok: true }));
    const core = createRestCore({
      apiBase: "https://api.clockify.me/api/v1",
      auth: { addonToken: "tok" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await core.call("api", "GET", "/workspaces/ws-1/projects");
    const [url] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/projects");
  });

  it("returns null on 204 and throws on a non-204 error", async () => {
    const core = createRestCore({
      apiBase: "https://api.clockify.me/api/v1",
      auth: { apiKey: "k" },
      fetchImpl: (async () => res(null, 204)) as unknown as typeof fetch,
    });
    expect(await core.call("api", "DELETE", "/x")).toBeNull();
    const bad = createRestCore({
      apiBase: "https://api.clockify.me/api/v1",
      auth: { apiKey: "k" },
      fetchImpl: (async () => res({ message: "boom" }, 500)) as unknown as typeof fetch,
    });
    await expect(bad.call("api", "GET", "/x")).rejects.toThrow(/500/);
  });

  it("honors allow404 by returning null instead of throwing", async () => {
    const core = createRestCore({
      apiBase: "https://api.clockify.me/api/v1",
      auth: { apiKey: "k" },
      fetchImpl: (async () => res({ message: "nope" }, 404)) as unknown as typeof fetch,
    });
    expect(await core.call("api", "GET", "/missing", undefined, true)).toBeNull();
    await expect(core.call("api", "GET", "/missing")).rejects.toThrow(/404/);
  });

  it("maps the add-on token's 401 'API is not accessible' to an actionable restriction message (probed live: webhooks + custom-field management are outside the add-on token's reach regardless of scopes)", async () => {
    const core = createRestCore({
      apiBase: "https://api.clockify.me/api/v1",
      auth: { addonToken: "tok" },
      fetchImpl: (async () => res({ message: "API is not accessible.", code: 401 }, 401)) as unknown as typeof fetch,
    });
    await expect(core.call("api", "GET", "/workspaces/ws-1/webhooks")).rejects.toThrow(
      /Clockify does not allow add-ons to call/,
    );
  });

  it("keeps the raw 401 for API-key auth (dev scripts must see the unmapped truth)", async () => {
    const core = createRestCore({
      apiBase: "https://api.clockify.me/api/v1",
      auth: { apiKey: "k" },
      fetchImpl: (async () => res({ message: "API is not accessible.", code: 401 }, 401)) as unknown as typeof fetch,
    });
    await expect(core.call("api", "GET", "/workspaces/ws-1/webhooks")).rejects.toThrow(/401: .*API is not accessible/);
  });

  it("paginate loops page/page-size until a short page and concatenates rows", async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => ({ id: `p${i}` }));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(page1))
      .mockResolvedValueOnce(res([{ id: "p200" }]));
    const core = createRestCore({
      apiBase: "https://api.clockify.me/api/v1",
      auth: { apiKey: "k" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const rows = await core.paginate("api", "/workspaces/ws-1/projects", { archived: "false" });
    expect(rows).toHaveLength(201);
    const url1 = (fetchImpl as any).mock.calls[0][0] as string;
    const url2 = (fetchImpl as any).mock.calls[1][0] as string;
    expect(url1).toContain("page=1");
    expect(url1).toContain("page-size=200");
    expect(url1).toContain("archived=false");
    expect(url2).toContain("page=2");
  });

  it("paginate appends its query with & when the path already has a query string", async () => {
    const fetchImpl = vi.fn(async () => res([]));
    const core = createRestCore({
      apiBase: "https://api.clockify.me/api/v1",
      auth: { apiKey: "k" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await core.paginate("api", "/workspaces/ws-1/projects?hydrated=true");
    const url = (fetchImpl as any).mock.calls[0][0] as string;
    expect(url).toContain("/projects?hydrated=true&");
    expect(url).toContain("page=1");
  });

  it("getThenPut GETs the resource, merges the patch, and PUTs the full body", async () => {
    const calls: Array<{ method: string }> = [];
    const fetchImpl = vi.fn(async (_url: string, init: any) => {
      calls.push({ method: init.method });
      if (init.method === "GET") return res({ id: "p1", name: "Old", color: "#fff" });
      return res({ id: "p1", name: "New", color: "#fff" });
    });
    const core = createRestCore({
      apiBase: "https://api.clockify.me/api/v1",
      auth: { apiKey: "k" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await core.getThenPut("api", "/workspaces/ws-1/projects/p1", { name: "New" });
    expect(out).toEqual({ id: "p1", name: "New", color: "#fff" });
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
    const putBody = JSON.parse((fetchImpl as any).mock.calls[1][1].body);
    expect(putBody).toEqual({ id: "p1", name: "New", color: "#fff" }); // merged
  });

  it("getBinary GETs raw bytes + content-type and throws on a non-ok status", async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    const fetchImpl = vi.fn(
      async () => new Response(pdf.buffer as ArrayBuffer, { status: 200, headers: { "content-type": "application/pdf" } }),
    );
    const core = createRestCore({
      apiBase: "https://api.clockify.me/api/v1",
      auth: { apiKey: "k" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await core.getBinary("api", "/workspaces/ws-1/invoices/inv1/export?format=PDF");
    expect(out.contentType).toBe("application/pdf");
    expect(Array.from(out.bytes)).toEqual([0x25, 0x50, 0x44, 0x46]);
    const [, init] = (fetchImpl as any).mock.calls[0];
    expect(init.headers["X-Api-Key"]).toBe("k");

    const bad = createRestCore({
      apiBase: "https://api.clockify.me/api/v1",
      auth: { apiKey: "k" },
      fetchImpl: (async () => res({ message: "boom" }, 500)) as unknown as typeof fetch,
    });
    await expect(bad.getBinary("api", "/x")).rejects.toThrow(/500/);
  });

  it("getBinary maps the add-on token's 401 'API is not accessible' to the named restriction (parity with call)", async () => {
    const core = createRestCore({
      apiBase: "https://api.clockify.me/api/v1",
      auth: { addonToken: "tok" },
      fetchImpl: (async () => res({ message: "API is not accessible.", code: 401 }, 401)) as unknown as typeof fetch,
    });
    await expect(core.getBinary("api", "/workspaces/ws-1/invoices/inv1/export?format=PDF")).rejects.toThrow(
      /Clockify does not allow add-ons to call/,
    );
  });

  it("getBinary keeps the raw 401 for API-key auth (dev scripts must see the unmapped truth)", async () => {
    const core = createRestCore({
      apiBase: "https://api.clockify.me/api/v1",
      auth: { apiKey: "k" },
      fetchImpl: (async () => res({ message: "API is not accessible.", code: 401 }, 401)) as unknown as typeof fetch,
    });
    await expect(core.getBinary("api", "/workspaces/ws-1/invoices/inv1/export?format=PDF")).rejects.toThrow(
      /401: .*API is not accessible/,
    );
  });

  it("postForm sends a FormData body without a JSON content-type", async () => {
    const fetchImpl = vi.fn(async () => res({ id: "x1" }));
    const core = createRestCore({
      apiBase: "https://api.clockify.me/api/v1",
      auth: { apiKey: "k" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await core.postForm("api", "/workspaces/ws-1/expenses", { userId: "u1", amount: "20" });
    const [, init] = (fetchImpl as any).mock.calls[0];
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.headers["content-type"]).toBeUndefined();
    expect((init.body as FormData).get("userId")).toBe("u1");
    expect((init.body as FormData).get("amount")).toBe("20");
  });
});
