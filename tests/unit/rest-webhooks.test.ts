import { describe, expect, it, vi } from "vitest";
import { createRestCore } from "../../src/clockify/rest/core.js";
import { makeWebhookRest } from "../../src/clockify/rest/webhooks.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const rest = (fetchImpl: typeof fetch) =>
  makeWebhookRest(createRestCore({ apiBase: "https://api.clockify.me/api/v1", auth: { apiKey: "k" }, fetchImpl }), "ws-1");

describe("webhook rest", () => {
  it("listWebhooks unwraps {webhooks:[…]} and STRIPS authToken", async () => {
    const f = vi.fn(async () =>
      jsonResponse({ webhooks: [{ id: "w1", name: "Hook", url: "https://x.example/h", webhookEvent: "NEW_TIME_ENTRY", authToken: "SECRET" }] }),
    );
    const out = await rest(f as unknown as typeof fetch).listWebhooks();
    expect(out[0]).toMatchObject({ id: "w1", name: "Hook", url: "https://x.example/h", webhookEvent: "NEW_TIME_ENTRY" });
    expect(out[0]).not.toHaveProperty("authToken"); // secret never surfaced
    expect(new URL((f as any).mock.calls[0][0]).pathname).toBe("/api/v1/workspaces/ws-1/webhooks");
  });

  it("getWebhook STRIPS authToken, or null on 404", async () => {
    const hit = vi.fn(async () => jsonResponse({ id: "w1", name: "Hook", authToken: "SECRET" }));
    const w = await rest(hit as unknown as typeof fetch).getWebhook("w1");
    expect(w).toMatchObject({ id: "w1", name: "Hook" });
    expect(w).not.toHaveProperty("authToken");
    const miss = vi.fn(async () => jsonResponse({ message: "no" }, 404));
    expect(await rest(miss as unknown as typeof fetch).getWebhook("wX")).toBeNull();
  });

  it("createWebhook POSTs name/url/webhookEvent + defaults the trigger source to the workspace (no authToken)", async () => {
    const f = vi.fn(async () => jsonResponse({ id: "w9", name: "Hook" }));
    await rest(f as unknown as typeof fetch).createWebhook({ name: "Hook", url: "https://x.example/h", webhookEvent: "NEW_TIME_ENTRY" });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/webhooks");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body).toEqual({ name: "Hook", url: "https://x.example/h", webhookEvent: "NEW_TIME_ENTRY", triggerSourceType: "WORKSPACE_ID", triggerSource: ["ws-1"] });
    expect(body).not.toHaveProperty("authToken"); // secret never sent from the typed path
  });

  it("updateWebhook GET-then-merge-PUTs (and the result strips authToken)", async () => {
    const f = vi.fn(async (_url: string, init: any) =>
      init.method === "GET"
        ? jsonResponse({ id: "w1", name: "Old", url: "https://x.example/h", webhookEvent: "NEW_TIME_ENTRY", authToken: "SECRET" })
        : jsonResponse({ id: "w1", name: "New" }),
    );
    const updated = await rest(f as unknown as typeof fetch).updateWebhook("w1", { name: "New" });
    expect(updated).toEqual({ id: "w1", name: "New" });
    const calls = (f as any).mock.calls;
    expect(calls.map((c: any) => c[1].method)).toEqual(["GET", "PUT"]);
    const body = JSON.parse(calls[1][1].body);
    expect(body.name).toBe("New");
    expect(body.webhookEvent).toBe("NEW_TIME_ENTRY"); // preserved
    expect(body).not.toHaveProperty("authToken"); // never echoed back
  });

  it("deleteWebhook DELETEs", async () => {
    const f = vi.fn(async () => jsonResponse(null, 204));
    await rest(f as unknown as typeof fetch).deleteWebhook("w1");
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.clockify.me/api/v1/workspaces/ws-1/webhooks/w1");
    expect(init.method).toBe("DELETE");
  });

  it("listWebhookLogs GETs the per-webhook logs", async () => {
    const f = vi.fn(async () => jsonResponse([{ id: "log1" }]));
    const out = await rest(f as unknown as typeof fetch).listWebhookLogs("w1");
    expect(out).toEqual([{ id: "log1" }]);
    expect(new URL((f as any).mock.calls[0][0]).pathname).toBe("/api/v1/workspaces/ws-1/webhooks/w1/logs");
  });

  it("listWebhookEvents returns a non-empty static event list (no API call)", async () => {
    const f = vi.fn(async () => jsonResponse({}));
    const events = await rest(f as unknown as typeof fetch).listWebhookEvents();
    expect(events).toContain("NEW_TIME_ENTRY");
    expect(events.length).toBeGreaterThan(20);
    expect((f as any).mock.calls.length).toBe(0); // static, no fetch
  });
});
