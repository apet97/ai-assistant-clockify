import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { makeTestConfig } from "../helpers/config.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { scriptedToolModel } from "../helpers/scripted-model.js";
import { mintAdminCookie } from "../helpers/session.js";
import { testKeys } from "../helpers/test-keys.js";
import { computeRequestHash } from "../../src/assistant-v2/state.js";
import { signSessionCookie } from "../../src/auth/sessions.js";
import { buildSessionCookie } from "../../src/routes/deps.js";

const ADDON_KEY = "ai-assistant";
let stores: Store[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores = [];
});

describe("GET /api/dev/runs/:id", () => {
  it("is unavailable in production", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const keys = await testKeys();
      const config = makeTestConfig({ clockifyAddonPublicKeyPem: keys.pem, clockifyAddonKey: ADDON_KEY });
      const store = createStore(":memory:", { encryptionKey: "test-key" });
      stores.push(store);
      store.saveInstallation({ workspaceId: "ws-1", addonId: "a", addonUserId: "u", addonToken: "t" });
      const app = createApp({
        config,
        store,
        parser: createSignatureParser(ADDON_KEY, keys.pem),
        modelClient: scriptedToolModel([]),
        clockifyForWorkspace: () => createFakeWorkspace().client,
      });
      const res = await request(app).get("/api/dev/runs/run-1").set("Cookie", mintAdminCookie(store, config.sessionSecret));
      expect(res.status).toBe(404);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it("returns sanitized run diagnostics outside production", async () => {
    const keys = await testKeys();
    const config = makeTestConfig({ clockifyAddonPublicKeyPem: keys.pem, clockifyAddonKey: ADDON_KEY });
    const store = createStore(":memory:", { encryptionKey: "test-key" });
    stores.push(store);
    store.saveInstallation({ workspaceId: "ws-1", addonId: "a", addonUserId: "u", addonToken: "t" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const cookie = buildSessionCookie(
      signSessionCookie({
        sessionId: session.id,
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        workspaceRole: "ADMIN",
        expiresAt: session.expiresAt,
      }, config.sessionSecret),
      false,
    ).split(";")[0];
    store.startRunWithEvent({
      scope: {
        sessionId: session.id,
        runId: "run-1",
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        installationGeneration: 1,
        authClass: "addon",
      },
      originalRequest: "hello",
      requestHash: computeRequestHash("hello"),
      catalogHash: "a".repeat(64),
      loadedToolNames: ["assistant_find_api_operations"],
      intentHash: "run-1",
    });
    const app = createApp({
      config,
      store,
      parser: createSignatureParser(ADDON_KEY, keys.pem),
      modelClient: scriptedToolModel([]),
      clockifyForWorkspace: () => createFakeWorkspace().client,
    });
    const res = await request(app).get("/api/dev/runs/run-1").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.loadedOperations).toEqual(["assistant_find_api_operations"]);
  });
});
