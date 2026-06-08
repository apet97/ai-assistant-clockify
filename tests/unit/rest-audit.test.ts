import { describe, expect, it, vi } from "vitest";
import { createRestCore } from "../../src/clockify/rest/core.js";
import { makeAuditRest } from "../../src/clockify/rest/audit.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const rest = (fetchImpl: typeof fetch) =>
  makeAuditRest(createRestCore({ apiBase: "https://api.clockify.me/api/v1", auth: { apiKey: "k" }, fetchImpl }), "ws-1");

describe("audit rest (multi-host)", () => {
  it("searchAuditLog POSTs to the AUDIT host with actions/start/end (+page)", async () => {
    const f = vi.fn(async () => jsonResponse([{ id: "a1", action: "CREATE_PROJECT" }]));
    const out = await rest(f as unknown as typeof fetch).searchAuditLog({
      actions: ["CREATE_PROJECT", "DELETE_PROJECT"],
      start: "2026-06-01T00:00:00Z",
      end: "2026-06-30T23:59:59Z",
      page: 1,
    });
    expect(out).toEqual([{ id: "a1", action: "CREATE_PROJECT" }]);
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://auditlog-api.api.clockify.me/v1/workspaces/ws-1/audit-log");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ actions: ["CREATE_PROJECT", "DELETE_PROJECT"], start: "2026-06-01T00:00:00Z", end: "2026-06-30T23:59:59Z", page: 1 });
  });

  it("searchAuditLog tolerates a non-array response (returns [])", async () => {
    const f = vi.fn(async () => jsonResponse({ message: "none" }));
    expect(await rest(f as unknown as typeof fetch).searchAuditLog({ actions: ["UPDATE_TASK"], start: "s", end: "e" })).toEqual([]);
  });

  it("listEntityChanges GETs /entities/{changeType} on the PRIMARY api host", async () => {
    const f = vi.fn(async () => jsonResponse([{ id: "p1" }]));
    const out = await rest(f as unknown as typeof fetch).listEntityChanges("created");
    expect(out).toEqual([{ id: "p1" }]);
    const [url] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/entities/created");
  });

  it("searchAuditLog surfaces a clean error (not 'fetch failed') when no audit host exists (dev)", async () => {
    // The dev/path host (developer.clockify.me/api) publishes no audit host, so the
    // action that the workflow calls must fail with an explained message and must
    // never fetch a guessed, non-resolving host.
    const f = vi.fn(async () => jsonResponse([]));
    const devRest = makeAuditRest(
      createRestCore({ apiBase: "https://developer.clockify.me/api/v1", auth: { addonToken: "tok" }, fetchImpl: f as unknown as typeof fetch }),
      "ws-1",
    );
    await expect(devRest.searchAuditLog({ actions: ["CREATE_TAG"], start: "s", end: "e" })).rejects.toThrow(
      /audit log is not available/i,
    );
    expect(f).not.toHaveBeenCalled();
  });
});
