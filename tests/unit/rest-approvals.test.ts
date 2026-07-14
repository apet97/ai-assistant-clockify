import { describe, expect, it, vi } from "vitest";
import { createRestCore } from "../../src/clockify/rest/core.js";
import { makeApprovalRest } from "../../src/clockify/rest/approvals.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const rest = (fetchImpl: typeof fetch) =>
  makeApprovalRest(createRestCore({ apiBase: "https://api.clockify.me/api/v1", auth: { apiKey: "k" }, fetchImpl }), "ws-1");

/**
 * The LIVE list shape (probed 2026-06-10): each item is a WRAPPER carrying the
 * approval under `approvalRequest` (with `status.state` + `dateRange`) next to
 * period totals. The flat `{id, state, period}` shape the old fixture invented
 * does not exist on the wire.
 */
function liveWrapper(id: string, state = "PENDING"): Record<string, unknown> {
  return {
    approvalRequest: {
      id,
      workspaceId: "ws-1",
      dateRange: { start: "2026-06-07T22:00:00Z", end: "2026-06-14T21:59:59Z" },
      owner: { userId: "u1", userName: "Ann", timeZone: "Europe/Budapest", startOfWeek: "MONDAY" },
      status: { state, updatedBy: "u9", updatedByUserName: "Boss", note: "" },
      creator: { userId: "u1", userName: "Ann", userEmail: "ann@example.com" },
    },
    entries: [],
    trackedTime: "PT8H",
    approvedTime: "PT0S",
    billableAmount: 0,
  };
}

describe("approval rest", () => {
  it("listApprovals GETs /approval-requests with a status filter + unwraps the approvalRequest wrapper", async () => {
    const f = vi.fn(async () => jsonResponse([liveWrapper("ap1")]));
    const out = await rest(f as unknown as typeof fetch).listApprovals({ status: "PENDING" });
    expect(out.rows[0]).toMatchObject({
      id: "ap1",
      userId: "u1",
      userName: "Ann",
      state: "PENDING",
      periodStart: "2026-06-07T22:00:00Z",
      periodEnd: "2026-06-14T21:59:59Z",
    });
    const parsed = new URL((f as any).mock.calls[0][0]);
    expect(parsed.pathname).toBe("/api/v1/workspaces/ws-1/approval-requests");
    expect(parsed.searchParams.get("status")).toBe("PENDING");
  });

  it("listApprovals still maps a flat item (defensive fallback)", async () => {
    const f = vi.fn(async () =>
      jsonResponse([{ id: "ap1", userId: "u1", userName: "Ann", state: "PENDING", period: { start: "2026-06-01", end: "2026-06-07" } }]),
    );
    const out = await rest(f as unknown as typeof fetch).listApprovals();
    expect(out.rows[0]).toMatchObject({ id: "ap1", state: "PENDING", periodStart: "2026-06-01" });
  });

  it("getApproval list-scans for the WRAPPED id", async () => {
    const f = vi.fn(async () => jsonResponse([liveWrapper("ap1"), liveWrapper("ap2", "APPROVED")]));
    const hit = await rest(f as unknown as typeof fetch).getApproval("ap2");
    expect(hit).toMatchObject({ id: "ap2", state: "APPROVED" });
    expect(new URL((f as any).mock.calls[0][0]).pathname).toBe("/api/v1/workspaces/ws-1/approval-requests");
    const miss = vi.fn(async () => jsonResponse([liveWrapper("apX")]));
    expect(await rest(miss as unknown as typeof fetch).getApproval("ap1")).toBeNull();
  });

  it("submitApproval POSTs {period, periodStart}", async () => {
    const f = vi.fn(async () => jsonResponse({ id: "ap9" }));
    const a = await rest(f as unknown as typeof fetch).submitApproval({ period: "WEEKLY", periodStart: "2026-06-01" });
    expect(a.id).toBe("ap9");
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/approval-requests");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ period: "WEEKLY", periodStart: "2026-06-01" });
  });

  it("setApprovalState PATCHes /approval-requests/{id} with {state, note?}", async () => {
    const f = vi.fn(async () => jsonResponse({ id: "ap1" }));
    await rest(f as unknown as typeof fetch).setApprovalState("ap1", "APPROVED", "ok");
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/approval-requests/ap1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ state: "APPROVED", note: "ok" });
  });

  it("resubmitApproval POSTs the PERIOD body {period, periodStart} (the spec + goclmcp shape; no approvalId/entryIds)", async () => {
    const f = vi.fn(async () => jsonResponse({ id: "ap1" }));
    await rest(f as unknown as typeof fetch).resubmitApproval({ period: "WEEKLY", periodStart: "2026-06-01T00:00:00Z" });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/approval-requests/resubmit-entries-for-approval");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ period: "WEEKLY", periodStart: "2026-06-01T00:00:00Z" });
  });
});
