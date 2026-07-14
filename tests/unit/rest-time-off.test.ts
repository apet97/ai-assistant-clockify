import { describe, expect, it, vi } from "vitest";
import { createRestCore } from "../../src/clockify/rest/core.js";
import { makeTimeOffRest } from "../../src/clockify/rest/time-off.js";
import { AmbiguousWriteOutcome } from "../../src/clockify/write-outcome.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
const rest = (fetchImpl: typeof fetch) =>
  makeTimeOffRest(
    createRestCore({ apiBase: "https://api.clockify.me/api/v1", auth: { apiKey: "k" }, fetchImpl }),
    "ws-1",
  );

describe("time-off rest", () => {
  it.each([
    ["policy", (api: ReturnType<typeof rest>) => api.createTimeOffPolicyAtomic({ name: "PTO", userId: "u1" })],
    ["request", (api: ReturnType<typeof rest>) => api.createTimeOffRequestAtomic("pol1", { start: "2026-07-14", end: "2026-07-14" })],
  ] as const)("classifies malformed successful time-off %s creates without an id as ambiguous", async (_label, invoke) => {
    const f = vi.fn(async () => jsonResponse({ name: "missing id" }));
    await expect(invoke(rest(f as unknown as typeof fetch))).rejects.toBeInstanceOf(AmbiguousWriteOutcome);
  });

  it("listTimeOffPolicies GETs and maps id/name/status/timeUnit", async () => {
    const f = vi.fn(async () => jsonResponse([{ id: "pol1", name: "PTO", status: "ACTIVE", timeUnit: "DAYS" }]));
    expect(await rest(f as unknown as typeof fetch).listTimeOffPolicies()).toEqual({
      rows: [{ id: "pol1", name: "PTO", status: "ACTIVE", timeUnit: "DAYS" }],
      truncated: false,
    });
    expect(new URL((f as any).mock.calls[0][0]).pathname).toBe("/api/v1/workspaces/ws-1/time-off/policies");
  });

  it("getTimeOffPolicy fetches one, or null on 404", async () => {
    const hit = vi.fn(async () => jsonResponse({ id: "pol1", name: "PTO" }));
    expect(await rest(hit as unknown as typeof fetch).getTimeOffPolicy("pol1")).toEqual({ id: "pol1", name: "PTO" });
    const miss = vi.fn(async () => jsonResponse({ message: "no" }, 404));
    expect(await rest(miss as unknown as typeof fetch).getTimeOffPolicy("polX")).toBeNull();
  });

  it("createTimeOffPolicy POSTs name/approve/timeUnit/users + automaticAccrual", async () => {
    const f = vi.fn(async () => jsonResponse({ id: "pol9", name: "PTO" }));
    const p = await rest(f as unknown as typeof fetch).createTimeOffPolicy({
      name: "PTO",
      userId: "u1",
      requiresApproval: true,
      daysPerYear: 20,
    });
    expect(p).toEqual({ id: "pol9", name: "PTO" });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/time-off/policies");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.name).toBe("PTO");
    expect(body.timeUnit).toBe("DAYS");
    expect(body.approve).toEqual({ requiresApproval: true });
    expect(body.users).toEqual({ contains: "CONTAINS", ids: ["u1"], status: "ACTIVE" });
    expect(body.automaticAccrual).toEqual({ amount: 20, period: "YEAR", timeUnit: "DAYS" });
  });

  it("createTimeOffPolicy scopes to userGroups + users when provided (CONTAINS filter shape)", async () => {
    const f = vi.fn(async () => jsonResponse({ id: "pol9", name: "PTO" }));
    await rest(f as unknown as typeof fetch).createTimeOffPolicy({
      name: "PTO",
      userId: "admin-1",
      userIds: ["u1", "u2"],
      userGroupIds: ["g1"],
    });
    const body = JSON.parse((f as any).mock.calls[0][1].body);
    expect(body.users).toEqual({ contains: "CONTAINS", ids: ["u1", "u2"], status: "ACTIVE" });
    expect(body.userGroups).toEqual({ contains: "CONTAINS", ids: ["g1"], status: "ACTIVE" });
  });

  it("updateTimeOffPolicy GET-then-PUTs, merging fields into the existing policy", async () => {
    const f = vi.fn(async (_url: string, init: any) =>
      init.method === "GET"
        ? jsonResponse({ id: "pol1", name: "Old", timeUnit: "DAYS", color: "#fff" })
        : jsonResponse({ id: "pol1", name: "New" }),
    );
    const updated = await rest(f as unknown as typeof fetch).updateTimeOffPolicy("pol1", { name: "New" });
    expect(updated).toEqual({ id: "pol1", name: "New" });
    const calls = (f as any).mock.calls;
    expect(calls.map((c: any) => c[1].method)).toEqual(["GET", "PUT"]);
    const body = JSON.parse(calls[1][1].body);
    expect(body.name).toBe("New");
    expect(body.color).toBe("#fff"); // preserved from existing
  });

  it("updateTimeOffPolicy overlays a userGroups scope onto the existing doc", async () => {
    const f = vi.fn(async (_url: string, init: any) =>
      init.method === "GET"
        ? jsonResponse({ id: "pol1", name: "PTO", timeUnit: "DAYS" })
        : jsonResponse({ id: "pol1", name: "PTO" }),
    );
    await rest(f as unknown as typeof fetch).updateTimeOffPolicy("pol1", { userGroupIds: ["g1"] });
    const body = JSON.parse((f as any).mock.calls[1][1].body);
    expect(body.userGroups).toEqual({ contains: "CONTAINS", ids: ["g1"], status: "ACTIVE" });
  });

  it("updateTimeOffPolicy reconstructs users/userGroups FILTERS from the GET's flat ids (live: PUT rejects null users/userGroups)", async () => {
    // The GET returns FLAT userIds/userGroupIds; the PUT needs {contains,ids} filters
    // or it 400s "must not be null". A name-only update must still preserve the scope.
    const f = vi.fn(async (_url: string, init: any) =>
      init.method === "GET"
        ? jsonResponse({ id: "pol1", name: "Old", timeUnit: "DAYS", userIds: ["u1"], userGroupIds: ["g0"] })
        : jsonResponse({ id: "pol1", name: "New" }),
    );
    await rest(f as unknown as typeof fetch).updateTimeOffPolicy("pol1", { name: "New" });
    const body = JSON.parse((f as any).mock.calls[1][1].body);
    expect(body.users).toEqual({ contains: "CONTAINS", ids: ["u1"], status: "ACTIVE" });
    expect(body.userGroups).toEqual({ contains: "CONTAINS", ids: ["g0"], status: "ACTIVE" });
  });

  it("prepares a policy replacement body with the lossless raw source from the same GET", async () => {
    const source = {
      id: "pol1", name: "PTO", timeUnit: "DAYS", color: "#123456",
      approve: { requiresApproval: true, approverIds: ["u2"] },
      automaticAccrual: { amount: 20, period: "YEAR", timeUnit: "DAYS", carryOver: true },
      users: { contains: "CONTAINS", ids: ["u1"], status: "ACTIVE" },
      userGroups: { contains: "CONTAINS", ids: ["g1"], status: "ACTIVE" },
      futurePlatformField: { preserve: true },
    };
    const f = vi.fn(async () => jsonResponse(source));
    const prepared = await rest(f as unknown as typeof fetch).prepareTimeOffPolicyUpdate("pol1", { name: "Renamed" });
    expect(prepared.source).toEqual(source);
    expect(prepared.body).toMatchObject({
      id: "pol1", name: "Renamed", color: "#123456",
      approve: { requiresApproval: true, approverIds: ["u2"] },
      futurePlatformField: { preserve: true },
    });
  });

  it("archiveTimeOffPolicy PATCHes status ARCHIVED / ACTIVE", async () => {
    const f = vi.fn(async () => jsonResponse({}));
    await rest(f as unknown as typeof fetch).archiveTimeOffPolicy("pol1", true);
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/time-off/policies/pol1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ status: "ARCHIVED" });
    const g = vi.fn(async () => jsonResponse({}));
    await rest(g as unknown as typeof fetch).archiveTimeOffPolicy("pol1", false);
    expect(JSON.parse((g as any).mock.calls[0][1].body)).toEqual({ status: "ACTIVE" });
  });

  it("listTimeOffRequests POSTs a search body and unwraps {requests:[…]}", async () => {
    const f = vi.fn(async () =>
      jsonResponse({ count: 1, requests: [{ id: "r1", policyId: "pol1", status: { statusType: "PENDING" }, timeOffPeriod: { period: { start: "2026-06-10T00:00:00Z", end: "2026-06-12T00:00:00Z" } } }] }),
    );
    const out = await rest(f as unknown as typeof fetch).listTimeOffRequests({ status: "PENDING", userId: "u1" });
    expect(out.rows[0]).toMatchObject({ id: "r1", policyId: "pol1", status: "PENDING", start: "2026-06-10T00:00:00Z" });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/time-off/requests");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.statuses).toEqual(["PENDING"]);
    expect(body.users).toEqual(["u1"]);
  });

  it("getTimeOffRequest POST-searches /time-off/requests and finds the id (the single GET is not a real route — live 404s 'No static resource' even for an existing id)", async () => {
    const hit = vi.fn(async () =>
      jsonResponse({ count: 2, requests: [{ id: "r0", policyId: "pol1" }, { id: "r1", policyId: "pol1" }] }),
    );
    expect(await rest(hit as unknown as typeof fetch).getTimeOffRequest("r1")).toMatchObject({ id: "r1" });
    const [url, init] = (hit as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/time-off/requests");
    expect(init.method).toBe("POST");
    const miss = vi.fn(async () => jsonResponse({ count: 0, requests: [] }));
    expect(await rest(miss as unknown as typeof fetch).getTimeOffRequest("rX")).toBeNull();
  });

  it("createTimeOffRequest POSTs the timeOffPeriod under the policy with BARE dates (live: instants are tolerated but YYYY-MM-DD is the documented shape)", async () => {
    const f = vi.fn(async () => jsonResponse({ id: "r9" }));
    await rest(f as unknown as typeof fetch).createTimeOffRequest("pol1", {
      start: "2026-06-10T00:00:00Z",
      end: "2026-06-12T00:00:00Z",
      days: 2,
      note: "vacation",
    });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/time-off/policies/pol1/requests");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.timeOffPeriod.period).toEqual({ start: "2026-06-10", end: "2026-06-12", days: 2 });
    expect(body.timeOffPeriod.isHalfDay).toBe(false);
    expect(body.note).toBe("vacation");
  });

  it("createTimeOffRequest defaults the REQUIRED `days` from the period span when omitted (live: create 400s 'Value for number of days is not allowed' without it)", async () => {
    const f = vi.fn(async () => jsonResponse({ id: "r9" }));
    await rest(f as unknown as typeof fetch).createTimeOffRequest("pol1", {
      start: "2026-09-14",
      end: "2026-09-16",
    });
    const body = JSON.parse((f as any).mock.calls[0][1].body);
    expect(body.timeOffPeriod.period).toEqual({ start: "2026-09-14", end: "2026-09-16", days: 3 });
  });

  it("createTimeOffRequest with timeUnit HOURS POSTs ISO datetimes and NO days/half-day scaffold (live-verified 2026-06-28)", async () => {
    const f = vi.fn(async () => jsonResponse({ id: "r9" }));
    await rest(f as unknown as typeof fetch).createTimeOffRequest("pol1", {
      start: "2026-07-06T09:00:00Z",
      end: "2026-07-06T13:00:00Z",
      timeUnit: "HOURS",
      note: "afternoon",
    });
    const body = JSON.parse((f as any).mock.calls[0][1].body);
    expect(body.timeOffPeriod.period).toEqual({ start: "2026-07-06T09:00:00Z", end: "2026-07-06T13:00:00Z" });
    expect(body.timeOffPeriod.period.days).toBeUndefined(); // HOURS carries no days
    expect(body.timeOffPeriod.isHalfDay).toBeUndefined(); // no half-day scaffold for HOURS
    expect(body.note).toBe("afternoon");
  });

  it("deleteTimeOffRequest DELETEs under the policy", async () => {
    const f = vi.fn(async () => jsonResponse(null, 204));
    await rest(f as unknown as typeof fetch).deleteTimeOffRequest("pol1", "r1");
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/time-off/policies/pol1/requests/r1");
    expect(init.method).toBe("DELETE");
  });

  it("setTimeOffRequestStatus PATCHes {status, note} (the wire field is `status`, NOT `statusType` — spec + goclmcp)", async () => {
    const f = vi.fn(async () => jsonResponse({ id: "r1" }));
    await rest(f as unknown as typeof fetch).setTimeOffRequestStatus("pol1", "r1", "APPROVED", "ok");
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/time-off/policies/pol1/requests/r1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ status: "APPROVED", note: "ok" });
  });

  it("getTimeOffBalance GETs the user balance and unwraps {balances:[…]}", async () => {
    const f = vi.fn(async () =>
      jsonResponse({ count: 1, balances: [{ policyId: "pol1", policyName: "PTO", balance: 15, used: 5, total: 20 }] }),
    );
    const out = await rest(f as unknown as typeof fetch).getTimeOffBalance("u1");
    expect(out).toEqual({ rows: [{ policyId: "pol1", policyName: "PTO", balance: 15, used: 5, total: 20, userId: "u1" }], truncated: false });
    expect(new URL((f as any).mock.calls[0][0]).pathname).toBe("/api/v1/workspaces/ws-1/time-off/balance/user/u1");
  });

  it("updateTimeOffBalance PATCHes the policy balance route with userIds + value + note", async () => {
    const f = vi.fn(async () => jsonResponse(null, 204));
    await rest(f as unknown as typeof fetch).updateTimeOffBalance("pol1", { userIds: ["u1", "u2"], value: 5, note: "bonus" });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/time-off/balance/policy/pol1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ userIds: ["u1", "u2"], value: 5, note: "bonus" });
  });
});
