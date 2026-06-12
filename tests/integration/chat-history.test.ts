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

/**
 * Session restore (GET /api/chat/history): an iframe reload must replay the
 * stored conversation and re-serve the session's LIVE pending previews with a
 * freshly ROTATED one-use nonce — the streamed original dies, the rotated one
 * confirms, and no nonce ever appears in the replayed messages.
 */
const ADDON_KEY = "ai-assistant";

let stores: Store[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores = [];
});

async function makeApp(script: ToolCompletion[], fake: FakeWorkspace): Promise<{ app: Express; cookie: string }> {
  const keys = await testing.generateTestKeys();
  const config: AppConfig = {
    nodeEnv: "test",
    port: 3995,
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
  return { app, cookie: Array.isArray(setCookie) ? setCookie[0].split(";")[0] : "" };
}

describe("GET /api/chat/history (session restore)", () => {
  it("requires a session", async () => {
    const { app } = await makeApp([], createFakeWorkspace());
    const res = await request(app).get("/api/chat/history");
    expect(res.status).toBe(401);
  });

  it("replays an empty session as empty arrays", async () => {
    const { app, cookie } = await makeApp([], createFakeWorkspace());
    const res = await request(app).get("/api/chat/history").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, messages: [], pendingPreviews: [] });
  });

  it("replays prior turns oldest-first with receipt results, no nonce anywhere, and undo handles stripped", async () => {
    const fake = createFakeWorkspace();
    const { app, cookie } = await makeApp(
      [{ text: "Created it.", toolCalls: [{ id: "c1", name: "clockify_tags_create", arguments: { name: "urgent" } }] },
       { text: "Created it.", toolCalls: [] }],
      fake,
    );
    await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "create a tag urgent" });

    const res = await request(app).get("/api/chat/history").set("Cookie", cookie);
    expect(res.status).toBe(200);
    const { messages, pendingPreviews } = res.body as {
      messages: Array<{ role: string; content: string; results: Array<Record<string, unknown>> }>;
      pendingPreviews: unknown[];
    };
    expect(messages[0]).toMatchObject({ role: "user", content: "create a tag urgent" });
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    const receipt = assistant?.results.find((r) => r.kind === "receipt");
    expect(receipt).toBeDefined();
    expect(receipt).not.toHaveProperty("undo"); // history is a record, not a control surface
    expect(JSON.stringify(res.body)).not.toContain("nonce");
    expect(pendingPreviews).toEqual([]);
  });

  it("re-serves a LIVE pending preview with a ROTATED nonce: the streamed original dies, the rotated one confirms", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, cookie } = await makeApp(
      [{ text: "", toolCalls: [{ id: "c1", name: "clockify_tags_delete", arguments: { name: "urgent" } }] }],
      fake,
    );
    const turn = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the urgent tag" });
    const streamed = (turn.body.results as Array<{ kind: string; previewId?: string; nonce?: string }>).find(
      (r) => r.kind === "preview",
    );
    if (!streamed?.previewId || !streamed.nonce) throw new Error("expected a streamed preview with a nonce");

    const history = await request(app).get("/api/chat/history").set("Cookie", cookie);
    const recovered = (history.body.pendingPreviews as Array<{ previewId: string; nonce: string; expiresAt: string; preview: unknown }>)[0];
    expect(recovered).toBeDefined();
    expect(recovered.previewId).toBe(streamed.previewId);
    expect(recovered.nonce).not.toBe(streamed.nonce);
    expect(recovered.preview).toBeTruthy();

    // The ORIGINAL streamed nonce is dead after rotation (one-use preserved).
    const stale = await request(app)
      .post(`/api/confirmations/${streamed.previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: streamed.nonce });
    expect(stale.status).toBe(400);

    // The ROTATED nonce commits.
    const fresh = await request(app)
      .post(`/api/confirmations/${recovered.previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: recovered.nonce });
    expect(fresh.status).toBe(200);
    expect(fake.state.tags.find((t) => t.id === "t1")).toBeUndefined();
  });

  it("does not re-serve cancelled previews", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, cookie } = await makeApp(
      [{ text: "", toolCalls: [{ id: "c1", name: "clockify_tags_delete", arguments: { name: "urgent" } }] }],
      fake,
    );
    const turn = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the urgent tag" });
    const streamed = (turn.body.results as Array<{ kind: string; previewId?: string }>).find((r) => r.kind === "preview");
    await request(app)
      .post(`/api/confirmations/${streamed?.previewId}/cancel`)
      .set("Cookie", cookie)
      .send({});

    const history = await request(app).get("/api/chat/history").set("Cookie", cookie);
    expect(history.body.pendingPreviews).toEqual([]);
  });
});
