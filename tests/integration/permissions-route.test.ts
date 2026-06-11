import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { testing } from "@apet97/clockify-addon-sdk";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import type { AppConfig } from "../../src/config.js";
import type { ModelClient } from "../../src/assistant/model-client.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import type { Express } from "express";

/**
 * test-gaps-07: the admin's mechanism for RESTRICTING the assistant —
 * POST /api/permissions/confirm — was entirely unpinned at the route level
 * (the UI's only policy-save path, ui/main.ts saves via this route). These
 * tests pin that the saved policy is EFFECTIVE (an action through the gate is
 * actually denied), an audit event is written, an invalid patch is rejected
 * WITHOUT persisting, and the route requires a session.
 */
const ADDON_KEY = "ai-assistant";

let keys: { privateKey: unknown; pem: string };
let store: Store;
let app: Express;
let fake: FakeWorkspace;

// A model that, on "list invoices", proposes the read action `clockify_invoices_list`
// (feature group `invoices`). When the admin has disabled that group, the harness
// gate denies the read before it reaches the fake host.
const modelClient: ModelClient = {
  async complete(messages) {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const text = lastUser?.content ?? "";
    if (text.toLowerCase().includes("list invoices")) {
      return JSON.stringify({
        kind: "actions",
        text: "Listing your invoices.",
        actions: [{ name: "clockify_invoices_list", arguments: {} }],
      });
    }
    return JSON.stringify({ kind: "answer", text: "Hello, admin." });
  },
};

async function adminCookie(): Promise<string> {
  const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
    workspaceId: "ws-1",
    user: "admin-1",
    workspaceRole: "ADMIN",
    backendUrl: "https://api.clockify.me",
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
  store.saveInstallation({
    workspaceId: "ws-1",
    addonId: "addon-1",
    addonUserId: "addon-user-1",
    addonToken: "addon-token",
  });
  const parser = createSignatureParser(ADDON_KEY, keys.pem);
  // No invoices seed needed: the gate denies the read BEFORE the handler ever
  // touches the fake host, so the proof is the policy_denied receipt, not data.
  fake = createFakeWorkspace();
  app = createApp({
    config,
    store,
    parser,
    modelClient,
    clockifyForWorkspace: () => fake.client,
  });
});

afterAll(() => store.close());

describe("POST /api/permissions/confirm (the UI's policy-save path)", () => {
  it("requires a session", async () => {
    const res = await request(app)
      .post("/api/permissions/confirm")
      .send({ groups: { invoices: "off" } });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("unauthorized");
  });

  it("persists a valid patch, writes a permission_change audit event, and the save is EFFECTIVE (a later invoices action is denied)", async () => {
    const cookie = await adminCookie();

    // Sanity: a fresh admin starts at full read_write — the action would be allowed.
    expect(store.getAdminPolicy("ws-1", "admin-1")).toBeUndefined();

    const before = store.listActionOutcomes("ws-1", "admin-1").length;

    const save = await request(app)
      .post("/api/permissions/confirm")
      .set("Cookie", cookie)
      .send({ groups: { invoices: "off" } });
    expect(save.status).toBe(200);
    expect(save.body.ok).toBe(true);

    // The route persisted `next` (the merged policy), NOT `base`: invoices is off,
    // every other group still read_write.
    const saved = store.getAdminPolicy("ws-1", "admin-1");
    expect(saved?.groups.invoices).toBe("off");
    expect(saved?.groups.time_tracking).toBe("read_write");

    // An audit event for the policy change was written (risk ['permission_change']).
    const outcomes = store.listActionOutcomes("ws-1", "admin-1");
    expect(outcomes.length).toBe(before + 1);
    const audited = outcomes.find((o) => o.actionName === "assistant_update_permissions");
    expect(audited).toBeDefined();
    expect(audited?.ok).toBe(true);

    // The save is EFFECTIVE: a chat turn proposing an invoices read is now denied
    // by the gate — a visible policy_denied receipt, not a silent allow.
    const chat = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "list invoices" });
    expect(chat.status).toBe(200);
    const receipt = chat.body.results.find((r: { kind: string }) => r.kind === "receipt");
    expect(receipt).toBeDefined();
    expect(receipt.receipt.ok).toBe(false);
    expect(receipt.receipt.code).toBe("policy_denied");

    // Restore full permissions so later tests start clean.
    store.upsertAdminPolicy("ws-1", "admin-1", defaultAdminPolicy());
  });

  it("rejects an unknown feature group with 400 and persists nothing", async () => {
    const cookie = await adminCookie();
    const baseline = store.getAdminPolicy("ws-1", "admin-1");

    const res = await request(app)
      .post("/api/permissions/confirm")
      .set("Cookie", cookie)
      .send({ groups: { not_a_group: "off" } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_args");

    // Unchanged: the bad patch never reached upsertAdminPolicy.
    expect(store.getAdminPolicy("ws-1", "admin-1")).toEqual(baseline);
  });

  it("rejects an invalid permission level with 400 and persists nothing", async () => {
    const cookie = await adminCookie();
    const baseline = store.getAdminPolicy("ws-1", "admin-1");

    const res = await request(app)
      .post("/api/permissions/confirm")
      .set("Cookie", cookie)
      .send({ groups: { invoices: "yes" } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_args");
    expect(store.getAdminPolicy("ws-1", "admin-1")).toEqual(baseline);
  });
});

describe("POST /api/permissions/preview", () => {
  it("requires a session", async () => {
    const res = await request(app)
      .post("/api/permissions/preview")
      .send({ groups: { invoices: "off" } });
    expect(res.status).toBe(401);
  });

  it("computes a non-persisting preview: current vs next + the changed groups", async () => {
    const cookie = await adminCookie();
    const before = store.getAdminPolicy("ws-1", "admin-1");

    const res = await request(app)
      .post("/api/permissions/preview")
      .set("Cookie", cookie)
      .send({ groups: { invoices: "off" } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.preview.current.groups.invoices).toBe("read_write");
    expect(res.body.preview.next.groups.invoices).toBe("off");
    expect(res.body.preview.changedGroups).toEqual(["invoices"]);

    // A preview NEVER persists.
    expect(store.getAdminPolicy("ws-1", "admin-1")).toEqual(before);
  });
});
