import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { testing } from "@apet97/clockify-addon-sdk";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import type { AppConfig } from "../../src/config.js";
import type { ModelClient } from "../../src/assistant/model-client.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";

/**
 * r1-efficiency-01: GET /api/metrics with no `?since` must default to a bounded
 * window so the read is bounded even as the NEVER-pruned audit_events table
 * grows over the install's lifetime. A row older than the default window is
 * excluded from the totals; the explicit `?since` override still reaches it.
 */
const ADDON_KEY = "ai-assistant";
let keys: { privateKey: unknown; pem: string };
let store: Store;
let app: Express;
let fake: FakeWorkspace;

// A single shared clock drives BOTH the store (audit row `created_at`) and the
// route (`deps.now`), so the default-window cutoff is exercised deterministically.
// Anchored at the REAL now so the signed session cookie (TTL checked vs the real
// clock in verifySessionCookie) stays valid throughout the test.
const TODAY = Date.now();
const DAY = 86_400_000;
let clock = new Date(TODAY);

const modelClient: ModelClient = {
  async complete() {
    return JSON.stringify({ kind: "actions", text: "ok", actions: [] });
  },
};

async function adminCookie(): Promise<string> {
  const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
    workspaceId: "ws-1",
    user: "admin-1",
    workspaceRole: "ADMIN",
    addonId: "addon-1",
  });
  const res = await request(app).get("/component/assistant").query({ auth_token: token });
  const setCookie = res.headers["set-cookie"];
  return Array.isArray(setCookie) ? setCookie[0].split(";")[0] : "";
}

beforeAll(async () => {
  keys = await testing.generateTestKeys();
  const config: AppConfig = {
    nodeEnv: "test",
    port: 3996,
    baseUrl: "https://example.com/ai-assistant",
    clockifyAddonPublicKeyPem: keys.pem,
    clockifyAddonKey: ADDON_KEY,
    sessionSecret: "test-session-secret",
    databasePath: ":memory:",
    llmBaseUrl: "https://llm.example.com",
    llmApiKey: "llm-key",
    llmModel: "cheap-model",
    llmProvider: "http",
  };
  store = createStore(":memory:", { encryptionKey: "test-key", now: () => clock });
  store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
  fake = createFakeWorkspace();
  const parser = createSignatureParser(ADDON_KEY, keys.pem);
  app = createApp({ config, store, parser, modelClient, clockifyForWorkspace: () => fake.client, now: () => clock });
});

afterAll(() => store.close());

describe("GET /api/metrics default time window", () => {
  it("excludes audit events older than the default window when no ?since is supplied", async () => {
    // One audit row dated 60 days ago, one dated today — same workspace + admin.
    clock = new Date(TODAY - 60 * DAY); // well outside the 30-day default window
    store.addAuditEvent({
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "clockify_status",
      risk: ["read"],
      receipt: { ok: true, action: "clockify_status" },
    });

    clock = new Date(TODAY); // today
    store.addAuditEvent({
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "clockify_status",
      risk: ["read"],
      receipt: { ok: true, action: "clockify_status" },
    });

    const cookie = await adminCookie();

    // Default window: the 60-day-old row is excluded → only today's row counts.
    const res = await request(app).get("/api/metrics").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.metrics.totals.actions).toBe(1);

    // Explicit all-time override still reaches the old row.
    const all = await request(app)
      .get("/api/metrics")
      .query({ since: "2000-01-01T00:00:00.000Z" })
      .set("Cookie", cookie);
    expect(all.status).toBe(200);
    expect(all.body.metrics.totals.actions).toBe(2);
  });
});
