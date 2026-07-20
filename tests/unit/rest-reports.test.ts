import { describe, expect, it, vi } from "vitest";
import { createRestCore } from "../../src/clockify/rest/core.js";
import { makeReportRest } from "../../src/clockify/rest/reports.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const rest = (fetchImpl: typeof fetch, enforceMutationScope = false) =>
  makeReportRest(createRestCore({
    apiBase: "https://api.clockify.me/api/v1",
    auth: { apiKey: "k" },
    fetchImpl,
    enforceMutationScope,
  }), "ws-1");
const range = { dateRangeStart: "2026-06-01T00:00:00Z", dateRangeEnd: "2026-06-30T23:59:59Z" };

describe("report rest (multi-host: reports host)", () => {
  it("treats POST report searches as reads when production mutation-scope enforcement is enabled", async () => {
    const f = vi.fn(async () => jsonResponse({ totals: [] }));

    await expect(rest(f as unknown as typeof fetch, true).summaryReport(range, ["PROJECT"]))
      .resolves.toEqual({ totals: [] });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("summaryReport POSTs to the REPORTS host with the JSON export + summaryFilter groups", async () => {
    const f = vi.fn(async () => jsonResponse({ totals: [] }));
    await rest(f as unknown as typeof fetch).summaryReport(range, ["PROJECT"]);
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://reports.api.clockify.me/v1/workspaces/ws-1/reports/summary");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ dateRangeStart: range.dateRangeStart, dateRangeEnd: range.dateRangeEnd, dateRangeType: "ABSOLUTE", exportType: "JSON", summaryFilter: { groups: ["PROJECT"] } });
  });

  it("summaryReport defaults groups to PROJECT", async () => {
    const f = vi.fn(async () => jsonResponse({}));
    await rest(f as unknown as typeof fetch).summaryReport(range);
    expect(JSON.parse((f as any).mock.calls[0][1].body).summaryFilter.groups).toEqual(["PROJECT"]);
  });

  it("detailedReport POSTs /reports/detailed on the reports host with a detailedFilter", async () => {
    const f = vi.fn(async () => jsonResponse({ timeentries: [] }));
    await rest(f as unknown as typeof fetch).detailedReport(range);
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://reports.api.clockify.me/v1/workspaces/ws-1/reports/detailed");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({ exportType: "JSON", detailedFilter: { page: 1 } });
  });

  it("weeklyReport POSTs /reports/weekly on the reports host with a weeklyFilter", async () => {
    const f = vi.fn(async () => jsonResponse({}));
    await rest(f as unknown as typeof fetch).weeklyReport(range);
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://reports.api.clockify.me/v1/workspaces/ws-1/reports/weekly");
    expect(JSON.parse(init.body)).toMatchObject({ exportType: "JSON", weeklyFilter: { group: "PROJECT" } });
  });
});
