import { describe, expect, it, vi } from "vitest";
import { createRestCore } from "../../src/clockify/rest/core.js";
import { makeClientRest } from "../../src/clockify/rest/clients.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const rest = (fetchImpl: typeof fetch) =>
  makeClientRest(
    createRestCore({ apiBase: "https://api.clockify.me/api/v1", auth: { apiKey: "k" }, fetchImpl }),
    "ws-1",
  );

describe("client rest", () => {
  it("listClients paginates and maps id/name/archived; passes filters", async () => {
    const f = vi.fn(async () => jsonResponse([{ id: "c1", name: "Acme", archived: false }]));
    const clients = await rest(f as unknown as typeof fetch).listClients({ name: "Ac", archived: false });
    expect(clients).toEqual([{ id: "c1", name: "Acme", archived: false }]);
    const parsed = new URL((f as any).mock.calls[0][0]);
    expect(parsed.pathname).toBe("/api/v1/workspaces/ws-1/clients");
    expect(parsed.searchParams.get("name")).toBe("Ac");
    expect(parsed.searchParams.get("archived")).toBe("false");
    expect(parsed.searchParams.get("page")).toBe("1");
  });

  it("getClient fetches one, or null on 404", async () => {
    const hit = vi.fn(async () => jsonResponse({ id: "c1", name: "Acme" }));
    expect(await rest(hit as unknown as typeof fetch).getClient("c1")).toEqual({
      id: "c1",
      name: "Acme",
      archived: undefined,
    });
    const miss = vi.fn(async () => jsonResponse({ message: "no" }, 404));
    expect(await rest(miss as unknown as typeof fetch).getClient("cX")).toBeNull();
  });

  it("createClient POSTs the name", async () => {
    const f = vi.fn(async () => jsonResponse({ id: "c9", name: "New" }));
    const c = await rest(f as unknown as typeof fetch).createClient({ name: "New" });
    expect(c).toEqual({ id: "c9", name: "New", archived: undefined });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/clients");
    expect(JSON.parse(init.body)).toEqual({ name: "New" });
  });

  it("updateClient GET-then-merge-PUTs (preserves fields, requires name)", async () => {
    const f = vi.fn(async (_url: string, init: any) =>
      init.method === "GET"
        ? jsonResponse({ id: "c1", name: "Old", note: "vip", archived: false })
        : jsonResponse({ id: "c1", name: "New", note: "vip", archived: false }),
    );
    const updated = await rest(f as unknown as typeof fetch).updateClient("c1", { name: "New" });
    expect(updated).toEqual({ id: "c1", name: "New", archived: false });
    const calls = (f as any).mock.calls;
    expect(calls.map((c: any) => c[1].method)).toEqual(["GET", "PUT"]);
    const putBody = JSON.parse(calls[1][1].body);
    expect(putBody.name).toBe("New");
    expect(putBody.note).toBe("vip"); // preserved
  });

  it("deleteClient archives (GET+PUT name+archived:true) THEN deletes", async () => {
    const f = vi.fn(async (_url: string, init: any) => {
      if (init.method === "GET") return jsonResponse({ id: "c1", name: "Acme", archived: false });
      if (init.method === "PUT") return jsonResponse({ id: "c1", name: "Acme", archived: true });
      return jsonResponse(null, 204); // DELETE
    });
    await rest(f as unknown as typeof fetch).deleteClient("c1");
    const calls = (f as any).mock.calls;
    expect(calls.map((c: any) => c[1].method)).toEqual(["GET", "PUT", "DELETE"]);
    const putBody = JSON.parse(calls[1][1].body);
    expect(putBody.archived).toBe(true);
    expect(putBody.name).toBe("Acme");
    expect(calls[2][0]).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/clients/c1");
  });
});
