import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { makeTestConfig } from "../helpers/config.js";
import { mintAdminCookie } from "../helpers/session.js";
import { testKeys } from "../helpers/test-keys.js";

describe("authenticated mutation CSRF boundary", () => {
  let app: Express;
  let store: Store;
  let cookie: string;
  const config = makeTestConfig({ nodeEnv: "production", baseUrl: "https://addon.example.com/app" });

  beforeAll(async () => {
    const keys = await testKeys();
    store = createStore(":memory:", { encryptionKey: "test-key" });
    store.saveInstallation({ workspaceId: "ws-1", addonId: "a", addonUserId: "u", addonToken: "token" });
    cookie = mintAdminCookie(store, config.sessionSecret);
    const fake = createFakeWorkspace();
    app = createApp({
      config: { ...config, clockifyAddonPublicKeyPem: keys.pem },
      store,
      parser: createSignatureParser(config.clockifyAddonKey, keys.pem),
      modelClient: { async complete() { return "{}"; } },
      clockifyForWorkspace: () => fake.client,
    });
  });

  afterAll(() => store.close());

  it("returns a session-bound HMAC token from /api/me", async () => {
    const res = await request(app).get("/api/me").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.csrfToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it("rejects a headerless mutation without the fallback token", async () => {
    const res = await request(app)
      .post("/api/permissions/preview")
      .set("Cookie", cookie)
      .send({ groups: {} });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("csrf_rejected");
  });

  it("accepts a browser mutation proven same-origin by Origin and Fetch Metadata", async () => {
    const res = await request(app)
      .post("/api/permissions/preview")
      .set("Cookie", cookie)
      .set("Origin", "https://addon.example.com")
      .set("Sec-Fetch-Site", "same-origin")
      .send({ groups: {} });
    expect(res.status).toBe(200);
  });

  it("accepts the HMAC fallback when non-browser clients omit browser metadata", async () => {
    const me = await request(app).get("/api/me").set("Cookie", cookie);
    const res = await request(app)
      .post("/api/permissions/preview")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", me.body.csrfToken)
      .send({ groups: {} });
    expect(res.status).toBe(200);
  });

  it("rejects explicit cross-site metadata even when a valid fallback token is supplied", async () => {
    const me = await request(app).get("/api/me").set("Cookie", cookie);
    const res = await request(app)
      .post("/api/permissions/preview")
      .set("Cookie", cookie)
      .set("Origin", "https://evil.example")
      .set("Sec-Fetch-Site", "cross-site")
      .set("X-CSRF-Token", me.body.csrfToken)
      .send({ groups: {} });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("csrf_rejected");
  });
});
