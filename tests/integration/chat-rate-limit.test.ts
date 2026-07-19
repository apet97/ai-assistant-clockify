import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { testKeys } from "../helpers/test-keys.js";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { makeTestConfig } from "../helpers/config.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { scriptedToolModel } from "../helpers/scripted-model.js";
import { mintAdminCookie } from "../helpers/session.js";

/**
 * Per-session chat rate limit: each chat turn drives a paid model loop, so the
 * chat routes (and ONLY the chat routes) are bounded per signed session. A
 * limited request is rejected BEFORE the user message is persisted or the
 * model is called; the JSON body is honest copy the UI can show verbatim.
 */
const ADDON_KEY = "ai-assistant";

let stores: Store[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores = [];
});

async function makeApp(nowRef: { value: Date }): Promise<{ app: Express; mintCookie: () => string }> {
  const keys = await testKeys();
  const config = makeTestConfig({
    clockifyAddonPublicKeyPem: keys.pem,
    clockifyAddonKey: ADDON_KEY,
    chatRateLimitMax: 2,
    chatRateLimitWindowMs: 60_000,
  });
  const store = createStore(":memory:", { encryptionKey: "test-key" });
  stores.push(store);
  store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
  const fake = createFakeWorkspace();
  const app = createApp({
    config,
    store,
    parser: createSignatureParser(ADDON_KEY, keys.pem),
    modelClient: scriptedToolModel([
      { text: "ok", toolCalls: [] },
      { text: "ok", toolCalls: [] },
      { text: "ok", toolCalls: [] },
      { text: "ok", toolCalls: [] },
      { text: "ok", toolCalls: [] },
      { text: "ok", toolCalls: [] },
    ]),
    clockifyForWorkspace: () => fake.client,
    now: () => nowRef.value,
  });
  const mintCookie = (): string => mintAdminCookie(store, config.sessionSecret);
  return { app, mintCookie };
}

describe("chat rate limit (per session)", () => {
  it("429s the (max+1)th chat turn with honest JSON + Retry-After, then recovers when the window slides", async () => {
    const nowRef = { value: new Date("2026-06-06T10:00:00.000Z") };
    const { app, mintCookie } = await makeApp(nowRef);
    const cookie = await mintCookie();

    for (let i = 0; i < 2; i += 1) {
      const ok = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: `hi ${i}` });
      expect(ok.status).toBe(200);
    }
    const limited = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "again" });
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ ok: false, code: "rate_limited" });
    expect(limited.body.message).toMatch(/too quickly/i);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);

    // The stream route shares the same budget and rejects with JSON, not NDJSON.
    const stream = await request(app).post("/api/chat/stream").set("Cookie", cookie).send({ message: "again" });
    expect(stream.status).toBe(429);
    expect(stream.headers["content-type"]).toContain("application/json");

    // Once the window slides, the same session may chat again.
    nowRef.value = new Date("2026-06-06T10:01:01.000Z");
    const recovered = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "later" });
    expect(recovered.status).toBe(200);
  });

  it("a second session on the same app has its own budget", async () => {
    const nowRef = { value: new Date("2026-06-06T10:00:00.000Z") };
    const { app, mintCookie } = await makeApp(nowRef);
    const first = await mintCookie();
    for (let i = 0; i < 2; i += 1) {
      await request(app).post("/api/chat/messages").set("Cookie", first).send({ message: `hi ${i}` });
    }
    expect((await request(app).post("/api/chat/messages").set("Cookie", first).send({ message: "x" })).status).toBe(429);

    const second = await mintCookie();
    const ok = await request(app).post("/api/chat/messages").set("Cookie", second).send({ message: "fresh" });
    expect(ok.status).toBe(200);
  });
});
