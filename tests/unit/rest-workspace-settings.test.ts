import { describe, expect, it, vi } from "vitest";
import { createRestCore } from "../../src/clockify/rest/core.js";
import { makeWorkspaceRest } from "../../src/clockify/rest/workspace.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const rest = (fetchImpl: typeof fetch) =>
  makeWorkspaceRest(createRestCore({ apiBase: "https://api.clockify.me/api/v1", auth: { apiKey: "k" }, fetchImpl }), "ws-1");

describe("workspace & template rest", () => {
  it("getWorkspace finds the current workspace in GET /workspaces", async () => {
    const f = vi.fn(async () => jsonResponse([{ id: "ws-1", name: "Acme", currencies: [{ code: "GBP", isDefault: true }] }, { id: "ws-2", name: "Other" }]));
    const ws = (await rest(f as unknown as typeof fetch).getWorkspace()) as any;
    expect(ws).toMatchObject({ id: "ws-1", name: "Acme" });
    expect(new URL((f as any).mock.calls[0][0]).pathname).toBe("/api/v1/workspaces");
  });

  it("listTemplates GETs /projects?is-template=true and maps", async () => {
    const f = vi.fn(async () => jsonResponse([{ id: "t1", name: "Sprint template", archived: false }]));
    const out = await rest(f as unknown as typeof fetch).listTemplates();
    expect(out).toEqual([{ id: "t1", name: "Sprint template", archived: false }]);
    const parsed = new URL((f as any).mock.calls[0][0]);
    expect(parsed.pathname).toBe("/api/v1/workspaces/ws-1/projects");
    expect(parsed.searchParams.get("is-template")).toBe("true");
  });

  it("getTemplate GETs the project by id, or null on 404", async () => {
    const hit = vi.fn(async () => jsonResponse({ id: "t1", name: "Sprint template" }));
    expect(await rest(hit as unknown as typeof fetch).getTemplate("t1")).toMatchObject({ id: "t1", name: "Sprint template" });
    expect(new URL((hit as any).mock.calls[0][0]).pathname).toBe("/api/v1/workspaces/ws-1/projects/t1");
    const miss = vi.fn(async () => jsonResponse({ message: "no" }, 404));
    expect(await rest(miss as unknown as typeof fetch).getTemplate("tX")).toBeNull();
  });
});
