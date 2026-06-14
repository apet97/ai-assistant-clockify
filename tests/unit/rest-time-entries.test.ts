import { describe, expect, it, vi } from "vitest";
import { createRestCore } from "../../src/clockify/rest/core.js";
import { makeTimeEntryRest } from "../../src/clockify/rest/time-entries.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const rest = (fetchImpl: typeof fetch) =>
  makeTimeEntryRest(
    createRestCore({ apiBase: "https://api.clockify.me/api/v1", auth: { apiKey: "k" }, fetchImpl }),
    "ws-1",
  );

describe("time-entry rest", () => {
  it("getEntry fetches a single entry by id and maps it, or null on 404", async () => {
    const hit = vi.fn(async () =>
      jsonResponse({
        id: "e1",
        description: "Deep work",
        projectId: "p1",
        timeInterval: { start: "2026-06-01T00:00:00Z", end: "2026-06-01T01:00:00Z" },
      }),
    );
    expect(await rest(hit as unknown as typeof fetch).getEntry("e1")).toMatchObject({
      id: "e1",
      description: "Deep work",
      start: "2026-06-01T00:00:00Z",
      end: "2026-06-01T01:00:00Z",
    });
    const [url] = (hit as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/time-entries/e1");

    const miss = vi.fn(async () => jsonResponse({ message: "no" }, 404));
    expect(await rest(miss as unknown as typeof fetch).getEntry("eX")).toBeNull();
  });

  it("getEntries paginates the user-scoped endpoint and passes filters", async () => {
    const f = vi.fn(async () =>
      jsonResponse([
        { id: "e1", timeInterval: { start: "2026-06-01T00:00:00Z", end: "2026-06-01T01:00:00Z" } },
      ]),
    );
    const { entries, truncated } = await rest(f as unknown as typeof fetch).getEntries({
      userId: "u1",
      start: "2026-06-01T00:00:00Z",
      end: "2026-06-30T00:00:00Z",
      projectId: "p1",
      taskId: "t1",
    });
    expect(entries).toHaveLength(1);
    expect(truncated).toBe(false); // a single short page is the natural end, not the backstop
    const parsed = new URL((f as any).mock.calls[0][0]);
    expect(parsed.pathname).toBe("/api/v1/workspaces/ws-1/user/u1/time-entries");
    expect(parsed.searchParams.get("start")).toBe("2026-06-01T00:00:00Z");
    expect(parsed.searchParams.get("end")).toBe("2026-06-30T00:00:00Z");
    expect(parsed.searchParams.get("project")).toBe("p1");
    expect(parsed.searchParams.get("task")).toBe("t1");
    expect(parsed.searchParams.get("page")).toBe("1");
  });

  it("getEntries omits filters when not provided", async () => {
    const f = vi.fn(async () => jsonResponse([]));
    await rest(f as unknown as typeof fetch).getEntries({ userId: "u1" });
    const parsed = new URL((f as any).mock.calls[0][0]);
    expect(parsed.searchParams.has("start")).toBe(false);
    expect(parsed.searchParams.has("project")).toBe(false);
  });

  it("getRunningTimeEntry returns the in-progress entry, or null when none", async () => {
    const running = vi.fn(async () =>
      jsonResponse([{ id: "e1", timeInterval: { start: "2026-06-05T00:00:00Z", end: null } }]),
    );
    expect(await rest(running as unknown as typeof fetch).getRunningTimeEntry("u1")).toMatchObject({
      id: "e1",
    });
    const [url] = (running as any).mock.calls[0];
    expect(url).toContain("/user/u1/time-entries");
    expect(url).toContain("in-progress=true");
    const none = vi.fn(async () => jsonResponse([]));
    expect(await rest(none as unknown as typeof fetch).getRunningTimeEntry("u1")).toBeNull();
  });

  it("stopTimeEntry PATCHes the user endpoint and returns null on 404", async () => {
    const f = vi.fn(async () => jsonResponse({ id: "e1", timeInterval: { start: "s", end: "e" } }));
    const stopped = await rest(f as unknown as typeof fetch).stopTimeEntry({ userId: "u1", end: "e" });
    expect(stopped?.id).toBe("e1");
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/user/u1/time-entries");
    expect(init.method).toBe("PATCH");

    const none = vi.fn(async () => jsonResponse({ message: "nothing" }, 404));
    expect(
      await rest(none as unknown as typeof fetch).stopTimeEntry({ userId: "u1", end: "e" }),
    ).toBeNull();
  });

  it("updateTimeEntry GET-then-PUTs, preserving start and merging caller fields", async () => {
    const f = vi.fn(async (_url: string, init: any) =>
      init.method === "GET"
        ? jsonResponse({
            id: "e1",
            description: "old",
            projectId: "p1",
            billable: true,
            timeInterval: { start: "2026-06-01T00:00:00Z", end: "2026-06-01T01:00:00Z" },
          })
        : jsonResponse({ id: "e1", description: "fixed", timeInterval: { start: "2026-06-01T00:00:00Z", end: "2026-06-01T01:00:00Z" } }),
    );
    const updated = await rest(f as unknown as typeof fetch).updateTimeEntry({ id: "e1", description: "fixed" });
    expect(updated).toMatchObject({ id: "e1", description: "fixed", start: "2026-06-01T00:00:00Z" });
    const calls = (f as any).mock.calls;
    expect(calls.map((c: any) => c[1].method)).toEqual(["GET", "PUT"]);
    const putBody = JSON.parse(calls[1][1].body);
    expect(putBody.start).toBe("2026-06-01T00:00:00Z");
    expect(putBody.description).toBe("fixed");
    expect(putBody.projectId).toBe("p1"); // preserved
    expect(putBody.billable).toBe(true); // preserved when not provided
  });

  it("updateTimeEntry can flip billable (caller value wins over the preserved one)", async () => {
    const f = vi.fn(async (_url: string, init: any) =>
      init.method === "GET"
        ? jsonResponse({ id: "e1", billable: false, timeInterval: { start: "2026-06-01T00:00:00Z" } })
        : jsonResponse({ id: "e1", billable: true, timeInterval: { start: "2026-06-01T00:00:00Z" } }),
    );
    const updated = await rest(f as unknown as typeof fetch).updateTimeEntry({ id: "e1", billable: true });
    expect(updated.billable).toBe(true);
    const putBody = JSON.parse((f as any).mock.calls[1][1].body);
    expect(putBody.billable).toBe(true);
  });

  it("markEntriesInvoiced PATCHes /time-entries/invoiced with timeEntryIds + invoiced", async () => {
    const f = vi.fn(async () => jsonResponse(null, 200));
    await rest(f as unknown as typeof fetch).markEntriesInvoiced({ ids: ["e1", "e2"], invoiced: true });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/time-entries/invoiced");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ timeEntryIds: ["e1", "e2"], invoiced: true });
  });

  it("createTimeEntry / startTimeEntry POST to /time-entries", async () => {
    const f = vi.fn(async () => jsonResponse({ id: "e9", timeInterval: { start: "s", end: "e" } }));
    await rest(f as unknown as typeof fetch).createTimeEntry({ description: "x", start: "s", end: "e" });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/time-entries");
    expect(init.method).toBe("POST");
  });
});
