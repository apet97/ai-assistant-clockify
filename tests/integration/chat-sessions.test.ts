import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { testing } from "@apet97/clockify-addon-sdk";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import type { AppConfig } from "../../src/config.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import { scriptedToolModel } from "../helpers/scripted-model.js";
import type { ToolCompletion } from "../../src/assistant/model-client.js";

/**
 * GET /api/chat/sessions (the chat-history switcher list): a session-gated,
 * tenant-scoped list of the admin's live, non-empty conversations, newest-first,
 * each marked `current` for the cookie's own session. The route — not the client
 * — decides which is current (the cookie is HttpOnly, so the UI can't know its
 * own session id). No cookie ⇒ 401, mirroring GET /api/chat/history.
 */
const ADDON_KEY = "ai-assistant";

let stores: Store[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores = [];
});

async function makeApp(
  script: ToolCompletion[],
  fake: FakeWorkspace,
): Promise<{ app: Express; cookie: string }> {
  const keys = await testing.generateTestKeys();
  const config: AppConfig = {
    nodeEnv: "test",
    port: 3994,
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
  const cookie = Array.isArray(setCookie) ? setCookie[0].split(";")[0] : "";
  return { app, cookie };
}

describe("GET /api/chat/sessions (chat-history list)", () => {
  it("requires a session (no cookie ⇒ 401)", async () => {
    const { app } = await makeApp([], createFakeWorkspace());
    const res = await request(app).get("/api/chat/sessions");
    expect(res.status).toBe(401);
  });

  it("lists the admin's live non-empty conversations newest-first and marks the cookie's session current", async () => {
    // Two replies per "turn" because tags_create previews then commits in the
    // scripted model; here the model just answers — one user message per session
    // is enough to make a session non-empty (and give it a title).
    const { app, cookie } = await makeApp(
      [{ text: "Sure.", toolCalls: [] }, { text: "Sure.", toolCalls: [] }],
      createFakeWorkspace(),
    );

    // First conversation: a user message in the original session.
    await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "first conversation" });

    // Start a second conversation: /chat/new re-cookies to a FRESH session.
    const fresh = await request(app).post("/api/chat/new").set("Cookie", cookie).send({});
    const sc2 = fresh.headers["set-cookie"];
    const cookie2 = Array.isArray(sc2) ? sc2[0].split(";")[0] : "";
    await request(app).post("/api/chat/messages").set("Cookie", cookie2).send({ message: "second conversation" });

    const res = await request(app).get("/api/chat/sessions").set("Cookie", cookie2);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const sessions = res.body.sessions as Array<{
      id: string;
      title: string;
      messageCount: number;
      lastMessageAt: string;
      current: boolean;
    }>;
    expect(sessions).toHaveLength(2);
    // Newest-first: the second conversation (most recent activity) leads.
    expect(sessions[0]).toMatchObject({ title: "second conversation", current: true });
    expect(sessions[1]).toMatchObject({ title: "first conversation", current: false });
    expect(sessions[0].messageCount).toBeGreaterThan(0);
    expect(typeof sessions[0].lastMessageAt).toBe("string");
    // Exactly one session is the current one (the cookie's session).
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
  });
});
