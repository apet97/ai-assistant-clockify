import { describe, expect, it, vi } from "vitest";
import { createRestCore, withMutationPlanScope } from "../../src/clockify/rest/core.js";
import { withHostCallBudget } from "../../src/clockify/request-governor.js";
import { makeUserRest } from "../../src/clockify/rest/users.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const rest = (fetchImpl: typeof fetch) =>
  makeUserRest(createRestCore({ apiBase: "https://api.clockify.me/api/v1", auth: { apiKey: "k" }, fetchImpl }), "ws-1");

describe("user & group rest", () => {
  it("reads a member beyond the normal 200-row page in one probed 5,000-row workspace-membership GET", async () => {
    const rows = Array.from({ length: 249 }, (_, index) => ({ id: `user-${index}`, role: "USER" }));
    rows.push({
      id: "user-249",
      roles: [
        { role: "PROJECT_MANAGER", entity: { id: "project-1", type: "PROJECT" } },
        { role: "WORKSPACE_ADMIN", entities: [{ id: "ws-1" }] },
      ],
    } as never);
    const f = vi.fn(async (url: string | URL | Request) => {
      const pageSize = Number(new URL(String(url)).searchParams.get("page-size"));
      return jsonResponse(rows.slice(0, pageSize));
    });

    await expect(rest(f as unknown as typeof fetch).getWorkspaceMemberRole("user-249"))
      .resolves.toBe("ADMIN");
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = (f as any).mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/v1/workspaces/ws-1/users");
    expect(parsed.searchParams.get("page")).toBe("1");
    expect(parsed.searchParams.get("page-size")).toBe("5000");
    expect(parsed.searchParams.get("memberships")).toBe("WORKSPACE");
    expect(parsed.searchParams.get("include-roles")).toBe("true");
    expect(init.method).toBe("GET");
  });

  it("fits the same beyond-row-200 role lookup in one prepared-operation reservation", async () => {
    const rows = Array.from({ length: 249 }, (_, index) => ({ id: `user-${index}`, role: "USER" }));
    rows.push({ id: "user-249", role: "ADMIN" });
    const f = vi.fn(async (url: string | URL | Request) => {
      const pageSize = Number(new URL(String(url)).searchParams.get("page-size"));
      return jsonResponse(rows.slice(0, pageSize));
    });
    const client = rest(f as unknown as typeof fetch);

    await expect(withHostCallBudget(() => withMutationPlanScope({
      actionName: "role-boundary-test",
      plan: { mode: "single", maxHostCalls: 1, steps: [{ id: "write", kind: "primary" }] },
    }, () => client.getWorkspaceMemberRole("user-249"))))
      .resolves.toBe("ADMIN");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("decodes the live workspace-scoped roles[].entities[] response shape", async () => {
    const f = vi.fn(async () => jsonResponse([{
      id: "owner-1",
      memberships: [{
        userId: "owner-1",
        targetId: "ws-1",
        membershipType: "WORKSPACE",
        membershipStatus: "ACTIVE",
      }],
      roles: [{
        formatterRoleName: "Admin",
        role: "WORKSPACE_OWN",
        entities: [{ id: "ws-1", name: "", membershipStatus: "", source: null }],
      }],
    }]));

    await expect(rest(f as unknown as typeof fetch).getWorkspaceMemberRole("owner-1"))
      .resolves.toBe("OWNER");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("returns an explicit non-admin verdict when the exact live member row has no workspace admin role", async () => {
    const f = vi.fn(async () => jsonResponse([{
      id: "demoted-1",
      memberships: [{
        userId: "demoted-1",
        targetId: "ws-1",
        membershipType: "WORKSPACE",
        membershipStatus: "ACTIVE",
      }],
      roles: [],
    }]));

    await expect(rest(f as unknown as typeof fetch).getWorkspaceMemberRole("demoted-1"))
      .resolves.toBe("MEMBER");
  });

  it("listUsers GETs /users and maps name/email/status", async () => {
    const f = vi.fn(async () => jsonResponse([{ id: "u1", name: "Ann", email: "ann@x.com", status: "ACTIVE" }]));
    expect(await rest(f as unknown as typeof fetch).listUsers()).toEqual({ rows: [{ id: "u1", name: "Ann", email: "ann@x.com", status: "ACTIVE" }], truncated: false });
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

  it("updateUserRole POSTs /users/{id}/roles with {entityId, role} (the route has no PUT — spec + goclmcp pin POST)", async () => {
    const f = vi.fn(async () => jsonResponse({}));
    await rest(f as unknown as typeof fetch).updateUserRole("u1", "TEAM_MANAGER", "team1");
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/users/u1/roles");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ entityId: "team1", role: "TEAM_MANAGER" });
  });

  it("reads exact scoped role assignments and Team-section rates for mutation snapshots", async () => {
    const f = vi.fn(async () => jsonResponse([{
      id: "u1",
      name: "Ann",
      roles: [
        { role: "TEAM_MANAGER", entityId: "g1", sourceType: "USER_GROUP" },
        { role: "PROJECT_MANAGER", entity: { id: "p1", type: "PROJECT" } },
      ],
      hourlyRate: { amount: 7500, since: "2026-01-01" },
      costRate: { amount: 3000 },
    }]));
    const client = rest(f as unknown as typeof fetch);

    expect(await client.listUserRoleAssignments("u1")).toEqual({
      rows: [
        { role: "TEAM_MANAGER", entityId: "g1", sourceType: "USER_GROUP" },
        { role: "PROJECT_MANAGER", entityId: "p1" },
      ],
      truncated: false,
    });
    expect(await client.getWorkspaceMemberRate("u1", "HOURLY")).toEqual({
      userId: "u1",
      rateKind: "HOURLY",
      amountMinor: 7500,
      since: "2026-01-01",
    });
  });

  it("updateWorkspaceMemberRate PUTs amount (minor units) to /users/{id}/{hourly-rate|cost-rate}", async () => {
    const h = vi.fn(async () => jsonResponse({}));
    await rest(h as unknown as typeof fetch).updateWorkspaceMemberRate({ userId: "u1", rateKind: "HOURLY", amountMinor: 7500 });
    let [url, init] = (h as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/users/u1/hourly-rate");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ amount: 7500 });

    const c = vi.fn(async () => jsonResponse({}));
    await rest(c as unknown as typeof fetch).updateWorkspaceMemberRate({ userId: "u1", rateKind: "COST", amountMinor: 3000, since: "2026-01-01" });
    [url, init] = (c as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/users/u1/cost-rate");
    expect(JSON.parse(init.body)).toEqual({ amount: 3000, since: "2026-01-01" });

    const hourly = vi.fn(async () => jsonResponse({}));
    await rest(hourly as unknown as typeof fetch).updateWorkspaceMemberHourlyRateAtomic({ userId: "u1", amountMinor: 7500 });
    expect((hourly as any).mock.calls[0][0]).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/users/u1/hourly-rate");

    const cost = vi.fn(async () => jsonResponse({}));
    await rest(cost as unknown as typeof fetch).updateWorkspaceMemberCostRateAtomic({ userId: "u1", amountMinor: 3000, since: "2026-01-01" });
    expect((cost as any).mock.calls[0][0]).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/users/u1/cost-rate");
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
    expect(await rest(f as unknown as typeof fetch).listGroups()).toEqual({ rows: [{ id: "g1", name: "Devs" }, { id: "g2", name: "Ops" }], truncated: false });
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
