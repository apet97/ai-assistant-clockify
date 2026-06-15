import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { testing } from "@apet97/clockify-addon-sdk";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import type { AppConfig } from "../../src/config.js";
import type { ModelClient, ToolDefinition } from "../../src/assistant/model-client.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { ACTION_CATALOG } from "../../src/harness/catalog.js";
import { CORE_ACTION_NAMES } from "../../src/harness/tool-select.js";

/**
 * Wiring proof for LLM_TOOL_SELECT (Phase 1): the chat turn shows the model the
 * relevant SUBSET of tools (not all 139) when the flag is on, gated off otherwise,
 * and the recall escape hatch retries with the full catalog when a narrowed turn
 * did nothing. We capture the `tools` array handed to completeWithTools.
 */
const ADDON_KEY = "ai-assistant";
let keys: { privateKey: unknown; pem: string };

function config(llmToolSelect: boolean): AppConfig {
  return {
    nodeEnv: "test",
    port: 3990,
    baseUrl: "https://example.com/ai-assistant",
    clockifyAddonPublicKeyPem: keys.pem,
    clockifyAddonKey: ADDON_KEY,
    sessionSecret: "test-session-secret",
    databasePath: ":memory:",
    llmBaseUrl: "https://llm.example.com",
    llmApiKey: "llm-key",
    llmModel: "cheap-model",
    llmProvider: "http",
    llmMode: "tool",
    llmAgentic: true,
    llmToolSelect,
  };
}

function build(llmToolSelect: boolean): { app: Express; captured: string[][]; store: Store } {
  const captured: string[][] = [];
  const modelClient: ModelClient = {
    async complete() {
      return JSON.stringify({ kind: "answer", text: "ok" });
    },
    async completeWithTools(_messages, tools: ToolDefinition[]) {
      captured.push(tools.map((t) => t.name));
      return { text: "Here's what I found.", toolCalls: [] }; // execute nothing → settles as final
    },
  };
  const store = createStore(":memory:", { encryptionKey: "test-key" });
  store.saveInstallation({
    workspaceId: "ws-1",
    addonId: "addon-1",
    addonUserId: "addon-user-1",
    addonToken: "addon-token",
  });
  const app = createApp({
    config: config(llmToolSelect),
    store,
    parser: createSignatureParser(ADDON_KEY, keys.pem),
    modelClient,
    clockifyForWorkspace: () => createFakeWorkspace().client,
  });
  return { app, captured, store };
}

async function cookieFor(app: Express): Promise<string> {
  const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
    workspaceId: "ws-1",
    user: "admin-1",
    workspaceRole: "ADMIN",
    addonId: "addon-1",
  });
  const res = await request(app).get("/component/assistant").query({ auth_token: token });
  const sc = res.headers["set-cookie"];
  return Array.isArray(sc) ? sc[0].split(";")[0] : "";
}

beforeAll(async () => {
  keys = await testing.generateTestKeys();
});

describe("tool subsetting wiring (LLM_TOOL_SELECT)", () => {
  it("OFF: the model sees the full catalog, exactly once", async () => {
    const b = build(false);
    const cookie = await cookieFor(b.app);
    const res = await request(b.app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "create an invoice for Acme Corp" });
    expect(res.status).toBe(200);
    expect(b.captured).toHaveLength(1);
    expect(b.captured[0]).toHaveLength(ACTION_CATALOG.length);
    b.store.close();
  });

  it("ON: the model sees a relevant SUBSET, then the escape hatch retries with the full catalog", async () => {
    const b = build(true);
    const cookie = await cookieFor(b.app);
    const res = await request(b.app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "create an invoice for Acme Corp" });
    expect(res.status).toBe(200);
    expect(b.captured).toHaveLength(2); // subset, then full-catalog retry

    const subset = b.captured[0];
    expect(subset.length).toBeLessThan(ACTION_CATALOG.length); // genuinely narrowed
    expect(subset).toContain("clockify_invoices_create"); // the relevant tool is present
    expect(subset).not.toContain("clockify_start_timer"); // unrelated tool hidden

    expect(b.captured[1]).toHaveLength(ACTION_CATALOG.length); // escape hatch → full catalog
    b.store.close();
  });

  it("ON + smalltalk: collapses to the core and does NOT retry (not narrowed)", async () => {
    const b = build(true);
    const cookie = await cookieFor(b.app);
    const res = await request(b.app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "hello there, how are you" });
    expect(res.status).toBe(200);
    expect(b.captured).toHaveLength(1); // no escape-hatch retry for smalltalk
    expect(new Set(b.captured[0])).toEqual(CORE_ACTION_NAMES);
    b.store.close();
  });
});
