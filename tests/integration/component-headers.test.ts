import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { testing } from "@apet97/clockify-addon-sdk";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import type { AppConfig } from "../../src/config.js";
import type { ModelClient } from "../../src/assistant/model-client.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import type { Express } from "express";

const ADDON_KEY = "ai-assistant";

let keys: { privateKey: unknown; pem: string };
let store: Store;
let app: Express;

const modelClient: ModelClient = {
  async complete() {
    return JSON.stringify({ kind: "answer", text: "Hello, admin." });
  },
};

beforeAll(async () => {
  keys = await testing.generateTestKeys();
  const config: AppConfig = {
    nodeEnv: "test",
    port: 3998,
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
  store = createStore(":memory:", { encryptionKey: "test-key" });
  store.saveInstallation({
    workspaceId: "ws-1",
    addonId: "addon-1",
    addonUserId: "addon-user-1",
    addonToken: "addon-token",
  });
  const parser = createSignatureParser(ADDON_KEY, keys.pem);
  const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Acme" }] });
  app = createApp({
    config,
    store,
    parser,
    modelClient,
    clockifyForWorkspace: () => fake.client,
  });
});

afterAll(() => store.close());

describe("component HTML security headers (injection/clickjacking backstop)", () => {
  // The embedded chat renders attacker-influenced workspace data (project/client
  // names, time-entry descriptions, model reply text). The HTML response must
  // carry a strict CSP + clickjacking control as defense-in-depth beyond the
  // textContent render convention. The frame-ancestors allow-list MUST include
  // the Clockify/CAKE embedding origins or the cross-site iframe breaks.
  it("serves the admin chat shell with a strict Content-Security-Policy and header backstops", async () => {
    const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: "ws-1",
      user: "admin-1",
      workspaceRole: "ADMIN",
    });
    const res = await request(app).get("/component/assistant").query({ auth_token: token });
    expect(res.status).toBe(200);

    const csp = res.headers["content-security-policy"];
    expect(csp).toBeTruthy();
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    // The embedding origins (cross-site iframe) must be explicitly allowed.
    expect(csp).toContain("frame-ancestors");
    expect(csp).toContain("clockify.me");
    expect(csp).toContain("cake.com");
    // No 'unsafe-inline' — the built shell uses external script/style only.
    expect(csp).not.toContain("unsafe-inline");

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBeTruthy();
  });

  it("also sets the headers on the non-admin rejection page (no render surface left bare)", async () => {
    const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: "ws-1",
      user: "member-1",
      workspaceRole: "USER",
    });
    const res = await request(app).get("/component/assistant").query({ auth_token: token });
    expect(res.status).toBe(403);
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});
