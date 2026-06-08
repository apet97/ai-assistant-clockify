import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { testing } from "@apet97/clockify-addon-sdk";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import type { AppConfig } from "../../src/config.js";
import type { ModelClient } from "../../src/assistant/model-client.js";
import type { WorkspaceClient } from "../../src/clockify/client.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";

/**
 * A safe write whose Clockify call throws (e.g. the API returns 401) must come
 * back as an error receipt — it must NOT crash the process. Express 4 does not
 * catch async throws, so before the guard this took the whole server down.
 */
const ADDON_KEY = "ai-assistant";

let keys: { privateKey: unknown; pem: string };
let store: Store;
let app: Express;

// Model that always proposes a safe tag-create.
const modelClient: ModelClient = {
  async complete() {
    return JSON.stringify({
      kind: "actions",
      text: "Creating the tag.",
      actions: [{ name: "clockify_tags_create", arguments: { name: "QA" } }],
    });
  },
};

// Clockify client whose createTag rejects like a live 401 (message carries no secret).
function throwingClient(): WorkspaceClient {
  return {
    ...createFakeWorkspace().client,
    async createTag() {
      throw new Error(
        'Clockify POST /workspaces/ws-1/tags -> 401: {"message":"Token is not valid","code":4017}',
      );
    },
  };
}

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
    port: 3997,
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
    clockifyForWorkspace: throwingClient,
  });
});

afterAll(() => store.close());

describe("chat route resilience", () => {
  it("returns an error receipt (not a crash) when a safe write throws", async () => {
    const cookie = await adminCookie();
    const res = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "create a tag called QA" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const receiptResult = (res.body.results as Array<{ kind: string; receipt?: { ok: boolean } }>).find(
      (r) => r.kind === "receipt",
    );
    expect(receiptResult?.receipt?.ok).toBe(false);
  });

  it("stays up for the next request after a failure", async () => {
    const cookie = await adminCookie();
    const res = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "again" });
    expect(res.status).toBe(200);
  });
});
