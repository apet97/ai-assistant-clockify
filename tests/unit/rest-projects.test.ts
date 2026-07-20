import { describe, expect, it, vi } from "vitest";
import { createRestCore } from "../../src/clockify/rest/core.js";
import { makeProjectRest } from "../../src/clockify/rest/projects.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const rest = (fetchImpl: typeof fetch) =>
  makeProjectRest(
    createRestCore({ apiBase: "https://api.clockify.me/api/v1", auth: { apiKey: "k" }, fetchImpl }),
    "ws-1",
  );

describe("project rest", () => {
  it("paginates projects until a short page and maps summaries", async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
    const f = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(page1))
      .mockResolvedValueOnce(jsonResponse([{ id: "p200", name: "last", clientId: "c1", archived: false }]));
    const projects = await rest(f as unknown as typeof fetch).listProjects();
    expect(projects.rows).toHaveLength(201);
    expect(projects.rows[200]).toEqual({ id: "p200", name: "last", clientId: "c1", archived: false });
    expect(projects.truncated).toBe(false);
    expect((f as any).mock.calls[0][0]).toContain("page=1");
    expect((f as any).mock.calls[0][0]).toContain("archived=false"); // default filter
    expect((f as any).mock.calls[1][0]).toContain("page=2");
  });

  it("passes name + archived + clientIds filters through", async () => {
    const f = vi.fn(async () => jsonResponse([]));
    await rest(f as unknown as typeof fetch).listProjects({
      name: "Web",
      archived: true,
      clientIds: ["c1", "c2"],
    });
    const url = (f as any).mock.calls[0][0] as string;
    expect(url).toContain("name=Web");
    expect(url).toContain("archived=true");
    expect(url).toContain("clients=c1%2Cc2");
  });

  it("getProject returns the mapped project, or null on 404", async () => {
    const hit = vi.fn(async () => jsonResponse({ id: "p1", name: "Site", clientId: "c1" }));
    expect(await rest(hit as unknown as typeof fetch).getProject("p1")).toEqual({
      id: "p1",
      name: "Site",
      clientId: "c1",
      archived: undefined,
    });
    const miss = vi.fn(async () => jsonResponse({ message: "no" }, 404));
    expect(await rest(miss as unknown as typeof fetch).getProject("pX")).toBeNull();
  });

  it("maps the spec's `billable` flag — the old map DROPPED it, so 'is X billable?' couldn't answer (live item 069)", async () => {
    const hit = vi.fn(async () => jsonResponse({ id: "p1", name: "Site", billable: true }));
    const project = await rest(hit as unknown as typeof fetch).getProject("p1");
    expect(project?.billable).toBe(true);

    const list = vi.fn(async () => jsonResponse([{ id: "p1", name: "Site", billable: false }]));
    const projects = await rest(list as unknown as typeof fetch).listProjects();
    expect(projects.rows[0].billable).toBe(false);
  });

  it("createProject POSTs only the provided fields", async () => {
    const f = vi.fn(async () => jsonResponse({ id: "p9", name: "New", clientId: "c1", isPublic: false }));
    const p = await rest(f as unknown as typeof fetch).createProject({
      name: "New",
      clientId: "c1",
      billable: true,
      color: "#abcdef",
      isPublic: false,
    });
    expect(p).toMatchObject({ id: "p9", name: "New", clientId: "c1", isPublic: false });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/projects");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      name: "New",
      clientId: "c1",
      billable: true,
      color: "#abcdef",
      isPublic: false,
    });
  });

  it("updateProject GET-then-PUTs only the exact UpdateProjectRequest fields", async () => {
    const f = vi.fn(async (_url: string, init: any) =>
      init.method === "GET"
        ? jsonResponse({
            id: "p1",
            workspaceId: "ws-1",
            name: "Old",
            color: "#ffffff",
            archived: false,
            billable: true,
            clientId: "c1",
            note: "keep",
            public: true,
            memberships: [{ userId: "u1" }],
            hourlyRate: { amount: 7_500, since: "2026-01-01T00:00:00.000Z", currency: "USD" },
            costRate: { amount: 4_500, currency: "EUR" },
          })
        : jsonResponse({ id: "p1", name: "New", color: "#ffffff", archived: false, public: false }),
    );
    const updated = await rest(f as unknown as typeof fetch).updateProject("p1", {
      name: "New",
      isPublic: false,
      workspaceId: "must-not-escape",
    });
    expect(updated).toMatchObject({ id: "p1", name: "New", archived: false, isPublic: false });
    const calls = (f as any).mock.calls;
    expect(calls.map((c: any) => c[1].method)).toEqual(["GET", "PUT"]);
    expect(JSON.parse(calls[1][1].body)).toEqual({
      archived: false,
      billable: true,
      clientId: "c1",
      color: "#ffffff",
      costRate: { amount: 4_500 },
      hourlyRate: { amount: 7_500 },
      isPublic: false,
      name: "New",
      note: "keep",
    });
  });

  it("updateProject fails closed on malformed or contradictory fetched replacement state", async () => {
    const update = async (row: Record<string, unknown>) => {
      const f = vi.fn(async (_url: string, init: any) =>
        init.method === "GET" ? jsonResponse(row) : jsonResponse({ id: "p1", name: "Site" }),
      );
      await rest(f as unknown as typeof fetch).updateProject("p1", { billable: false });
    };

    await expect(update({ id: "p1", public: true, isPublic: false, name: "Site" }))
      .rejects.toThrow("public/isPublic");
    await expect(update({ id: "p1", public: true, name: 123 }))
      .rejects.toThrow("name");
    await expect(update({ id: "p1", public: true, name: "Site", color: "#fff" }))
      .rejects.toThrow("color");
    await expect(update({ id: "p1", public: true, name: "Site", archived: null }))
      .rejects.toThrow("archived");
    await expect(update({ id: "p1", public: true, name: "Site", billable: null }))
      .rejects.toThrow("billable");
    await expect(update({ id: "p1", public: null, name: "Site" }))
      .rejects.toThrow("public");
    await expect(update({ id: "p1", isPublic: null, name: "Site" }))
      .rejects.toThrow("isPublic");
    await expect(update({ id: "p1", public: true, name: "Site", hourlyRate: { amount: 2_147_483_648 } }))
      .rejects.toThrow("hourlyRate.amount");
    await expect(update({ id: "p1", public: true, name: "Site", costRate: { amount: 2_147_483_648 } }))
      .rejects.toThrow("costRate.amount");
    await expect(update({ id: "p1", public: true }))
      .rejects.toThrow("name");
  });

  it("preserves the exact rate int32 boundaries and strips response-only rate fields", async () => {
    const f = vi.fn(async (_url: string, init: any) =>
      init.method === "GET"
        ? jsonResponse({
            id: "p1",
            name: "Site",
            hourlyRate: { amount: 0, currency: "USD", since: "2026-01-01T00:00:00Z" },
            costRate: { amount: 2_147_483_647, currency: "EUR", since: "2026-01-01T00:00:00Z" },
          })
        : jsonResponse({ id: "p1", name: "Site" }),
    );

    await rest(f as unknown as typeof fetch).updateProject("p1", { billable: false });

    expect(JSON.parse((f as any).mock.calls[1][1].body)).toEqual({
      billable: false,
      costRate: { amount: 2_147_483_647 },
      hourlyRate: { amount: 0 },
      name: "Site",
    });
  });

  it("archiveProject GET-then-PUTs archived:true", async () => {
    const f = vi.fn(async (_url: string, init: any) =>
      init.method === "GET"
        ? jsonResponse({ id: "p1", name: "Site", archived: false })
        : jsonResponse({ id: "p1", name: "Site", archived: true }),
    );
    const archived = await rest(f as unknown as typeof fetch).archiveProject("p1");
    expect(archived.archived).toBe(true);
    const putBody = JSON.parse((f as any).mock.calls[1][1].body);
    expect(putBody.archived).toBe(true);
    expect(putBody.name).toBe("Site"); // Clockify requires name on the PUT
  });

  it("deleteProject archives THEN deletes", async () => {
    const f = vi.fn(async (_url: string, init: any) => {
      if (init.method === "GET") return jsonResponse({ id: "p1", name: "Site", archived: false });
      if (init.method === "PUT") return jsonResponse({ id: "p1", name: "Site", archived: true });
      return jsonResponse(null, 204); // DELETE
    });
    await rest(f as unknown as typeof fetch).deleteProject("p1");
    const methods = (f as any).mock.calls.map((c: any) => c[1].method);
    expect(methods).toEqual(["GET", "PUT", "DELETE"]); // archive (get+put) then delete
    expect((f as any).mock.calls[2][0]).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/projects/p1");
  });

  it("createProjectFromTemplate POSTs templateProjectId + name (spec CreateProjectFromTemplateV1)", async () => {
    const f = vi.fn(async () => jsonResponse({ id: "p2", name: "Cloned" }));
    const p = await rest(f as unknown as typeof fetch).createProjectFromTemplate({
      templateProjectId: "t1",
      name: "Cloned",
    });
    expect(p.id).toBe("p2");
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/projects/from-template");
    const body = JSON.parse(init.body);
    // Ground truth (openapi.json CreateProjectFromTemplateV1): required = [name, templateProjectId];
    // there is NO `templateId` field — sending it 400s under the spec's shape.
    expect(body).toEqual({ templateProjectId: "t1", name: "Cloned" });
    expect(body).not.toHaveProperty("templateId");
  });

  it("updateProjectRate PUTs amount (minor units) to the hourly-rate endpoint", async () => {
    const f = vi.fn(async () => jsonResponse({}, 200));
    await rest(f as unknown as typeof fetch).updateProjectRate({
      projectId: "p1",
      userId: "u1",
      rateKind: "HOURLY",
      amountMinor: 7500,
      since: "2026-06-01T00:00:00Z",
    });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/projects/p1/users/u1/hourly-rate");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ amount: 7500, since: "2026-06-01T00:00:00Z" });
  });

  it("updateProjectRate routes COST to the cost-rate endpoint", async () => {
    const f = vi.fn(async () => jsonResponse({}, 200));
    await rest(f as unknown as typeof fetch).updateProjectRate({
      projectId: "p1",
      userId: "u1",
      rateKind: "COST",
      amountMinor: 5000,
    });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/projects/p1/users/u1/cost-rate");
    expect(JSON.parse(init.body)).toEqual({ amount: 5000 });
  });

  it("updateProjectEstimate PATCHes /estimate (matches goclmcp)", async () => {
    const f = vi.fn(async () => jsonResponse({ id: "p1" }));
    await rest(f as unknown as typeof fetch).updateProjectEstimate("p1", {
      estimate: { type: "MANUAL", active: true },
    });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/projects/p1/estimate");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ estimate: { type: "MANUAL", active: true } });
  });

  it("updateProjectMemberships PATCHes /memberships (matches goclmcp)", async () => {
    const f = vi.fn(async () => jsonResponse({ id: "p1" }));
    await rest(f as unknown as typeof fetch).updateProjectMemberships("p1", {
      memberships: [{ userId: "u1", membershipStatus: "ACTIVE" }],
    });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/projects/p1/memberships");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body).memberships).toHaveLength(1);
  });
});
