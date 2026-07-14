import { describe, expect, it, vi } from "vitest";
import { createRestCore } from "../../src/clockify/rest/core.js";
import { makeHolidayRest } from "../../src/clockify/rest/holidays.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
const rest = (fetchImpl: typeof fetch) =>
  makeHolidayRest(
    createRestCore({ apiBase: "https://api.clockify.me/api/v1", auth: { apiKey: "k" }, fetchImpl }),
    "ws-1",
  );

describe("holiday rest", () => {
  it("listHolidays GETs the bare array and flattens datePeriod", async () => {
    const f = vi.fn(async () =>
      jsonResponse([{ id: "h1", name: "Xmas", datePeriod: { startDate: "2026-12-25", endDate: "2026-12-25" }, occursAnnually: true }]),
    );
    expect(await rest(f as unknown as typeof fetch).listHolidays()).toEqual({
      rows: [{ id: "h1", name: "Xmas", startDate: "2026-12-25", endDate: "2026-12-25", occursAnnually: true }],
      truncated: false,
    });
    expect(new URL((f as any).mock.calls[0][0]).pathname).toBe("/api/v1/workspaces/ws-1/holidays");
  });

  it("getHoliday finds the holiday in the LIST (no single-GET route)", async () => {
    const f = vi.fn(async () => jsonResponse([{ id: "h1", name: "Xmas" }, { id: "h2", name: "NY" }]));
    expect(await rest(f as unknown as typeof fetch).getHoliday("h2")).toMatchObject({ id: "h2", name: "NY" });
    expect(new URL((f as any).mock.calls[0][0]).pathname).toBe("/api/v1/workspaces/ws-1/holidays");
    const miss = vi.fn(async () => jsonResponse([{ id: "h9", name: "Z" }]));
    expect(await rest(miss as unknown as typeof fetch).getHoliday("h1")).toBeNull();
  });

  it("listHolidaysInPeriod GETs /holidays/in-period, normalizing date-only start/end to full ISO", async () => {
    const f = vi.fn(async () => jsonResponse([{ id: "h1", name: "Xmas" }]));
    await rest(f as unknown as typeof fetch).listHolidaysInPeriod({ assignedTo: "u1", start: "2026-12-01", end: "2026-12-31" });
    const parsed = new URL((f as any).mock.calls[0][0]);
    expect(parsed.pathname).toBe("/api/v1/workspaces/ws-1/holidays/in-period");
    expect(parsed.searchParams.get("assigned-to")).toBe("u1");
    expect(parsed.searchParams.get("start")).toBe("2026-12-01T00:00:00Z");
    expect(parsed.searchParams.get("end")).toBe("2026-12-31T23:59:59.999Z");
  });

  it("createHoliday POSTs name/datePeriod and a users assignment filter", async () => {
    const f = vi.fn(async () => jsonResponse({ id: "h9", name: "Company Day" }));
    const h = await rest(f as unknown as typeof fetch).createHoliday({
      name: "Company Day",
      startDate: "2026-07-01",
      occursAnnually: true,
      userIds: ["u1"],
    });
    expect(h).toEqual({ id: "h9", name: "Company Day" });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/holidays");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.name).toBe("Company Day");
    expect(body.datePeriod).toEqual({ startDate: "2026-07-01", endDate: "2026-07-01" }); // single-day default
    expect(body.occursAnnually).toBe(true);
    expect(body.users).toEqual({ contains: "CONTAINS", ids: ["u1"], status: "ALL" });
  });

  it("updateHoliday GET-scans the existing holiday and PUTs a FULL merged body (replace)", async () => {
    // The holiday PUT is a full replace, so unchanged fields (datePeriod, users)
    // must be carried over from the existing holiday or Clockify 400s "must not be null".
    // The read-back exposes the assignment as flat `userIds`/`userGroupIds` arrays.
    const f = vi.fn(async (_url: string, init: any) =>
      init.method === "GET"
        ? jsonResponse([
            { id: "h1", name: "Old", datePeriod: { startDate: "2026-12-25", endDate: "2026-12-25" }, occursAnnually: true, userIds: ["u1"] },
          ])
        : jsonResponse({ id: "h1", name: "Renamed" }),
    );
    const h = await rest(f as unknown as typeof fetch).updateHoliday("h1", { name: "Renamed" });
    expect(h).toEqual({ id: "h1", name: "Renamed" });
    const calls = (f as any).mock.calls;
    expect(calls.map((c: any) => c[1].method)).toEqual(["GET", "PUT"]);
    expect(calls[1][0]).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/holidays/h1");
    const body = JSON.parse(calls[1][1].body);
    expect(body.name).toBe("Renamed"); // changed
    expect(body.datePeriod).toEqual({ startDate: "2026-12-25", endDate: "2026-12-25" }); // preserved from existing
    expect(body.occursAnnually).toBe(true); // preserved
    expect(body.users).toEqual({ contains: "CONTAINS", ids: ["u1"], status: "ALL" }); // assignment reconstructed from userIds
  });

  it("updateHoliday preserves an 'everyone' assignment (everyoneIncludingNew) with no userIds", async () => {
    const f = vi.fn(async (_url: string, init: any) =>
      init.method === "GET"
        ? jsonResponse([{ id: "h1", name: "Old", datePeriod: { startDate: "2026-12-25", endDate: "2026-12-25" }, everyoneIncludingNew: true }])
        : jsonResponse({ id: "h1", name: "Renamed" }),
    );
    await rest(f as unknown as typeof fetch).updateHoliday("h1", { name: "Renamed" });
    const body = JSON.parse((f as any).mock.calls[1][1].body);
    expect(body.everyoneIncludingNew).toBe(true); // valid assignment preserved
    expect(body.users).toBeUndefined();
  });

  it("updateHoliday throws clearly when the existing holiday has no resolvable assignment", async () => {
    const f = vi.fn(async () => jsonResponse([{ id: "h1", name: "Old", datePeriod: { startDate: "2026-12-25" }, everyoneIncludingNew: false }]));
    await expect(rest(f as unknown as typeof fetch).updateHoliday("h1", { name: "Renamed" })).rejects.toThrow(/assignment/i);
    // it must NOT PUT a body that Clockify would 400
    expect((f as any).mock.calls.map((c: any) => c[1].method)).toEqual(["GET"]);
  });

  it("deleteHoliday DELETEs the holiday", async () => {
    const f = vi.fn(async () => jsonResponse(null, 204));
    await rest(f as unknown as typeof fetch).deleteHoliday("h1");
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/holidays/h1");
    expect(init.method).toBe("DELETE");
  });
});
