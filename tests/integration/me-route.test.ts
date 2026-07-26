import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { testKeys } from "../helpers/test-keys.js";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { makeTestConfig } from "../helpers/config.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { mintAdminCookie } from "../helpers/session.js";
import type { ModelClient } from "../../src/assistant/model-client.js";

/**
 * T16-F: the /api/me transport route. It must expose ONLY the sanitized
 * session context — verified identity, UI preferences, public product links,
 * and the CSRF token — never a token, session id, or raw header.
 */
const ADDON_KEY = "ai-assistant";

const modelClient: ModelClient = {
  async complete() {
    return JSON.stringify({ kind: "answer", text: "hi" });
  },
};

let store: Store;
let app: Express;

beforeAll(async () => {
  const keys = await testKeys();
  const config = makeTestConfig({
    clockifyAddonPublicKeyPem: keys.pem,
    clockifyAddonKey: ADDON_KEY,
  });
  store = createStore(":memory:", { encryptionKey: "test-key" });
  store.saveInstallation({
    workspaceId: "ws-1",
    addonId: "addon-1",
    addonUserId: "addon-user-1",
    addonToken: "addon-token-secret",
  });
  app = createApp({
    config,
    store,
    parser: createSignatureParser(ADDON_KEY, keys.pem),
    modelClient,
    clockifyForWorkspace: () => createFakeWorkspace().client,
  });
});

afterAll(() => store.close());

describe("GET /api/me", () => {
  it("requires a session", async () => {
    const res = await request(app).get("/api/me");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("unauthorized");
  });

  it("returns the sanitized session context with links and a CSRF token", async () => {
    const cookie = mintAdminCookie(store, "test-session-secret");
    const res = await request(app).get("/api/me").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.workspaceId).toBe("ws-1");
    expect(res.body.adminUserId).toBe("admin-1");
    expect(res.body.workspaceRole).toBe("ADMIN");
    expect(res.body.preferences).toEqual({ theme: "system" });
    expect(Object.keys(res.body.links).sort()).toEqual(["privacy", "security", "support"]);
    for (const url of Object.values(res.body.links) as string[]) {
      expect(url.startsWith("https://")).toBe(true);
    }
    expect(typeof res.body.csrfToken).toBe("string");
    expect(res.body.csrfToken.length).toBeGreaterThan(0);
  });

  it("never leaks token or session material", async () => {
    const cookie = mintAdminCookie(store, "test-session-secret");
    const res = await request(app).get("/api/me").set("Cookie", cookie);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("addon-token-secret");
    expect(serialized).not.toContain("sessionId");
    expect(res.body).not.toHaveProperty("sessionId");
    expect(res.body).not.toHaveProperty("expiresAt");
  });
});
