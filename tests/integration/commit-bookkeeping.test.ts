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
 * Plan 003: the three POST-commit bookkeeping writes in `commitConfirmation`
 * (`setConfirmationResult`, `addAuditEvent`, `recordUndoIfReversible`) are
 * best-effort. The risky write has ALREADY committed (and is durably recorded in
 * the idempotency ledger) by the time they run, so a transient DB error here —
 * e.g. a microsecond `SQLITE_BUSY` — must NOT 500 the confirm and drop the
 * receipt for a change that already happened (money may have moved).
 *
 * To inject the throw without a test-only hook in `src/`, we wrap the real store
 * passed into `createApp`'s deps and override the one bookkeeping method
 * (`createStore` returns an object literal of closures, so spreading keeps every
 * other method's binding intact). A pure risky-write preview (no read executed
 * before the interrupt) never audits during the chat turn, so the wrapped method
 * throws ONLY at confirm time.
 */
const ADDON_KEY = "ai-assistant";

let stores: Store[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores = [];
});

interface TestApp {
  app: Express;
  cookie: string;
  store: Store;
}

async function makeApp(
  script: ToolCompletion[],
  fake: FakeWorkspace,
  wrapStore: (store: Store) => Store = (s) => s,
): Promise<TestApp> {
  const keys = await testing.generateTestKeys();
  const config: AppConfig = {
    nodeEnv: "test",
    port: 3996,
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
  const parser = createSignatureParser(ADDON_KEY, keys.pem);
  const app = createApp({
    config,
    store: wrapStore(store),
    parser,
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
  const cookie = Array.isArray(setCookie) ? setCookie[0].split(";")[0] : "";
  return { app, cookie, store };
}

type ResultItem = { kind: string; previewId?: string; nonce?: string };

function previewsOf(results: ResultItem[]): ResultItem[] {
  return results.filter((r) => r.kind === "preview");
}

const DELETE_TAG: ToolCompletion = {
  text: "Deleting the tag now.",
  toolCalls: [{ id: "r1", name: "clockify_tags_delete", arguments: { name: "urgent" } }],
};

describe("post-commit bookkeeping is best-effort (a DB hiccup can't drop a committed receipt)", () => {
  it("addAuditEvent throwing at confirm does NOT 500: the receipt returns and the commit ran exactly once", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, cookie } = await makeApp([DELETE_TAG], fake, (store) => ({
      ...store,
      addAuditEvent: () => {
        throw new Error("db busy");
      },
    }));

    const chat = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the urgent tag" });
    expect(chat.status).toBe(200);
    const preview = previewsOf(chat.body.results as ResultItem[])[0];
    expect(preview).toBeDefined();
    expect(fake.counts.deleteTag ?? 0).toBe(0);

    const confirm = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });

    // The bookkeeping write threw AFTER the commit. The confirm must still be a
    // 200 carrying the committed receipt — not a 500 that swallows it.
    expect(confirm.status).toBe(200);
    expect(confirm.body.receipt.ok).toBe(true);
    expect(confirm.body.receipt.action).toBe("clockify_tags_delete");
    // The commit happened exactly once on the underlying host.
    expect(fake.counts.deleteTag).toBe(1);
    expect(fake.state.tags.find((t) => t.id === "t1")).toBeUndefined();
  });

  it("setConfirmationResult throwing at confirm does NOT 500 either (covers the other bookkeeping write)", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, cookie } = await makeApp([DELETE_TAG], fake, (store) => ({
      ...store,
      setConfirmationResult: () => {
        throw new Error("db busy");
      },
    }));

    const chat = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the urgent tag" });
    expect(chat.status).toBe(200);
    const preview = previewsOf(chat.body.results as ResultItem[])[0];
    expect(preview).toBeDefined();

    const confirm = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });

    expect(confirm.status).toBe(200);
    expect(confirm.body.receipt.ok).toBe(true);
    expect(fake.counts.deleteTag).toBe(1);
  });
});
