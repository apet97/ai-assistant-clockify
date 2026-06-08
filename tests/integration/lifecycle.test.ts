import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { testing } from "@apet97/clockify-addon-sdk";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser, ClockifyHeaders } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import type { AppConfig } from "../../src/config.js";
import type { ModelClient } from "../../src/assistant/model-client.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";

/**
 * The INSTALLED lifecycle hook is the ONLY time Clockify hands us the
 * non-expiring installation token, so it must persist on a valid signed token.
 * Before this suite the endpoint had no coverage, and a broken/placeholder
 * verification key (or over-strict payload validation) silently 401/400'd every
 * install. These tests pin the contract end-to-end.
 */
const ADDON_KEY = "ai-assistant";
const LIFECYCLE_HEADER = ClockifyHeaders.LIFECYCLE_TOKEN;

let keys: { privateKey: unknown; pem: string };
let store: Store;
let app: Express;

const modelClient: ModelClient = {
  async complete() {
    return JSON.stringify({ kind: "answer", text: "unused" });
  },
};

async function lifecycleToken(claims: Record<string, unknown>): Promise<string> {
  return testing.signTestToken(keys.privateKey, ADDON_KEY, claims);
}

beforeAll(async () => {
  keys = await testing.generateTestKeys();
  const config: AppConfig = {
    nodeEnv: "test",
    port: 3998,
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
  const parser = createSignatureParser(ADDON_KEY, keys.pem);
  const fake = createFakeWorkspace();
  app = createApp({
    config,
    store,
    parser,
    modelClient,
    clockifyForWorkspace: () => fake.client,
  });
});

afterAll(() => store.close());

describe("POST /lifecycle/installed", () => {
  it("persists the installation token on a valid signed token", async () => {
    const token = await lifecycleToken({
      workspaceId: "ws-install",
      addonId: "addon-install",
      backendUrl: "https://api.clockify.me",
    });
    const res = await request(app)
      .post("/lifecycle/installed")
      .set(LIFECYCLE_HEADER, token)
      .send({
        addonId: "addon-install",
        authToken: "install-token-xyz",
        workspaceId: "ws-install",
        asUser: "owner-1",
        apiUrl: "https://api.clockify.me",
        addonUserId: "addon-user-1",
        webhooks: [],
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const saved = store.getInstallation("ws-install");
    expect(saved?.addonToken).toBe("install-token-xyz");
    expect(saved?.addonId).toBe("addon-install");
    expect(saved?.addonUserId).toBe("addon-user-1");
    expect(saved?.status).toBe("active");
    expect(saved?.installedByUserId).toBe("owner-1");
    expect(saved?.backendUrl).toBe("https://api.clockify.me");
  });

  it("rejects an unsigned/invalid lifecycle token with 401", async () => {
    const res = await request(app)
      .post("/lifecycle/installed")
      .set(LIFECYCLE_HEADER, "not-a-real-jwt")
      .send({ workspaceId: "ws-x", addonId: "a", authToken: "t" });
    expect(res.status).toBe(401);
    expect(store.getInstallation("ws-x")).toBeUndefined();
  });

  it("rejects when the signed token header is absent with 401", async () => {
    const res = await request(app)
      .post("/lifecycle/installed")
      .send({ workspaceId: "ws-y", addonId: "a", authToken: "t" });
    expect(res.status).toBe(401);
    expect(store.getInstallation("ws-y")).toBeUndefined();
  });

  it("returns 400 when the installation token is missing from the payload", async () => {
    const token = await lifecycleToken({ workspaceId: "ws-noauth", addonId: "a" });
    const res = await request(app)
      .post("/lifecycle/installed")
      .set(LIFECYCLE_HEADER, token)
      .send({ workspaceId: "ws-noauth", addonId: "a" });
    expect(res.status).toBe(400);
    expect(store.getInstallation("ws-noauth")).toBeUndefined();
  });

  it("still installs when optional metadata (addonUserId) is absent", async () => {
    const token = await lifecycleToken({
      workspaceId: "ws-minimal",
      addonId: "addon-minimal",
    });
    const res = await request(app)
      .post("/lifecycle/installed")
      .set(LIFECYCLE_HEADER, token)
      .send({ authToken: "minimal-token" });

    expect(res.status).toBe(200);
    const saved = store.getInstallation("ws-minimal");
    expect(saved?.addonToken).toBe("minimal-token");
    // workspaceId and addonId fall back to the verified token claims.
    expect(saved?.addonId).toBe("addon-minimal");
    expect(saved?.addonUserId).toBe("");
  });
});
