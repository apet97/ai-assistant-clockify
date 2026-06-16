import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { makeTestConfig } from "../helpers/config.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { testKeys } from "../helpers/test-keys.js";

/**
 * The readiness probe (Railway healthcheck). Unlike the static /manifest, /health
 * touches the DB handle, so a hung/locked SQLite instance reports 503 and gets
 * rotated out instead of silently failing live traffic. Public, no auth, no secrets.
 */
const ADDON_KEY = "ai-assistant";
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {
      // a test may have closed the store deliberately (the 503 case)
    }
  }
});

async function makeApp(): Promise<{ app: Express; store: Store }> {
  const keys = await testKeys();
  const config = makeTestConfig({
    clockifyAddonPublicKeyPem: keys.pem,
    clockifyAddonKey: ADDON_KEY,
  });
  const store = createStore(":memory:", { encryptionKey: "test-key" });
  stores.push(store);
  const app = createApp({
    config,
    store,
    parser: createSignatureParser(ADDON_KEY, keys.pem),
    modelClient: { complete: async () => "{}" },
    clockifyForWorkspace: () => createFakeWorkspace().client,
  });
  return { app, store };
}

describe("GET /health", () => {
  it("returns 200 {ok:true} while the DB handle is live", async () => {
    const { app } = await makeApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("returns 503 {ok:false} when the store can't serve (DB handle dead) — a static healthcheck would falsely pass", async () => {
    const { app, store } = await makeApp();
    store.close(); // simulate a hung/closed handle: healthCheck() now throws
    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false });
  });
});
