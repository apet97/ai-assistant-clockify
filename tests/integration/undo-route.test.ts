import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { testing } from "@apet97/clockify-addon-sdk";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import type { AppConfig } from "../../src/config.js";
import type { ModelClient } from "../../src/assistant/model-client.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";

const ADDON_KEY = "ai-assistant";

let keys: { privateKey: unknown; pem: string };
let store: Store;
let app: Express;
let fake: FakeWorkspace;

// JSON-mode model that proposes a safe create (a tag — a reversible creation).
const modelClient: ModelClient = {
  async complete() {
    return JSON.stringify({
      kind: "actions",
      text: "Creating the tag.",
      actions: [{ name: "clockify_create_work_package", arguments: { tag: { name: "Deep Work" } } }],
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
  store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
  fake = createFakeWorkspace();
  const parser = createSignatureParser(ADDON_KEY, keys.pem);
  app = createApp({ config, store, parser, modelClient, clockifyForWorkspace: () => fake.client });
});

afterAll(() => store.close());

describe("undo route", () => {
  it("attaches an undo handle to a create receipt and reverses it on POST /undo/:id", async () => {
    const cookie = await adminCookie();
    const chat = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "create a tag" });
    expect(chat.status).toBe(200);
    const receiptResult = (chat.body.results as Array<{ kind: string; receipt?: { ok: boolean }; undo?: { id: string } }>).find(
      (r) => r.kind === "receipt",
    );
    expect(receiptResult?.receipt?.ok).toBe(true);
    const undoId = receiptResult?.undo?.id;
    expect(typeof undoId).toBe("string");
    expect(fake.counts.createTag).toBe(1);

    const undo = await request(app).post(`/api/undo/${undoId}`).set("Cookie", cookie).send({});
    expect(undo.status).toBe(200);
    expect(undo.body.ok).toBe(true);
    expect(fake.state.deleted.some((d) => d.entityType === "tag")).toBe(true);

    // one-use: a second undo is rejected
    const again = await request(app).post(`/api/undo/${undoId}`).set("Cookie", cookie).send({});
    expect(again.status).toBe(409);
  });

  it("404s an unknown undo id", async () => {
    const cookie = await adminCookie();
    const res = await request(app).post("/api/undo/does-not-exist").set("Cookie", cookie).send({});
    expect(res.status).toBe(404);
  });

  it("rejects an unauthenticated undo", async () => {
    const res = await request(app).post("/api/undo/whatever").send({});
    expect(res.status).toBe(401);
  });
});
