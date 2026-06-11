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
import { defaultAdminPolicy } from "../../src/harness/permissions.js";

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

async function adminCookieFor(targetApp: Express, user = "admin-1"): Promise<string> {
  const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
    workspaceId: "ws-1",
    user,
    workspaceRole: "ADMIN",
    addonId: "addon-1",
  });
  const res = await request(targetApp).get("/component/assistant").query({ auth_token: token });
  const setCookie = res.headers["set-cookie"];
  return Array.isArray(setCookie) ? setCookie[0].split(";")[0] : "";
}

async function adminCookie(): Promise<string> {
  return adminCookieFor(app);
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

  // Mirrors routes.test.ts "a confirm denied by lowered policy does not consume the
  // preview" for the undo route: the policy re-check must run BEFORE markUndone, so a
  // lowered policy denies cleanly without burning the one-use record. Uses its own
  // store/fake so the shared-suite tag (and its idempotency window) can't suppress the
  // fresh undo handle this assertion depends on.
  it("an undo denied by lowered policy does not burn the one-use record", async () => {
    const isoStore = createStore(":memory:", { encryptionKey: "test-key" });
    isoStore.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
    const isoFake = createFakeWorkspace();
    const isoApp = createApp({
      config: {
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
      },
      store: isoStore,
      parser: createSignatureParser(ADDON_KEY, keys.pem),
      modelClient,
      clockifyForWorkspace: () => isoFake.client,
    });

    const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: "ws-1",
      user: "admin-1",
      workspaceRole: "ADMIN",
      addonId: "addon-1",
    });
    const auth = await request(isoApp).get("/component/assistant").query({ auth_token: token });
    const setCookie = auth.headers["set-cookie"];
    const cookie = Array.isArray(setCookie) ? setCookie[0].split(";")[0] : "";

    const chat = await request(isoApp).post("/api/chat/messages").set("Cookie", cookie).send({ message: "create a tag" });
    expect(chat.status).toBe(200);
    const receiptResult = (chat.body.results as Array<{ kind: string; undo?: { id: string } }>).find(
      (r) => r.kind === "receipt",
    );
    const undoId = receiptResult?.undo?.id;
    expect(typeof undoId).toBe("string");
    expect(isoFake.state.deleted.length).toBe(0);

    // Lower the policy to read-only for the tag's group AFTER the undo handle was issued.
    const lowered = defaultAdminPolicy();
    lowered.groups.work_structure = "read";
    isoStore.upsertAdminPolicy("ws-1", "admin-1", lowered);

    // Deny-before-burn: the policy re-check rejects (400) WITHOUT consuming the record
    // and WITHOUT deleting the entity.
    const denied = await request(isoApp).post(`/api/undo/${undoId}`).set("Cookie", cookie).send({});
    expect(denied.status).toBe(400);
    expect(denied.body.code).toBe("policy_denied");
    expect(isoFake.state.deleted.length).toBe(0);

    // Re-enable write access and undo the SAME record — it was never burned, so it reverses now.
    isoStore.upsertAdminPolicy("ws-1", "admin-1", defaultAdminPolicy());
    const ok = await request(isoApp).post(`/api/undo/${undoId}`).set("Cookie", cookie).send({});
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(isoFake.state.deleted.some((d) => d.entityType === "tag")).toBe(true);

    isoStore.close();
  });

  // Ownership arm: an undo handle is bound to the creating admin. A SECOND admin with a
  // valid session in the SAME workspace must NOT be able to undo admin-1's creation —
  // undo performs destructive deletes, so a cross-admin attempt 404s with no deletion and
  // does NOT consume the record (admin-1 can still undo it afterward). Uses its own
  // store/fake so the shared-suite tag's idempotency window can't suppress the fresh undo
  // handle this assertion depends on.
  it("404s a cross-admin undo without deleting or consuming the record", async () => {
    const isoStore = createStore(":memory:", { encryptionKey: "test-key" });
    isoStore.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
    const isoFake = createFakeWorkspace();
    const isoApp = createApp({
      config: {
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
      },
      store: isoStore,
      parser: createSignatureParser(ADDON_KEY, keys.pem),
      modelClient,
      clockifyForWorkspace: () => isoFake.client,
    });

    // admin-1 creates a tag -> gets an undo handle bound to admin-1.
    const adminOne = await adminCookieFor(isoApp, "admin-1");
    const chat = await request(isoApp).post("/api/chat/messages").set("Cookie", adminOne).send({ message: "create a tag" });
    expect(chat.status).toBe(200);
    const receiptResult = (chat.body.results as Array<{ kind: string; undo?: { id: string } }>).find(
      (r) => r.kind === "receipt",
    );
    const undoId = receiptResult?.undo?.id;
    expect(typeof undoId).toBe("string");
    expect(isoFake.state.deleted.length).toBe(0);

    // admin-2 (valid session, same workspace, ADMIN) tries to undo admin-1's record.
    const adminTwo = await adminCookieFor(isoApp, "admin-2");
    const foreign = await request(isoApp).post(`/api/undo/${undoId}`).set("Cookie", adminTwo).send({});
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe("not_found");
    // No deletion happened, and the record was NOT consumed by the foreign attempt.
    expect(isoFake.state.deleted.length).toBe(0);

    // The owning admin can still undo the SAME record — it was never burned.
    const owned = await request(isoApp).post(`/api/undo/${undoId}`).set("Cookie", adminOne).send({});
    expect(owned.status).toBe(200);
    expect(owned.body.ok).toBe(true);
    expect(isoFake.state.deleted.some((d) => d.entityType === "tag")).toBe(true);

    isoStore.close();
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
