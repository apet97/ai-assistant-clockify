import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { testing } from "@apet97/clockify-addon-sdk";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import type { AppConfig } from "../../src/config.js";
import type { ModelClient } from "../../src/assistant/model-client.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";

/**
 * Request hardening (TIER1-B). Oversized and over-length inputs must be rejected
 * BEFORE anything is persisted: the JSON body parser caps the payload (a hostile
 * multi-MB body never reaches memory/the store), and the chat/confirm schemas cap
 * the message/nonce length at parse (chatPreconditions/confirm parse before
 * executeChatTurn → addMessage). A normal turn is unaffected.
 */
const ADDON_KEY = "ai-assistant";

let keys: { privateKey: unknown; pem: string };
let store: Store;
let app: Express;
const persisted: string[] = [];

// Model that always proposes a safe tag-create (so a valid turn reaches a 200).
const modelClient: ModelClient = {
  async complete() {
    return JSON.stringify({
      kind: "actions",
      text: "Creating the tag.",
      actions: [{ name: "clockify_tags_create", arguments: { name: "QA" } }],
    });
  },
};

async function adminCookie(): Promise<string> {
  const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
    workspaceId: "ws-1",
    user: "admin-1",
    workspaceRole: "ADMIN",
    addonId: "addon-1",
  });
  const res = await request(app).get("/component/assistant").query({ auth_token: token });
  const setCookie = res.headers["set-cookie"];
  return Array.isArray(setCookie) ? setCookie[0].split(";")[0] : "";
}

beforeAll(async () => {
  keys = await testing.generateTestKeys();
  const config: AppConfig = {
    nodeEnv: "test",
    port: 3994,
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
  // Record every persisted user message so "no persist before reject" is provable.
  const realAddMessage = store.addMessage.bind(store);
  store.addMessage = (msg) => {
    if (msg.role === "user") persisted.push(msg.content);
    return realAddMessage(msg);
  };
  const parser = createSignatureParser(ADDON_KEY, keys.pem);
  app = createApp({
    config,
    store,
    parser,
    modelClient,
    clockifyForWorkspace: () => createFakeWorkspace().client,
  });
});

afterAll(() => store.close());

describe("chat input limits", () => {
  it("rejects a body over the 32kb limit before persisting anything", async () => {
    const cookie = await adminCookie();
    const huge = "x".repeat(40_000); // ~40kb body, over the 32kb parser limit
    persisted.length = 0;
    const res = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: huge });

    expect(res.status).toBe(413); // payload too large — a client error, not a 500
    expect(persisted).not.toContain(huge); // never reached executeChatTurn/addMessage
  });

  it("rejects a message over 4000 chars at parse (no persist), accepts exactly 4000", async () => {
    const cookie = await adminCookie();

    const tooLong = "a".repeat(4001);
    persisted.length = 0;
    const over = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: tooLong });
    expect(over.status).toBe(400);
    expect(persisted).not.toContain(tooLong); // rejected before addMessage

    const atLimit = "b".repeat(4000);
    const ok = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: atLimit });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(persisted).toContain(atLimit); // a valid turn still persists + runs
  });

  it("rejects a confirmation nonce over 256 chars at parse", async () => {
    const cookie = await adminCookie();
    const res = await request(app)
      .post("/api/confirmations/some-id/confirm")
      .set("Cookie", cookie)
      .send({ nonce: "n".repeat(257) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_args");
  });

  it("still handles a normal message end-to-end (regression)", async () => {
    const cookie = await adminCookie();
    const res = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "create a tag called QA" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
