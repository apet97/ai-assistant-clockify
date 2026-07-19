import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { testKeys } from "../helpers/test-keys.js";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { makeTestConfig } from "../helpers/config.js";
import type { ModelClient } from "../../src/assistant/model-client.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { mintAdminCookie } from "../helpers/session.js";

const ADDON_KEY = "ai-assistant";

let keys: { privateKey: unknown; pem: string };
let store: Store;
let app: Express;

const modelClient: ModelClient = {
  async complete() {
    return "{}";
  },
};

beforeAll(async () => {
  keys = await testKeys();
  const config = makeTestConfig({
    clockifyAddonPublicKeyPem: keys.pem,
    clockifyAddonKey: ADDON_KEY,
  });
  store = createStore(":memory:", { encryptionKey: "test-key" });
  store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
  const parser = createSignatureParser(ADDON_KEY, keys.pem);
  const fake = createFakeWorkspace();
  app = createApp({ config, store, parser, modelClient, clockifyForWorkspace: () => fake.client });
});

afterAll(() => store.close());

describe("/api security headers (T51)", () => {
  it("sets X-Content-Type-Options: nosniff on /api JSON responses (even a 401)", async () => {
    // No cookie -> 401, but the global middleware runs first, so the header is set.
    const res = await request(app).get("/api/me");
    expect(res.status).toBe(401);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("does NOT add X-Frame-Options (the add-on must stay iframe-embeddable)", async () => {
    const res = await request(app).get("/api/me");
    expect(res.headers["x-frame-options"]).toBeUndefined();
  });

  it("does not disclose Express through X-Powered-By", async () => {
    const res = await request(app).get("/live");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("omits HSTS for a local http (non-https) deployment base", async () => {
    // The shared test config baseUrl is https://example.com/... so HSTS IS set
    // there; assert the conditional by building an http-base app.
    const httpConfig = makeTestConfig({
      clockifyAddonPublicKeyPem: keys.pem,
      clockifyAddonKey: ADDON_KEY,
      baseUrl: "http://localhost:3990/ai-assistant",
    });
    const httpStore = createStore(":memory:", { encryptionKey: "test-key" });
    httpStore.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
    const parser = createSignatureParser(ADDON_KEY, keys.pem);
    const fake = createFakeWorkspace();
    const httpApp = createApp({ config: httpConfig, store: httpStore, parser, modelClient, clockifyForWorkspace: () => fake.client });
    const res = await request(httpApp).get("/api/me");
    expect(res.headers["strict-transport-security"]).toBeUndefined();
    httpStore.close();
  });

  it("sets HSTS for an https deployment base", async () => {
    const res = await request(app).get("/api/me");
    expect(res.headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
  });

  it("marks authenticated API responses private, no-store", async () => {
    const cookie = mintAdminCookie(store, makeTestConfig().sessionSecret);
    const res = await request(app).get("/api/me").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("private");
    expect(res.headers["cache-control"]).toContain("no-store");
  });
});
