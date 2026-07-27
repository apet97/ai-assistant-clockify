import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { makeTestConfig } from "../helpers/config.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { scriptedToolModel } from "../helpers/scripted-model.js";
import { mintAdminCookie, requireSessionCookie } from "../helpers/session.js";
import { signSessionCookie } from "../../src/auth/sessions.js";
import { buildSessionCookie } from "../../src/routes/deps.js";
import { testKeys } from "../helpers/test-keys.js";
import { computeRequestHash } from "../../src/assistant-v2/state.js";

const ADDON_KEY = "ai-assistant";
let stores: Store[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores = [];
});

async function makeApp(): Promise<{ app: Express; cookie: string; sessionId: string }> {
  const keys = await testKeys();
  const config = makeTestConfig({ clockifyAddonPublicKeyPem: keys.pem, clockifyAddonKey: ADDON_KEY });
  const store = createStore(":memory:", { encryptionKey: "test-key" });
  stores.push(store);
  store.saveInstallation({ workspaceId: "ws-1", addonId: "a", addonUserId: "u", addonToken: "t" });
  const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
  const cookieValue = signSessionCookie(
    {
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      workspaceRole: "ADMIN",
      expiresAt: session.expiresAt,
    },
    config.sessionSecret,
  );
  const cookie = buildSessionCookie(cookieValue, false).split(";")[0];
  const app = createApp({
    config,
    store,
    parser: createSignatureParser(ADDON_KEY, keys.pem),
    modelClient: scriptedToolModel([]),
    clockifyForWorkspace: () => createFakeWorkspace().client,
  });
  return { app, cookie, sessionId: session.id };
}

describe("GET /api/runs/:id/events", () => {
  it("returns 404 for a foreign run scope", async () => {
    const { app, cookie } = await makeApp();
    const res = await request(app).get("/api/runs/foreign-run/events?after=0").set("Cookie", cookie);
    expect(res.status).toBe(404);
  });

  it("pages events with strict cursor and lastSequence", async () => {
    const { app, cookie, sessionId } = await makeApp();
    const store = stores[0]!;
    store.startRunWithEvent({
      scope: {
        sessionId,
        runId: "run-1",
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        installationGeneration: 1,
        authClass: "addon",
      },
      originalRequest: "hello",
      requestHash: computeRequestHash("hello"),
      catalogHash: "a".repeat(64),
      loadedToolNames: [],
      intentHash: "run-1",
    });
    const res = await request(app).get("/api/runs/run-1/events?after=0").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.lastSequence).toBe(1);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.nextAfter).toBe(1);
  });
});
