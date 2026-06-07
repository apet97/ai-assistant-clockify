import { describe, expect, it, vi } from "vitest";
import { createRestCore } from "../../src/clockify/rest/core.js";
import { makeUserRest } from "../../src/clockify/rest/users.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const rest = (fetchImpl: typeof fetch) =>
  makeUserRest(createRestCore({ apiBase: "https://api.clockify.me/api/v1", auth: { apiKey: "k" }, fetchImpl }), "ws-1");

describe("user & group rest", () => {
  it("listUsers GETs /users and maps name/email/status", async () => {
    const f = vi.fn(async () => jsonResponse([{ id: "u1", name: "Ann", email: "ann@x.com", status: "ACTIVE" }]));
    expect(await rest(f as unknown as typeof fetch).listUsers()).toEqual([{ id: "u1", name: "Ann", email: "ann@x.com", status: "ACTIVE" }]);
    expect(new URL((f as any).mock.calls[0][0]).pathname).toBe("/api/v1/workspaces/ws-1/users");
  });

  it("inviteUser POSTs /users with email + send-email query", async () => {
    const f = vi.fn(async () => jsonResponse({ id: "u9" }));
    await rest(f as unknown as typeof fetch).inviteUser("new@x.com", false);
    const [url, init] = (f as any).mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/v1/workspaces/ws-1/users");
    expect(parsed.searchParams.get("send-email")).toBe("false");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ email: "new@x.com" });
  });

  it("updateUserRole PUTs /users/{id}/roles with {entityId, role}", async () => {
    const f = vi.fn(async () => jsonResponse({}));
    await rest(f as unknown as typeof fetch).updateUserRole("u1", "TEAM_MANAGER", "team1");
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/users/u1/roles");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ entityId: "team1", role: "TEAM_MANAGER" });
  });

  it("deactivateUser PUTs /users/{id} {status:INACTIVE}", async () => {
    const f = vi.fn(async () => jsonResponse({ id: "u1" }));
    await rest(f as unknown as typeof fetch).deactivateUser("u1");
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/users/u1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ status: "INACTIVE" });
  });

  it("listGroups GETs /user-groups; getGroup list-scans", async () => {
    const f = vi.fn(async () => jsonResponse([{ id: "g1", name: "Devs" }, { id: "g2", name: "Ops" }]));
    expect(await rest(f as unknown as typeof fetch).listGroups()).toEqual([{ id: "g1", name: "Devs" }, { id: "g2", name: "Ops" }]);
    expect(new URL((f as any).mock.calls[0][0]).pathname).toBe("/api/v1/workspaces/ws-1/user-groups");
    expect(await rest(f as unknown as typeof fetch).getGroup("g2")).toMatchObject({ id: "g2" });
    const miss = vi.fn(async () => jsonResponse([{ id: "gX" }]));
    expect(await rest(miss as unknown as typeof fetch).getGroup("g1")).toBeNull();
  });

  it("createGroup / updateGroup / deleteGroup hit /user-groups", async () => {
    const c = vi.fn(async () => jsonResponse({ id: "g9", name: "QA" }));
    await rest(c as unknown as typeof fetch).createGroup("QA");
    expect((c as any).mock.calls[0][0]).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/user-groups");
    expect(JSON.parse((c as any).mock.calls[0][1].body)).toEqual({ name: "QA" });

    const u = vi.fn(async () => jsonResponse({ id: "g1", name: "Renamed" }));
    await rest(u as unknown as typeof fetch).updateGroup("g1", "Renamed");
    expect((u as any).mock.calls[0][0]).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/user-groups/g1");
    expect((u as any).mock.calls[0][1].method).toBe("PUT");
    expect(JSON.parse((u as any).mock.calls[0][1].body)).toEqual({ name: "Renamed" });

    const d = vi.fn(async () => jsonResponse(null, 204));
    await rest(d as unknown as typeof fetch).deleteGroup("g1");
    expect((d as any).mock.calls[0][1].method).toBe("DELETE");
  });

  it("addUserToGroup POSTs {userId}; removeUserFromGroup DELETEs the member path", async () => {
    const a = vi.fn(async () => jsonResponse({}));
    await rest(a as unknown as typeof fetch).addUserToGroup("g1", "u1");
    expect((a as any).mock.calls[0][0]).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/user-groups/g1/users");
    expect((a as any).mock.calls[0][1].method).toBe("POST");
    expect(JSON.parse((a as any).mock.calls[0][1].body)).toEqual({ userId: "u1" });

    const r = vi.fn(async () => jsonResponse(null, 204));
    await rest(r as unknown as typeof fetch).removeUserFromGroup("g1", "u1");
    expect((r as any).mock.calls[0][0]).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/user-groups/g1/users/u1");
    expect((r as any).mock.calls[0][1].method).toBe("DELETE");
  });
});
