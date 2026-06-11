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
 * A whitespace-only chat message ("   ") is no input at all. The route must
 * treat it as empty and ask the admin what they want — it must NEVER reach the
 * planner, where the model guesses a tool call and fabricates a context
 * (live finding new-6: a blank turn invoked clockify_review_day / clockify_status
 * unsolicited). This model ALWAYS proposes a tool call, so any model contact
 * leaves a receipt in the results — the guard must produce none.
 */
const ADDON_KEY = "ai-assistant";

let keys: { privateKey: unknown; pem: string };
let store: Store;
let app: Express;

// Model that, if ever reached, proposes a safe tag-create. A whitespace-only
// turn must short-circuit BEFORE this runs (zero results).
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
    port: 3996,
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

describe("chat route empty/whitespace message", () => {
  it("a whitespace-only message asks for input instead of invoking tools", async () => {
    const cookie = await adminCookie();
    const res = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "   " });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // The guard short-circuits BEFORE the model: no tool was invoked.
    expect(res.body.results).toEqual([]);
    // It asks the admin what they want, rather than fabricating an answer.
    expect(res.body.reply.text.length).toBeGreaterThan(0);
  });

  it("a tab/newline-only message is also treated as empty", async () => {
    const cookie = await adminCookie();
    const res = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "\t\n " });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.results).toEqual([]);
  });
});
