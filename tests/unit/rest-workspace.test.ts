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

  it("lists projects and maps clientId + archived", async () => {
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
    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe(
      "https://api.clockify.me/api/v1/workspaces/ws-1/projects?page-size=200&archived=false",
    );
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

  it("deletes a tag", async () => {
    const f = vi.fn(async () => jsonResponse(null, 204));
    await client(f as any).deleteEntity!({ entityType: "tag", id: "t1" });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/tags/t1");
    expect(init.method).toBe("DELETE");
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

  it("lists webhooks, mapping id+name", async () => {
    const f = vi.fn(async () => jsonResponse([{ id: "w1", name: "Deploy hook", url: "https://x" }]));
    const hooks = await client(f as any).listWebhooks();
    expect(hooks).toEqual([{ id: "w1", name: "Deploy hook" }]);
    const [url] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/webhooks");
  });

  it("lists expenses, unwrapping {expenses:[...]} and falling back notes→name", async () => {
    const f = vi.fn(async () => jsonResponse({ expenses: [{ id: "x1", notes: "Taxi" }] }));
    const expenses = await client(f as any).listExpenses();
    expect(expenses).toEqual([{ id: "x1", name: "Taxi" }]);
    const [url] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/expenses");
  });

  it("lists expenses, also accepting a plain array", async () => {
    const f = vi.fn(async () => jsonResponse([{ id: "x2", name: "Hotel" }]));
    expect(await client(f as any).listExpenses()).toEqual([{ id: "x2", name: "Hotel" }]);
  });

  it("updateTimeEntry PUTs only the provided fields and maps the result", async () => {
    const f = vi.fn(async () =>
      jsonResponse({
        id: "e1",
        description: "fixed",
        timeInterval: { start: "2026-06-01T00:00:00Z", end: "2026-06-01T02:00:00Z" },
      }),
    );
    const updated = await client(f as any).updateTimeEntry({
      id: "e1",
      description: "fixed",
      tagIds: ["t1"],
    });
    expect(updated).toMatchObject({ id: "e1", description: "fixed", start: "2026-06-01T00:00:00Z" });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/time-entries/e1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ description: "fixed", tagIds: ["t1"] });
  });
});
