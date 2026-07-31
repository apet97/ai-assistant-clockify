import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { testing } from "@apet97/clockify-addon-sdk";
import { createApp } from "../../src/server.js";
import { createSignatureParser, ClockifyHeaders } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { createRestWorkspaceClient } from "../../src/clockify/rest-workspace.js";
import {
  SUSTAINED_HOST_CONSECUTIVE_THRESHOLD,
  SUSTAINED_HOST_WINDOW_MS,
  createHostThrottleMonitor,
} from "../../src/clockify/host-throttle-monitor.js";
import { createRetentionAlertMonitor } from "../../src/retention-alerts.js";
import { createModelClient } from "../../src/assistant/model-client.js";
import { logAlias } from "../../src/log-alias.js";
import { makeTestConfig } from "../helpers/config.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { testKeys } from "../helpers/test-keys.js";

/**
 * D3 privacy floor, mirroring `tests/integration/lifecycle-log-privacy.test.ts`:
 * an operator alert must never carry a raw workspace/admin/entity id, a token,
 * or admin-authored text. The hostile values below are driven THROUGH the real
 * emitting paths — a store failure whose driver message quotes SQL and customer
 * data, a workspace id handed to the throttle monitor, an oversized artifact
 * with an attacker-chosen filename, and a provider body echoing a prompt.
 *
 * Assertions are on SHAPES as well as literals (24-hex ids, JWT prefixes), so a
 * different leaked identifier still fails.
 */
const ADDON_KEY = "ai-assistant";
const WORKSPACE_ID = "64ad1305c701cc5be7c26fe4";
const ADMIN_ID = "5f0a1305c701cc5be7c26aa1";
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJ3b3Jrc3BhY2VJZCI6IngifQ.sig";
const PROMPT = "delete every time entry for Ana before Friday";
/** What a real driver message looks like: SQL text plus the row values in it. */
const HOSTILE_MESSAGE =
  `attempt to write a readonly database: UPDATE installations SET addon_token_ciphertext='${JWT}' `
  + `WHERE workspace_id='${WORKSPACE_ID}' AND admin='${ADMIN_ID}' /* ${PROMPT} */`;

const SECRET = "session-secret-for-alias";

function assertClean(line: string): void {
  expect(line).not.toContain(WORKSPACE_ID);
  expect(line).not.toContain(ADMIN_ID);
  expect(line).not.toContain(JWT);
  expect(line).not.toContain(PROMPT);
  expect(line).not.toContain("eyJ");
  expect(line).not.toMatch(/[0-9a-f]{24}/);
  expect(line).not.toContain("UPDATE ");
}

let keys: { privateKey: unknown; pem: string };
beforeAll(async () => {
  keys = await testKeys();
});
afterEach(() => vi.restoreAllMocks());

/** Structural, so the vitest mock generic never has to be spelled out. */
function warnLines(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => call.map(String).join(" "));
}

describe("alert log privacy", () => {
  it("classifies a hostile store failure at /health without echoing one byte of it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = createStore(":memory:", { encryptionKey: "test-key" });
    const failing: Store = {
      ...store,
      healthCheck: () => {
        throw Object.assign(new Error(HOSTILE_MESSAGE), { code: "SQLITE_READONLY" });
      },
    };
    const app = createApp({
      config: makeTestConfig({ clockifyAddonPublicKeyPem: keys.pem, clockifyAddonKey: ADDON_KEY }),
      store: failing,
      parser: createSignatureParser(ADDON_KEY, keys.pem),
      modelClient: { complete: async () => "{}" },
      clockifyForWorkspace: () => createFakeWorkspace().client,
      readiness: { isReady: () => true },
    });

    expect((await request(app).get("/health")).status).toBe(503);
    // A platform healthcheck polls; the second and third probes must add nothing.
    expect((await request(app).get("/health")).status).toBe(503);
    expect((await request(app).get("/health")).status).toBe(503);
    store.close();

    const lines = warnLines(warn);
    const readiness = lines.filter((line) => line.startsWith("[readiness]"));
    const storage = lines.filter((line) => line.startsWith("[storage]"));
    expect(readiness).toEqual(["[readiness] event=not_ready cause=sqlite_readonly"]);
    expect(storage).toEqual(["[storage] event=sqlite_unavailable kind=readonly site=readiness"]);
    for (const line of [...readiness, ...storage]) assertClean(line);
  });

  it("reports a draining probe under its own cause, once, and closes it on recovery", async () => {
    // Draining is the benign deploy case and must be distinguishable from a
    // storage failure at a glance — an operator paging on every deploy stops
    // reading the alert. It also must not repeat per poll.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = createStore(":memory:", { encryptionKey: "test-key" });
    let ready = false;
    const app = createApp({
      config: makeTestConfig({ clockifyAddonPublicKeyPem: keys.pem, clockifyAddonKey: ADDON_KEY }),
      store,
      parser: createSignatureParser(ADDON_KEY, keys.pem),
      modelClient: { complete: async () => "{}" },
      clockifyForWorkspace: () => createFakeWorkspace().client,
      readiness: { isReady: () => ready },
    });
    expect((await request(app).get("/health")).status).toBe(503);
    expect((await request(app).get("/health")).status).toBe(503);
    ready = true;
    expect((await request(app).get("/health")).status).toBe(200);
    store.close();

    expect(warnLines(warn).filter((line) => line.startsWith("[readiness]"))).toEqual([
      "[readiness] event=not_ready cause=draining",
      "[readiness] event=ready_recovered",
    ]);
  });

  it("classifies a mid-request store failure, the path a locked volume really takes", async () => {
    // The runbook's SQLITE_BUSY case is a store write that throws DURING a turn
    // and lands in the terminal error handler — not the readiness probe. Driven
    // through a real signed lifecycle callback so the failure reaches that
    // handler the way production would.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = createStore(":memory:", { encryptionKey: "test-key" });
    const failing: Store = {
      ...store,
      saveInstallation: () => {
        throw Object.assign(new Error(HOSTILE_MESSAGE), { code: "SQLITE_BUSY" });
      },
    };
    const app = createApp({
      config: makeTestConfig({ clockifyAddonPublicKeyPem: keys.pem, clockifyAddonKey: ADDON_KEY }),
      store: failing,
      parser: createSignatureParser(ADDON_KEY, keys.pem),
      modelClient: { complete: async () => "{}" },
      clockifyForWorkspace: () => createFakeWorkspace().client,
    });
    const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
      iat: Math.floor(Date.now() / 1000),
      workspaceId: WORKSPACE_ID,
      addonId: "69950af22720c2992bab57f7",
    });
    const res = await request(app)
      .post("/lifecycle/installed")
      .set(ClockifyHeaders.LIFECYCLE_TOKEN, token)
      .send({ workspaceId: WORKSPACE_ID, authToken: "install-token" });
    store.close();

    expect(res.status).toBe(500);
    const alerts = warnLines(warn).filter((line) => line.startsWith("[storage]"));
    expect(alerts).toEqual(["[storage] event=sqlite_unavailable kind=busy site=request"]);
    assertClean(alerts[0]!);
  });

  it("alerts on a sustained host storm through the REAL adapter, with an aliased workspace", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Injected clock: the fast-trip re-arms only after the rolling window drains,
    // which is a minute of real time this test must not spend sleeping through.
    let clock = Date.now();
    const monitor = createHostThrottleMonitor({
      aliasFor: (workspaceId) => logAlias(SECRET, "workspace", workspaceId),
      now: () => clock,
    });
    // Scope, stated exactly: this covers the ADAPTER half of the chain —
    // `rest/core.ts` observing a response and `rest-workspace.ts` passing the
    // hooks through — for BOTH the throttled and the healthy direction. It does
    // NOT cover the server link, because it supplies the hooks itself below;
    // that link is covered by `createLiveClockifyFactory` in
    // tests/unit/alert-production-wiring.test.ts.
    let throttling = true;
    const client = createRestWorkspaceClient({
      baseUrl: "https://api.clockify.me/api/v1",
      workspaceId: WORKSPACE_ID,
      auth: { addonToken: JWT },
      testOnlyEnforceMutationScope: false,
      // `retry-after: 0` keeps the bounded GET retry instant instead of ~900ms.
      fetchImpl: async () => (throttling
        ? new Response("{}", { status: 429, headers: { "retry-after": "0" } })
        : new Response("[]", { status: 200, headers: { "content-type": "application/json" } })),
      onHostThrottled: (status) => monitor.throttled(WORKSPACE_ID, status),
      onHostHealthy: () => monitor.healthy(WORKSPACE_ID),
    });
    const trips = (trigger: string): string[] => warnLines(warn)
      .filter((line) => line.startsWith("[clockify-host]") && line.includes(`trigger=${trigger}`));

    // One GET yields at most 1 + MAX_GET_RETRIES observations, so reaching the
    // fast-trip deliberately takes more than one request.
    for (let call = 0; call < SUSTAINED_HOST_CONSECUTIVE_THRESHOLD; call += 1) {
      await expect(client.listTags()).rejects.toThrow();
    }
    expect(trips("consecutive")).toHaveLength(1);
    expect(trips("consecutive")[0]).toContain("event=host_throttled_sustained");
    expect(trips("consecutive")[0]).toContain(`count=${SUSTAINED_HOST_CONSECUTIVE_THRESHOLD}`);
    expect(trips("consecutive")[0]).toMatch(/workspace=ws-[A-Za-z0-9_-]{12}/);
    assertClean(trips("consecutive")[0]!);

    // ONE healthy response is not recovery. The fast-trip latches, so a partial
    // outage — where four failures keep happening to land in a row — must stay
    // at one line instead of flooding.
    throttling = false;
    await expect(client.listTags()).resolves.toBeDefined();
    throttling = true;
    for (let call = 0; call < SUSTAINED_HOST_CONSECUTIVE_THRESHOLD; call += 1) {
      await expect(client.listTags()).rejects.toThrow();
    }
    expect(trips("consecutive")).toHaveLength(1);

    // The healthy direction still has to be WIRED: draining the window is what
    // re-arms the alert, and the window can only drain on a healthy observation
    // reaching the monitor. If `onHostHealthy` were dropped anywhere in the
    // adapter the latch would never clear and the next outage would be silent.
    clock += SUSTAINED_HOST_WINDOW_MS + 1;
    throttling = false;
    await expect(client.listTags()).resolves.toBeDefined();
    throttling = true;
    for (let call = 0; call < SUSTAINED_HOST_CONSECUTIVE_THRESHOLD; call += 1) {
      await expect(client.listTags()).rejects.toThrow();
    }
    expect(trips("consecutive")).toHaveLength(2);
  });

  it("rejects an oversized artifact in the real store without logging its filename", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = createStore(":memory:", { encryptionKey: "test-key" });
    try {
      expect(() => store.createArtifact({
        workspaceId: WORKSPACE_ID,
        adminUserId: ADMIN_ID,
        sessionId: "sess-1",
        contentType: "application/pdf",
        filename: `${PROMPT}-${JWT}.pdf`,
        bytes: new Uint8Array(1_000_001),
      })).toThrow(/artifact_too_large/);
    } finally {
      store.close();
    }
    const alerts = warnLines(warn).filter((line) => line.includes("artifact_oversize_rejected"));
    expect(alerts).toEqual([
      "[storage] event=artifact_oversize_rejected site=persist limit=1000000 bytes=1000001",
    ]);
    assertClean(alerts[0]!);
  });

  it("reports a repeated prune failure as a count — the alert API cannot carry a message", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const monitor = createRetentionAlertMonitor();
    // `failed()` takes NO error on purpose: a prune failure's message is a driver
    // string that can quote SQL and row values, so it cannot reach THIS line at
    // the type level. The separate `retention prune failed:` prose line in
    // server.ts is a different question and is not asserted here.
    for (let i = 0; i < 12; i += 1) monitor.failed();
    const alerts = warnLines(warn).filter((line) => line.startsWith("[retention]"));
    expect(alerts).toEqual(["[retention] event=prune_failing_repeatedly consecutive=3"]);
    assertClean(alerts[0]!);
  });

  it("keeps a provider failure line to the status and request id, never the body", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = createModelClient({
      baseUrl: "https://provider.invalid/v1/chat/completions",
      apiKey: "test-key",
      model: "test-model",
      sleepImpl: async () => undefined,
      // A provider that echoes the prompt and the workspace back in its error body.
      fetchImpl: async () => new Response(
        JSON.stringify({ error: { message: HOSTILE_MESSAGE, prompt: PROMPT } }),
        { status: 503 },
      ),
    });
    await expect(client.complete([{ role: "user", content: PROMPT }])).rejects.toThrow();
    const alerts = warnLines(warn).filter((line) => line.includes("provider_http_error"));
    expect(alerts.length).toBeGreaterThan(0);
    for (const line of alerts) assertClean(line);
  });
});
