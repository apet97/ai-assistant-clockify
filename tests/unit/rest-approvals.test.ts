import { describe, expect, it, vi } from "vitest";
import { createRestCore } from "../../src/clockify/rest/core.js";
import { makeApprovalRest } from "../../src/clockify/rest/approvals.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const rest = (fetchImpl: typeof fetch) =>
  makeApprovalRest(createRestCore({ apiBase: "https://api.clockify.me/api/v1", auth: { apiKey: "k" }, fetchImpl }), "ws-1");

describe("approval rest", () => {
  it("listApprovals GETs /approval-requests with a status filter + maps", async () => {
    const f = vi.fn(async () =>
      jsonResponse([{ id: "ap1", userId: "u1", userName: "Ann", state: "PENDING", period: { start: "2026-06-01", end: "2026-06-07" } }]),
    );
    const out = await rest(f as unknown as typeof fetch).listApprovals({ status: "PENDING" });
    expect(out[0]).toMatchObject({ id: "ap1", userId: "u1", state: "PENDING", periodStart: "2026-06-01" });
    const parsed = new URL((f as any).mock.calls[0][0]);
    expect(parsed.pathname).toBe("/api/v1/workspaces/ws-1/approval-requests");
    expect(parsed.searchParams.get("status")).toBe("PENDING");
  });

  it("getApproval list-scans for the id", async () => {
    const f = vi.fn(async () => jsonResponse([{ id: "ap1" }, { id: "ap2" }]));
    expect(await rest(f as unknown as typeof fetch).getApproval("ap2")).toMatchObject({ id: "ap2" });
    expect(new URL((f as any).mock.calls[0][0]).pathname).toBe("/api/v1/workspaces/ws-1/approval-requests");
    const miss = vi.fn(async () => jsonResponse([{ id: "apX" }]));
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

  it("resubmitApproval POSTs to resubmit-entries-for-approval with approvalId + entryIds", async () => {
    const f = vi.fn(async () => jsonResponse({ id: "ap1" }));
    await rest(f as unknown as typeof fetch).resubmitApproval("ap1", ["e1", "e2"], "redo");
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/approval-requests/resubmit-entries-for-approval");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ approvalId: "ap1", entryIds: ["e1", "e2"], note: "redo" });
  });
});
