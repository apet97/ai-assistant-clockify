import { describe, expect, it, vi } from "vitest";
import { createRestCore } from "../../src/clockify/rest/core.js";
import { makeSchedulingRest } from "../../src/clockify/rest/scheduling.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
const rest = (fetchImpl: typeof fetch) =>
  makeSchedulingRest(
    createRestCore({ apiBase: "https://api.clockify.me/api/v1", auth: { apiKey: "k" }, fetchImpl }),
    "ws-1",
  );

describe("scheduling rest", () => {
  it("listAssignments GETs /scheduling/assignments/all with start/end/user/project + maps", async () => {
    const f = vi.fn(async () =>
      jsonResponse([{ id: "a1", userId: "u1", projectId: "p1", start: "2026-06-01", end: "2026-06-05", hoursPerDay: 8, published: false }]),
    );
    const out = await rest(f as unknown as typeof fetch).listAssignments({ start: "2026-06-01", end: "2026-06-30", userId: "u1", projectId: "p1" });
    expect(out[0]).toMatchObject({ id: "a1", userId: "u1", projectId: "p1", hoursPerDay: 8 });
    const parsed = new URL((f as any).mock.calls[0][0]);
    expect(parsed.pathname).toBe("/api/v1/workspaces/ws-1/scheduling/assignments/all");
    expect(parsed.searchParams.get("start")).toBe("2026-06-01");
    expect(parsed.searchParams.get("userId")).toBe("u1");
    expect(parsed.searchParams.get("projectId")).toBe("p1");
  });

  it("getAssignment list-scans for the id with a default date window (the /all endpoint requires start/end)", async () => {
    const f = vi.fn(async () => jsonResponse([{ id: "a1" }, { id: "a2" }]));
    expect(await rest(f as unknown as typeof fetch).getAssignment("a2")).toMatchObject({ id: "a2" });
    const parsed = new URL((f as any).mock.calls[0][0]);
    expect(parsed.pathname).toBe("/api/v1/workspaces/ws-1/scheduling/assignments/all");
    expect(parsed.searchParams.get("start")).toBeTruthy(); // default window so the endpoint doesn't 400
    expect(parsed.searchParams.get("end")).toBeTruthy();
    const miss = vi.fn(async () => jsonResponse([{ id: "aX" }]));
    expect(await rest(miss as unknown as typeof fetch).getAssignment("a1")).toBeNull();
  });

  it("createAssignment POSTs the recurring assignment", async () => {
    const f = vi.fn(async () => jsonResponse([{ id: "a9", userId: "u1" }]));
    const a = await rest(f as unknown as typeof fetch).createAssignment({
      userId: "u1", projectId: "p1", start: "2026-06-01", end: "2026-06-05", hoursPerDay: 8, note: "sprint",
    });
    expect(a.id).toBe("a9");
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/scheduling/assignments/recurring");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ userId: "u1", projectId: "p1", start: "2026-06-01", end: "2026-06-05", hoursPerDay: 8, note: "sprint" });
  });

  it("updateAssignment GET-scans the existing assignment then PATCHes a FULL body (period required)", async () => {
    // The recurring PATCH is a full replace — it rejects a body without start/end,
    // so update list-scans the existing assignment and re-sends userId/projectId/start/end.
    // The read-back exposes the period as a nested `period:{start,end}` object.
    // Per the OpenAPI spec the PATCH responds with an ARRAY of AssignmentDtoV1
    // (the updated occurrence(s)) — the id comes from its first element.
    const f = vi.fn(async (_url: string, init: any) =>
      init.method === "GET"
        ? jsonResponse([{ id: "a1", userId: "u1", projectId: "p1", period: { start: "2026-06-01", end: "2026-06-05" }, hoursPerDay: 8 }])
        : jsonResponse([{ id: "a1-updated", userId: "u1" }]),
    );
    const updated = await rest(f as unknown as typeof fetch).updateAssignment("a1", { hoursPerDay: 6, seriesUpdateOption: "ALL" });
    expect(updated).toMatchObject({ id: "a1-updated" });
    const calls = (f as any).mock.calls;
    expect(calls.map((c: any) => c[1].method)).toEqual(["GET", "PATCH"]);
    expect(calls[1][0]).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/scheduling/assignments/recurring/a1");
    const body = JSON.parse(calls[1][1].body);
    expect(body.userId).toBe("u1"); // re-sent from existing
    expect(body.projectId).toBe("p1");
    expect(body.start).toBe("2026-06-01"); // top-level start/end reconstructed from period
    expect(body.end).toBe("2026-06-05");
    expect(body.hoursPerDay).toBe(6); // changed
    expect(body.seriesUpdateOption).toBe("ALL");
  });

  it("deleteAssignment DELETEs with the seriesUpdateOption query", async () => {
    const f = vi.fn(async () => jsonResponse(null, 204));
    await rest(f as unknown as typeof fetch).deleteAssignment("a1", "ALL");
    const [url, init] = (f as any).mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/v1/workspaces/ws-1/scheduling/assignments/recurring/a1");
    expect(parsed.searchParams.get("seriesUpdateOption")).toBe("ALL");
    expect(init.method).toBe("DELETE");
  });

  it("publishSchedule PUTs /publish with notifyUsers", async () => {
    const f = vi.fn(async () => jsonResponse(null, 204));
    await rest(f as unknown as typeof fetch).publishSchedule({ start: "2026-06-01", end: "2026-06-07", notifyUsers: true });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/scheduling/assignments/publish");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ start: "2026-06-01", end: "2026-06-07", notifyUsers: true });
  });

  it("getProjectScheduleTotals POSTs the totals search", async () => {
    const f = vi.fn(async () => jsonResponse([{ projectId: "p1", total: 40 }]));
    const out = await rest(f as unknown as typeof fetch).getProjectScheduleTotals({ start: "2026-06-01", end: "2026-06-07", projectId: "p1" });
    expect(out).toEqual([{ projectId: "p1", total: 40 }]);
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/scheduling/assignments/projects/totals");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({ start: "2026-06-01", end: "2026-06-07", projectId: "p1" });
  });

  it("getUserScheduleTotals GETs the user totals", async () => {
    const f = vi.fn(async () => jsonResponse({ userId: "u1", capacity: 40 }));
    const out = await rest(f as unknown as typeof fetch).getUserScheduleTotals("u1", { start: "2026-06-01", end: "2026-06-07" });
    expect(out).toMatchObject({ userId: "u1" });
    const parsed = new URL((f as any).mock.calls[0][0]);
    expect(parsed.pathname).toBe("/api/v1/workspaces/ws-1/scheduling/assignments/users/u1/totals");
    expect(parsed.searchParams.get("start")).toBe("2026-06-01");
  });
});
