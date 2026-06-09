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

const ADDON_KEY = "ai-assistant";
let keys: { privateKey: unknown; pem: string };
let store: Store;
let app: Express;
let modelThrows = false;

const modelClient: ModelClient = {
  async complete() {
    if (modelThrows) throw new Error("model down");
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

function parseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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
  store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
  const parser = createSignatureParser(ADDON_KEY, keys.pem);
  app = createApp({ config, store, parser, modelClient, clockifyForWorkspace: () => createFakeWorkspace().client });
});

afterAll(() => store.close());

describe("POST /api/chat/stream (NDJSON)", () => {
  it("streams each harness result, then the truthful reply, then done", async () => {
    modelThrows = false;
    const cookie = await adminCookie();
    const res = await request(app).post("/api/chat/stream").set("Cookie", cookie).send({ message: "create a tag" });
    expect(res.status).toBe(200);
    const events = parseEvents(res.text);

    const resultIdx = events.findIndex((e) => e.type === "result");
    const replyIdx = events.findIndex((e) => e.type === "reply");
    expect(resultIdx).toBeGreaterThanOrEqual(0);
    expect(replyIdx).toBeGreaterThan(resultIdx); // results stream BEFORE the reply
    expect(events[events.length - 1].type).toBe("done");
    const result = events[resultIdx].result as { kind: string };
    expect(result.kind).toBe("receipt");
  });

  it("emits an error event (not a crash) when the model is unavailable", async () => {
    modelThrows = true;
    const cookie = await adminCookie();
    const res = await request(app).post("/api/chat/stream").set("Cookie", cookie).send({ message: "hello" });
    expect(res.status).toBe(200); // the stream itself opened fine
    const events = parseEvents(res.text);
    expect(events.some((e) => e.type === "error" && e.code === "model_unavailable")).toBe(true);
    expect(events[events.length - 1].type).toBe("done");
    modelThrows = false;
  });

  it("rejects an unauthenticated request", async () => {
    const res = await request(app).post("/api/chat/stream").send({ message: "hi" });
    expect(res.status).toBe(401);
  });
});
