import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { testing } from "@apet97/clockify-addon-sdk";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import type { AppConfig } from "../../src/config.js";
import type { ToolCompletion } from "../../src/assistant/model-client.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import { scriptedToolModel } from "../helpers/scripted-model.js";
import { testKeys } from "../helpers/test-keys.js";

/**
 * POST /api/chat/new starts a fresh conversation: it mints a NEW session (new
 * cookie) so the transcript is empty, WITHOUT deleting the previous session's
 * messages (they remain under retention; the audit log keeps the actions). The
 * old session's cookie therefore still replays its history.
 */
const ADDON_KEY = "ai-assistant";
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});


async function makeApp(
  script: ToolCompletion[],
  fake: FakeWorkspace,
  configOverride: Partial<AppConfig> = {},
): Promise<{ app: Express; cookie: string }> {
  const keys = await testKeys();
  const config: AppConfig = {
    nodeEnv: "test",
    port: 3993,
    baseUrl: "https://example.com/ai-assistant",
    clockifyAddonPublicKeyPem: keys.pem,
    clockifyAddonKey: ADDON_KEY,
    sessionSecret: "test-session-secret",
    databasePath: ":memory:",
    llmProvider: "http",
    llmBaseUrl: "https://llm.example.com",
    llmApiKey: "llm-key",
    llmModel: "cheap-model",
    llmAgentic: true,
    ...configOverride,
  };
  const store = createStore(":memory:", { encryptionKey: "test-key" });
  stores.push(store);
  store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
  const app = createApp({
    config,
    store,
    parser: createSignatureParser(ADDON_KEY, keys.pem),
    modelClient: scriptedToolModel(script),
    clockifyForWorkspace: () => fake.client,
  });
  const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
    workspaceId: "ws-1",
    user: "admin-1",
    workspaceRole: "ADMIN",
    addonId: "addon-1",
  });
  const res = await request(app).get("/component/assistant").query({ auth_token: token });
  const setCookie = res.headers["set-cookie"];
  return { app, cookie: Array.isArray(setCookie) ? setCookie[0].split(";")[0] : "" };
}

describe("POST /api/chat/new", () => {
  it("requires a session", async () => {
    const { app } = await makeApp([], createFakeWorkspace());
    const res = await request(app).post("/api/chat/new");
    expect(res.status).toBe(401);
  });

  it("mints a fresh empty session and keeps the previous chat's messages", async () => {
    const { app, cookie } = await makeApp(
      [
        { text: "Created it.", toolCalls: [{ id: "c1", name: "clockify_tags_create", arguments: { name: "urgent" } }] },
        { text: "Created it.", toolCalls: [] },
      ],
      createFakeWorkspace(),
    );
    // Seed a turn in the current conversation (session A).
    await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "create a tag urgent" });
    const before = await request(app).get("/api/chat/history").set("Cookie", cookie);
    expect((before.body.messages as unknown[]).length).toBeGreaterThan(0);

    // Start a new chat — a NEW session cookie is issued.
    const res = await request(app).post("/api/chat/new").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const setCookie = res.headers["set-cookie"];
    const newCookie = Array.isArray(setCookie) ? setCookie[0].split(";")[0] : "";
    expect(newCookie).not.toBe("");
    expect(newCookie).not.toBe(cookie); // a genuinely different session

    // The new session is a clean slate.
    const fresh = await request(app).get("/api/chat/history").set("Cookie", newCookie);
    expect(fresh.status).toBe(200);
    expect(fresh.body).toEqual({ ok: true, messages: [], pendingPreviews: [] });

    // The previous chat is KEPT: its cookie still resolves and replays its history.
    const old = await request(app).get("/api/chat/history").set("Cookie", cookie);
    expect(old.status).toBe(200);
    expect((old.body.messages as unknown[]).length).toBeGreaterThan(0);
  });

  // Cost-bounding: the chat rate limiter is per-SESSION, so minting fresh sessions
  // via /chat/new would otherwise reset the paid-model-loop budget. A per-ADMIN limit
  // on session creation closes that bypass (the actor is an authenticated admin, but
  // the limiter must still bound how fast they can spin up new budgets).
  it("rate-limits rapid new-chat creation per admin (can't reset the paid-loop budget by minting sessions)", async () => {
    const { app, cookie } = await makeApp([], createFakeWorkspace(), {
      newChatRateLimitMax: 3,
      newChatRateLimitWindowMs: 60_000,
    });
    // The same admin's original cookie keeps resolving (a new chat never invalidates it),
    // so the per-admin key is constant across these calls.
    for (let i = 0; i < 3; i += 1) {
      const ok = await request(app).post("/api/chat/new").set("Cookie", cookie);
      expect(ok.status, `new chat #${i + 1}`).toBe(200);
    }
    const limited = await request(app).post("/api/chat/new").set("Cookie", cookie);
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("rate_limited");
    expect(limited.headers["retry-after"]).toBeDefined();
  });
});
