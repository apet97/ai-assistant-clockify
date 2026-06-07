import { describe, expect, it, vi } from "vitest";
import {
  createRestWorkspaceClient,
  type ClockifyAuth,
} from "../../src/clockify/rest-workspace.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(fetchImpl: typeof fetch, auth: ClockifyAuth = { addonToken: "tok" }) {
  return createRestWorkspaceClient({
    baseUrl: "https://api.clockify.me/api/v1",
    workspaceId: "ws-1",
    auth,
    fetchImpl,
  });
}

describe("rest workspace client", () => {
  it("creates a tag with X-Addon-Token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "t1", name: "Deep Work" }));
    const c = client(fetchImpl as unknown as typeof fetch);
    const tag = await c.createTag({ name: "Deep Work" });
    expect(tag).toEqual({ id: "t1", name: "Deep Work" });
    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/tags");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Addon-Token"]).toBe("tok");
    expect(init.headers["X-Api-Key"]).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({ name: "Deep Work" });
  });

  it("uses X-Api-Key when given an apiKey", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const c = client(fetchImpl as unknown as typeof fetch, { apiKey: "k" });
    await c.listTags();
    const [, init] = (fetchImpl as any).mock.calls[0];
    expect(init.headers["X-Api-Key"]).toBe("k");
    expect(init.headers["X-Addon-Token"]).toBeUndefined();
  });

  it("lists projects (via the typed project module) and maps clientId + archived", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        { id: "p1", name: "Website", clientId: "c1", archived: false },
        { id: "p2", name: "App" },
      ]),
    );
    const c = client(fetchImpl as unknown as typeof fetch);
    const projects = await c.listProjects();
    expect(projects).toEqual([
      { id: "p1", name: "Website", clientId: "c1", archived: false },
      { id: "p2", name: "App", clientId: undefined, archived: undefined },
    ]);
    // Project reads now paginate through the multi-host core (Phase 2 wiring).
    const [url, init] = (fetchImpl as any).mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/v1/workspaces/ws-1/projects");
    expect(parsed.searchParams.get("archived")).toBe("false");
    expect(parsed.searchParams.get("page")).toBe("1");
    expect(parsed.searchParams.get("page-size")).toBe("200");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("maps a running time entry, and returns null when none", async () => {
    const running = vi.fn(async () =>
      jsonResponse([
        { id: "e1", description: "x", timeInterval: { start: "2026-06-05T00:00:00Z", end: null } },
      ]),
    );
    expect(await client(running as any).getRunningTimeEntry("u1")).toMatchObject({
      id: "e1",
      start: "2026-06-05T00:00:00Z",
    });
    const none = vi.fn(async () => jsonResponse([]));
    expect(await client(none as any).getRunningTimeEntry("u1")).toBeNull();
  });

  it("stopTimeEntry returns null on 404 (nothing running)", async () => {
    const f = vi.fn(async () => jsonResponse({ message: "not found" }, 404));
    expect(
      await client(f as any).stopTimeEntry({ userId: "u1", end: "2026-06-05T01:00:00Z" }),
    ).toBeNull();
  });

  it("deletes a tag with a single bare DELETE (no archive needed)", async () => {
    const f = vi.fn(async () => jsonResponse(null, 204));
    await client(f as any).deleteEntity!({ entityType: "tag", id: "t1" });
    expect((f as any).mock.calls.map((c: any) => c[1].method)).toEqual(["DELETE"]);
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/tags/t1");
    expect(init.method).toBe("DELETE");
  });

  it("deleteEntity archives a project BEFORE deleting (Clockify rejects deleting active projects)", async () => {
    const f = vi.fn(async (_url: string, init: any) => {
      if (init.method === "GET") return jsonResponse({ id: "p1", name: "Site", archived: false });
      if (init.method === "PUT") return jsonResponse({ id: "p1", name: "Site", archived: true });
      return jsonResponse(null, 204); // DELETE
    });
    await client(f as any).deleteEntity!({ entityType: "project", id: "p1" });
    expect((f as any).mock.calls.map((c: any) => c[1].method)).toEqual(["GET", "PUT", "DELETE"]);
    const putBody = JSON.parse((f as any).mock.calls[1][1].body);
    expect(putBody.archived).toBe(true);
    expect(putBody.name).toBe("Site");
    expect((f as any).mock.calls[2][0]).toBe(
      "https://api.clockify.me/api/v1/workspaces/ws-1/projects/p1",
    );
  });

  it("deleteEntity archives a client BEFORE deleting (active clients cannot be deleted)", async () => {
    const f = vi.fn(async (_url: string, init: any) => {
      if (init.method === "GET") return jsonResponse({ id: "c1", name: "Acme", archived: false });
      if (init.method === "PUT") return jsonResponse({ id: "c1", name: "Acme", archived: true });
      return jsonResponse(null, 204); // DELETE
    });
    await client(f as any).deleteEntity!({ entityType: "client", id: "c1" });
    expect((f as any).mock.calls.map((c: any) => c[1].method)).toEqual(["GET", "PUT", "DELETE"]);
    const putBody = JSON.parse((f as any).mock.calls[1][1].body);
    expect(putBody.archived).toBe(true);
    expect(putBody.name).toBe("Acme"); // Clockify requires the name on the archive PUT
    expect((f as any).mock.calls[2][0]).toBe(
      "https://api.clockify.me/api/v1/workspaces/ws-1/clients/c1",
    );
  });

  it("throws a clear error for an unsupported delete entity type", async () => {
    const f = vi.fn(async () => jsonResponse(null, 204));
    await expect(
      client(f as any).deleteEntity!({ entityType: "schedule", id: "s1" }),
    ).rejects.toThrow(/schedule/);
    expect((f as any).mock.calls.length).toBe(0);
  });

  it("throws (does not swallow) on a non-404 error status", async () => {
    const f = vi.fn(async () => jsonResponse({ message: "boom" }, 500));
    await expect(client(f as any).listTags()).rejects.toThrow(/500/);
  });

  it("getEntries maps entries and includes start/end query when provided", async () => {
    const f = vi.fn(async () =>
      jsonResponse([
        { id: "e1", description: "a", timeInterval: { start: "2026-06-01T00:00:00Z", end: "2026-06-01T01:00:00Z" } },
        { id: "e2", timeInterval: { start: "2026-06-02T00:00:00Z", end: null } },
      ]),
    );
    const entries = await client(f as any).getEntries({
      userId: "u1",
      start: "2026-06-01T00:00:00Z",
      end: "2026-06-30T00:00:00Z",
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ id: "e1", start: "2026-06-01T00:00:00Z", end: "2026-06-01T01:00:00Z" });
    expect(entries[1].end).toBeNull();
    const [url, init] = (f as any).mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/v1/workspaces/ws-1/user/u1/time-entries");
    expect(parsed.searchParams.get("start")).toBe("2026-06-01T00:00:00Z");
    expect(parsed.searchParams.get("end")).toBe("2026-06-30T00:00:00Z");
    expect(init.method).toBe("GET");
  });

  it("getEntries omits start/end when not provided", async () => {
    const f = vi.fn(async () => jsonResponse([]));
    await client(f as any).getEntries({ userId: "u1" });
    const [url] = (f as any).mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.searchParams.has("start")).toBe(false);
    expect(parsed.searchParams.has("end")).toBe(false);
  });

  it("lists users, mapping id+name", async () => {
    const f = vi.fn(async () => jsonResponse([{ id: "u1", name: "Ada", email: "a@x.io" }]));
    const users = await client(f as any).listUsers();
    expect(users).toEqual([{ id: "u1", name: "Ada" }]);
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/users");
    expect(init.method).toBe("GET");
  });

  // (webhooks are now typed in rest/webhooks.ts — see tests/unit/rest-webhooks.test.ts)

  // (expenses are now typed in rest/expenses.ts — see tests/unit/rest-expenses.test.ts)

  it("updateTimeEntry GET-then-PUTs, preserving start and merging caller fields", async () => {
    // Clockify's PUT /time-entries/{id} REPLACES the entry and requires `start`;
    // a sparse body 400s ("invalid value for field [start]"). The adapter must GET
    // the current entry, flatten timeInterval.start/end to the top level, then PUT.
    const f = vi.fn(async (_url: string, init: any) => {
      if (init.method === "GET") {
        return jsonResponse({
          id: "e1",
          description: "old",
          projectId: "p1",
          billable: true,
          timeInterval: { start: "2026-06-01T00:00:00Z", end: "2026-06-01T01:00:00Z" },
        });
      }
      return jsonResponse({
        id: "e1",
        description: "fixed",
        timeInterval: { start: "2026-06-01T00:00:00Z", end: "2026-06-01T01:00:00Z" },
      });
    });
    const updated = await client(f as any).updateTimeEntry({ id: "e1", description: "fixed" });
    expect(updated).toMatchObject({ id: "e1", description: "fixed", start: "2026-06-01T00:00:00Z" });

    const calls = (f as any).mock.calls;
    expect(calls.map((c: any) => c[1].method)).toEqual(["GET", "PUT"]);
    const [getUrl] = calls[0];
    const [putUrl, putInit] = calls[1];
    expect(getUrl).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/time-entries/e1");
    expect(putUrl).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/time-entries/e1");
    const putBody = JSON.parse(putInit.body);
    expect(putBody.start).toBe("2026-06-01T00:00:00Z"); // preserved from GET (Clockify requires it)
    expect(putBody.end).toBe("2026-06-01T01:00:00Z");
    expect(putBody.description).toBe("fixed"); // caller override applied
    expect(putBody.projectId).toBe("p1"); // unchanged field preserved
  });



  // (invoice create is now typed in rest/invoices.ts — see tests/unit/rest-invoices.test.ts)

  it("updateEntity GET-then-merge-PUTs for project", async () => {
    const f = vi.fn(async (_url: string, init: any) =>
      init.method === "GET"
        ? jsonResponse({ id: "p1", name: "Old", color: "#fff", archived: false })
        : jsonResponse({ id: "p1", name: "New Site" }),
    );
    const updated = await client(f as any).updateEntity!({
      entityType: "project",
      id: "p1",
      fields: { name: "New Site" },
    });
    expect(updated).toEqual({ id: "p1", name: "New Site" });
    const calls = (f as any).mock.calls;
    expect(calls.map((c: any) => c[1].method)).toEqual(["GET", "PUT"]);
    const putBody = JSON.parse(calls[1][1].body);
    expect(putBody.name).toBe("New Site"); // caller override
    expect(putBody.color).toBe("#fff"); // preserved from GET
  });

  it("updateEntity throws a clear error for task (needs projectId) and other unsupported types", async () => {
    const f = vi.fn(async () => jsonResponse({}));
    await expect(
      client(f as any).updateEntity!({ entityType: "task", id: "t1", fields: { name: "x" } }),
    ).rejects.toThrow(/task/);
    expect((f as any).mock.calls.length).toBe(0);
  });

  // (expense create/update/delete are now typed in rest/expenses.ts — see tests/unit/rest-expenses.test.ts)

  // (time-off approve/deny are now typed in rest/time-off.ts — see tests/unit/rest-time-off.test.ts)

  // (scheduling publish is now typed in rest/scheduling.ts — see tests/unit/rest-scheduling.test.ts)
});
