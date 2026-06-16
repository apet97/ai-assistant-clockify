import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { testing } from "@apet97/clockify-addon-sdk";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { makeTestConfig } from "../helpers/config.js";
import type { ModelClient } from "../../src/assistant/model-client.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";

const ADDON_KEY = "ai-assistant";
let keys: { privateKey: unknown; pem: string };
let store: Store;
let app: Express;
let fake: FakeWorkspace;

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
  const config = makeTestConfig({
    clockifyAddonPublicKeyPem: keys.pem,
    clockifyAddonKey: ADDON_KEY,
  });
  store = createStore(":memory:", { encryptionKey: "test-key" });
  store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
  fake = createFakeWorkspace();
  const parser = createSignatureParser(ADDON_KEY, keys.pem);
  app = createApp({ config, store, parser, modelClient, clockifyForWorkspace: () => fake.client });
});

afterAll(() => store.close());

describe("GET /api/metrics", () => {
  it("reports per-action outcomes after an action has run", async () => {
    const cookie = await adminCookie();
    await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "create a tag" });

    const res = await request(app).get("/api/metrics").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const m = res.body.metrics as {
      totals: { actions: number; succeeded: number };
      byAction: Array<{ action: string; succeeded: number }>;
    };
    expect(m.totals.actions).toBeGreaterThanOrEqual(1);
    expect(m.totals.succeeded).toBeGreaterThanOrEqual(1);
    expect(m.byAction.some((a) => a.action === "clockify_create_work_package")).toBe(true);
  });

  it("rejects an unauthenticated request", async () => {
    const res = await request(app).get("/api/metrics");
    expect(res.status).toBe(401);
  });

  it("reports per-turn usage telemetry (model calls + latency; JSON mode reports no tokens)", async () => {
    const cookie = await adminCookie();
    await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "create another tag" });

    const res = await request(app).get("/api/metrics").set("Cookie", cookie);
    expect(res.status).toBe(200);
    const usage = res.body.metrics.usage as {
      turns: number;
      modelCalls: number;
      promptTokens: number;
      avgTurnMs: number;
      last24h: { turns: number };
    };
    expect(usage.turns).toBeGreaterThanOrEqual(1);
    expect(usage.modelCalls).toBeGreaterThanOrEqual(1);
    // This suite's model is a plain complete() client — no token counts, honestly zero.
    expect(usage.promptTokens).toBe(0);
    expect(usage.avgTurnMs).toBeGreaterThanOrEqual(0);
    expect(usage.last24h.turns).toBeGreaterThanOrEqual(1);
  });
});
