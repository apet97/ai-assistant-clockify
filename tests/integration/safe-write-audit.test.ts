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
 * F3: post-execution bookkeeping on the SAFE-WRITE chat turn is best-effort.
 *
 * A safe write (`clockify_tags_create`) executes IMMEDIATELY on the host —
 * there is no preview/confirm round-trip. Its receipt is then audited and an
 * undo is recorded via `auditAndEmitReceipt` (`addAuditEvent` +
 * `recordUndoIfReversible`). Plan 003 isolated only the CONFIRM-commit tail; this
 * SAFE-WRITE path was still un-isolated, so a transient DB error in the audit
 * write (e.g. a microsecond SQLITE_BUSY) threw the whole turn AFTER the change had
 * already happened — 502 `model_unavailable` (agentic) / 500 (single-turn), the
 * committed receipt dropped on the floor, and a misleading "try again" inviting a
 * DUPLICATE write.
 *
 * Same injection trick as commit-bookkeeping.test.ts: wrap the real store and
 * override the one bookkeeping method (createStore returns an object literal of
 * closures, so spreading keeps every other binding intact).
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
}

async function makeApp(
  script: ToolCompletion[],
  fake: FakeWorkspace,
  wrapStore: (store: Store) => Store = (s) => s,
  agentic = true,
): Promise<TestApp> {
  const keys = await testing.generateTestKeys();
  const config: AppConfig = {
    nodeEnv: "test",
    port: 3997,
    baseUrl: "https://example.com/ai-assistant",
    clockifyAddonPublicKeyPem: keys.pem,
    clockifyAddonKey: ADDON_KEY,
    sessionSecret: "test-session-secret",
    databasePath: ":memory:",
    llmProvider: "http",
    llmBaseUrl: "https://llm.example.com",
    llmApiKey: "llm-key",
    llmModel: "cheap-model",
    llmAgentic: agentic,
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
  return { app, cookie };
}

const CREATE_TAG: ToolCompletion = {
  text: "Creating the tag.",
  toolCalls: [{ id: "r1", name: "clockify_tags_create", arguments: { name: "newtag" } }],
};

// In the agentic loop the LAST scripted completion repeats until the model stops
// proposing tool calls, so a one-step script would re-fire createTag every
// iteration up to maxSteps. A second, tool-free completion terminates the loop
// after the single safe write (the single-turn path runs each action once and
// needs no terminator).
const DONE: ToolCompletion = { text: "Done — created the tag.", toolCalls: [] };

type ResultItem = { kind: string };

const throwingAudit = (store: Store): Store => ({
  ...store,
  addAuditEvent: () => {
    throw new Error("db busy");
  },
});

// F7: the assistant-reply persistence (`persistAssistantReply` -> `addMessage`)
// runs AFTER the turn's action(s) executed. Make ONLY the assistant-role write
// throw — the user-message write (start of the turn) and the safe write itself
// still succeed, so the change has already happened on the host by the time the
// reply persistence throws. The wrapper delegates every other addMessage call to
// the real store so the user message + history are intact.
const throwingAssistantReplyPersist = (store: Store): Store => ({
  ...store,
  addMessage: (input) => {
    if (input.role === "assistant") {
      throw new Error("db busy");
    }
    store.addMessage(input);
  },
});

describe("safe-write post-execution bookkeeping is best-effort (a DB hiccup can't drop a committed receipt)", () => {
  it("a throwing addAuditEvent on a SAFE-write turn (agentic default) still returns the receipt 200 and does not 502", async () => {
    const fake = createFakeWorkspace({ tags: [] });
    const { app, cookie } = await makeApp([CREATE_TAG, DONE], fake, throwingAudit, true);

    const chat = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "create a tag called newtag" });

    // The safe write ALREADY ran on the host; the audit threw AFTER it. The turn
    // must be a 200 carrying the committed receipt — not a 502 model_unavailable.
    expect(chat.status).toBe(200);
    expect(fake.counts.createTag).toBe(1);
    const receipts = (chat.body.results as ResultItem[]).filter((r) => r.kind === "receipt");
    expect(receipts.length).toBeGreaterThan(0);
  });

  it("a throwing addAuditEvent on a SAFE-write turn (single-turn) still returns the receipt 200 and does not 500", async () => {
    const fake = createFakeWorkspace({ tags: [] });
    const { app, cookie } = await makeApp([CREATE_TAG], fake, throwingAudit, false);

    const chat = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "create a tag called newtag" });

    expect(chat.status).toBe(200);
    expect(fake.counts.createTag).toBe(1);
    const receipts = (chat.body.results as ResultItem[]).filter((r) => r.kind === "receipt");
    expect(receipts.length).toBeGreaterThan(0);
  });
});

describe("F7: assistant-reply persistence is best-effort (a throwing addMessage can't 500 a turn whose write already ran)", () => {
  it("a throwing assistant-reply addMessage on a SAFE-write turn (agentic default) still returns the receipt 200 and does not 502", async () => {
    const fake = createFakeWorkspace({ tags: [] });
    const { app, cookie } = await makeApp([CREATE_TAG, DONE], fake, throwingAssistantReplyPersist, true);

    const chat = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "create a tag called newtag" });

    // The safe write ALREADY ran on the host; persisting the assistant reply threw
    // AFTER it. The turn must be a 200 carrying the committed receipt — not a 502.
    expect(chat.status).toBe(200);
    expect(fake.counts.createTag).toBe(1);
    const receipts = (chat.body.results as ResultItem[]).filter((r) => r.kind === "receipt");
    expect(receipts.length).toBeGreaterThan(0);
  });

  it("a throwing assistant-reply addMessage on a SAFE-write turn (single-turn) still returns the receipt 200 and does not 500", async () => {
    const fake = createFakeWorkspace({ tags: [] });
    const { app, cookie } = await makeApp([CREATE_TAG], fake, throwingAssistantReplyPersist, false);

    const chat = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "create a tag called newtag" });

    expect(chat.status).toBe(200);
    expect(fake.counts.createTag).toBe(1);
    const receipts = (chat.body.results as ResultItem[]).filter((r) => r.kind === "receipt");
    expect(receipts.length).toBeGreaterThan(0);
  });
});
