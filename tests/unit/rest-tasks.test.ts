import { describe, expect, it, vi } from "vitest";
import { createRestCore } from "../../src/clockify/rest/core.js";
import { makeTaskRest } from "../../src/clockify/rest/tasks.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const rest = (fetchImpl: typeof fetch) =>
  makeTaskRest(
    createRestCore({ apiBase: "https://api.clockify.me/api/v1", auth: { apiKey: "k" }, fetchImpl }),
    "ws-1",
  );

describe("task rest", () => {
  it("listTasks paginates under the project and maps projectId", async () => {
    const f = vi.fn(async () => jsonResponse([{ id: "t1", name: "Design" }]));
    const tasks = await rest(f as unknown as typeof fetch).listTasks("p1");
    expect(tasks).toEqual([{ id: "t1", name: "Design", projectId: "p1" }]);
    const parsed = new URL((f as any).mock.calls[0][0]);
    expect(parsed.pathname).toBe("/api/v1/workspaces/ws-1/projects/p1/tasks");
    expect(parsed.searchParams.get("page")).toBe("1");
  });

  it("listTasks passes a name filter", async () => {
    const f = vi.fn(async () => jsonResponse([]));
    await rest(f as unknown as typeof fetch).listTasks("p1", { name: "Des" });
    expect((f as any).mock.calls[0][0]).toContain("name=Des");
  });

  it("getTask fetches one task, or null on 404", async () => {
    const hit = vi.fn(async () => jsonResponse({ id: "t1", name: "Design" }));
    expect(await rest(hit as unknown as typeof fetch).getTask("p1", "t1")).toEqual({
      id: "t1",
      name: "Design",
      projectId: "p1",
    });
    const miss = vi.fn(async () => jsonResponse({ message: "no" }, 404));
    expect(await rest(miss as unknown as typeof fetch).getTask("p1", "tX")).toBeNull();
  });

  it("createTask POSTs the name under the project", async () => {
    const f = vi.fn(async () => jsonResponse({ id: "t9", name: "QA" }));
    const t = await rest(f as unknown as typeof fetch).createTask({ projectId: "p1", name: "QA" });
    expect(t).toEqual({ id: "t9", name: "QA", projectId: "p1" });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/projects/p1/tasks");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ name: "QA" });
  });

  it("createTask POSTs assigneeIds inline when provided", async () => {
    const f = vi.fn(async () => jsonResponse({ id: "t9", name: "QA", assigneeIds: ["u1", "u2"] }));
    const t = await rest(f as unknown as typeof fetch).createTask({ projectId: "p1", name: "QA", assigneeIds: ["u1", "u2"] });
    expect(t).toEqual({ id: "t9", name: "QA", projectId: "p1", assigneeIds: ["u1", "u2"] });
    expect(JSON.parse((f as any).mock.calls[0][1].body)).toEqual({ name: "QA", assigneeIds: ["u1", "u2"] });
  });

  it("updateTask GET-then-merge-PUTs (requires name; preserves other fields)", async () => {
    const f = vi.fn(async (_url: string, init: any) =>
      init.method === "GET"
        ? jsonResponse({ id: "t1", name: "Old", assigneeIds: ["u1"], status: "ACTIVE" })
        : jsonResponse({ id: "t1", name: "New", assigneeIds: ["u1"], status: "ACTIVE" }),
    );
    const updated = await rest(f as unknown as typeof fetch).updateTask("p1", "t1", { name: "New" });
    expect(updated).toEqual({ id: "t1", name: "New", projectId: "p1", assigneeIds: ["u1"] });
    const calls = (f as any).mock.calls;
    expect(calls.map((c: any) => c[1].method)).toEqual(["GET", "PUT"]);
    const putBody = JSON.parse(calls[1][1].body);
    expect(putBody.name).toBe("New");
    expect(putBody.assigneeIds).toEqual(["u1"]); // preserved
  });

  it("deleteTask marks DONE (PUT) then DELETEs", async () => {
    const f = vi.fn(async (_url: string, init: any) => {
      if (init.method === "GET") return jsonResponse({ id: "t1", name: "Design", status: "ACTIVE" });
      if (init.method === "PUT") return jsonResponse({ id: "t1", name: "Design", status: "DONE" });
      return jsonResponse(null, 204); // DELETE
    });
    await rest(f as unknown as typeof fetch).deleteTask("p1", "t1");
    const calls = (f as any).mock.calls;
    expect(calls.map((c: any) => c[1].method)).toEqual(["GET", "PUT", "DELETE"]);
    const putBody = JSON.parse(calls[1][1].body);
    expect(putBody.status).toBe("DONE");
    expect(putBody.name).toBe("Design");
    expect(calls[2][0]).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/projects/p1/tasks/t1");
  });

  it("updateTaskRate PUTs amount to the task's hourly-rate/cost-rate endpoint", async () => {
    const f = vi.fn(async () => jsonResponse({}, 200));
    await rest(f as unknown as typeof fetch).updateTaskRate({
      projectId: "p1",
      taskId: "t1",
      rateKind: "COST",
      amountMinor: 4200,
      since: "2026-06-01T00:00:00Z",
    });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/projects/p1/tasks/t1/cost-rate");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ amount: 4200, since: "2026-06-01T00:00:00Z" });
  });
});
