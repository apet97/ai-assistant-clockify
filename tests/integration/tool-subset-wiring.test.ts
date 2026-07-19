import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { testKeys } from "../helpers/test-keys.js";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import type { AppConfig } from "../../src/config.js";
import { makeTestConfig } from "../helpers/config.js";
import type { ModelClient, ToolDefinition } from "../../src/assistant/model-client.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { ACTION_CATALOG } from "../../src/harness/catalog.js";
import { scriptedToolModel, type ScriptedToolModel } from "../helpers/scripted-model.js";
import { mintAdminCookie } from "../helpers/session.js";

/**
 * Wiring proof for LLM_TOOL_SELECT (Phase 1): the chat turn shows the model the
 * relevant SUBSET of tools (not the full catalog) when the flag is on, gated off otherwise,
 * and the recall escape hatch retries with the full catalog when a narrowed turn
 * did nothing. We capture the `tools` array handed to completeWithTools.
 */
const ADDON_KEY = "ai-assistant";
let keys: { privateKey: unknown; pem: string };

function config(llmToolSelect: boolean): AppConfig {
  return makeTestConfig({
    clockifyAddonPublicKeyPem: keys.pem,
    clockifyAddonKey: ADDON_KEY,
    llmToolSelect,
  });
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

function cookieFor(store: Store): string {
  return mintAdminCookie(store, "test-session-secret");
}

beforeAll(async () => {
  keys = await testKeys();
});

describe("tool subsetting wiring (LLM_TOOL_SELECT)", () => {
  it("OFF: the model sees the full catalog, exactly once", async () => {
    const b = build(false);
    const cookie = cookieFor(b.store);
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
    const cookie = cookieFor(b.store);
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

  it("ON + smalltalk: fails open to the full catalog and does NOT retry", async () => {
    const b = build(true);
    const cookie = cookieFor(b.store);
    const res = await request(b.app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "hello there, how are you" });
    expect(res.status).toBe(200);
    expect(b.captured).toHaveLength(1); // already full; no escape-hatch retry
    expect(b.captured[0]).toHaveLength(ACTION_CATALOG.length);
    b.store.close();
  });
});

/**
 * STEP 6 — the resume re-sends only the subset too. Until now runResume ran the
 * FULL catalog on every confirm round-trip, halving the savings on every risky-write
 * turn. With LLM_TOOL_SELECT on, the resume re-derives the same menu from the user
 * request in the suspended transcript. Proven safe by the agentic eval (the resume
 * was subsetted there and held 100% / 0 safety on every resume-bearing case). No
 * resume escape hatch: a resume that ends with no tool calls is the NORMAL "done"
 * narration, so the initial-turn guard would fire on every completion.
 */
function buildResume(llmToolSelect: boolean): { app: Express; model: ScriptedToolModel; store: Store } {
  const model = scriptedToolModel([
    // Initial turn: a risky delete → preview → interrupt (one model call, no escape hatch).
    { text: "", toolCalls: [{ id: "r1", name: "clockify_tags_delete", arguments: { name: "urgent" } }] },
    // Resume after confirm: narrate completion, no further tool calls.
    { text: "Done — the urgent tag is gone.", toolCalls: [] },
  ]);
  const store = createStore(":memory:", { encryptionKey: "test-key" });
  store.saveInstallation({
    workspaceId: "ws-1",
    addonId: "addon-1",
    addonUserId: "addon-user-1",
    addonToken: "addon-token",
  });
  const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
  const app = createApp({
    config: config(llmToolSelect),
    store,
    parser: createSignatureParser(ADDON_KEY, keys.pem),
    modelClient: model,
    clockifyForWorkspace: () => fake.client,
  });
  return { app, model, store };
}

type PreviewItem = { kind: string; previewId?: string; nonce?: string };

async function drivePreviewThenConfirm(
  app: Express,
  cookie: string,
  message = "delete the urgent tag",
): Promise<{ confirmStatus: number; confirmOk: boolean }> {
  const chat = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message });
  expect(chat.status).toBe(200);
  const preview = (chat.body.results as PreviewItem[]).find((r) => r.kind === "preview");
  if (!preview) throw new Error("expected a preview from the risky delete");
  const confirm = await request(app)
    .post(`/api/confirmations/${preview.previewId}/confirm`)
    .set("Cookie", cookie)
    .send({ nonce: preview.nonce });
  return { confirmStatus: confirm.status, confirmOk: Boolean(confirm.body?.receipt?.ok) };
}

describe("tool subsetting on RESUME (STEP 6)", () => {
  it("ON: the resume re-sends only the relevant subset, not the full catalog", async () => {
    const b = buildResume(true);
    const cookie = cookieFor(b.store);
    const { confirmStatus, confirmOk } = await drivePreviewThenConfirm(b.app, cookie);
    expect(confirmStatus).toBe(200);
    expect(confirmOk).toBe(true);

    // Exactly two model calls: the initial (subset) turn that previewed, then the resume.
    expect(b.model.calls).toHaveLength(2);
    const initialTools = b.model.calls[0].tools.map((t) => t.name);
    const resumeTools = b.model.calls[1].tools.map((t) => t.name);

    expect(initialTools.length).toBeLessThan(ACTION_CATALOG.length); // initial narrowed
    // The RESUME is narrowed to the SAME menu — this is what STEP 6 changes.
    expect(resumeTools.length).toBeLessThan(ACTION_CATALOG.length);
    expect(resumeTools).toContain("clockify_tags_delete"); // the relevant tool survives
    expect(resumeTools).not.toContain("clockify_start_timer"); // an unrelated area stays hidden
    b.store.close();
  });

  it("OFF: the resume sees the full catalog (byte-identical to before)", async () => {
    const b = buildResume(false);
    const cookie = cookieFor(b.store);
    const { confirmStatus } = await drivePreviewThenConfirm(b.app, cookie);
    expect(confirmStatus).toBe(200);
    expect(b.model.calls).toHaveLength(2);
    expect(b.model.calls[0].tools).toHaveLength(ACTION_CATALOG.length);
    expect(b.model.calls[1].tools).toHaveLength(ACTION_CATALOG.length); // resume = full catalog
    b.store.close();
  });

  // Recall-safety (adversarial-review finding): a request spanning MORE areas than the
  // 3-group clamp keeps would otherwise drop a later step's tool on the resume — with no
  // escape hatch, the model would silently skip an admin-requested step. The resume must
  // widen to the FULL catalog for such sprawling requests so nothing is hidden.
  it("ON + a >3-area request: the resume widens to the FULL catalog (no dropped-group tool hidden)", async () => {
    const b = buildResume(true);
    const cookie = cookieFor(b.store);
    // Four distinct feature groups: users_groups + expenses + scheduling + invoices.
    const fourArea = "deactivate John, log a travel expense of 200, schedule Mary next week, and create an invoice for Acme";
    const { confirmStatus, confirmOk } = await drivePreviewThenConfirm(b.app, cookie, fourArea);
    expect(confirmStatus).toBe(200);
    expect(confirmOk).toBe(true);
    expect(b.model.calls).toHaveLength(2);
    // Recall safety is immediate: both the initial turn and resume fail open.
    expect(b.model.calls[0].tools).toHaveLength(ACTION_CATALOG.length);
    expect(b.model.calls[1].tools).toHaveLength(ACTION_CATALOG.length);
    b.store.close();
  });
});

function buildClarificationResume(): { app: Express; model: ScriptedToolModel; store: Store } {
  const model = scriptedToolModel([
    // First turn: an unknown project produces a grounded harness clarification.
    { text: "", toolCalls: [{ id: "c1", name: "clockify_projects_delete", arguments: { name: "GhostProject" } }] },
    // Follow-up: the admin's terse reply mentions another domain, but the original
    // project request must remain part of tool selection and durable resume state.
    { text: "", toolCalls: [{ id: "c2", name: "clockify_projects_delete", arguments: { name: "Acme Corp" } }] },
    { text: "Done — the project is gone.", toolCalls: [] },
  ]);
  const store = createStore(":memory:", { encryptionKey: "test-key" });
  store.saveInstallation({
    workspaceId: "ws-1",
    addonId: "addon-1",
    addonUserId: "addon-user-1",
    addonToken: "addon-token",
  });
  const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Acme Corp" }] });
  const app = createApp({
    config: config(true),
    store,
    parser: createSignatureParser(ADDON_KEY, keys.pem),
    modelClient: model,
    clockifyForWorkspace: () => fake.client,
  });
  return { app, model, store };
}

describe("tool subsetting preserves unresolved clarification context", () => {
  it("persists the admin-authored context and reuses it on the next turn and resume", async () => {
    const b = buildClarificationResume();
    const cookie = cookieFor(b.store);
    const first = await request(b.app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "delete the project GhostProject" });
    expect(first.status).toBe(200);
    expect(first.body.results).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "clarify" })]));

    const session = b.store.listSessions("ws-1", "admin-1", new Date().toISOString())[0];
    const persisted = b.store.getRecentMessages(session.id, 2, true).find((message) => message.role === "assistant");
    expect(persisted?.payload).toMatchObject({
      kind: "clarify",
      clarificationContext: "delete the project GhostProject",
    });

    const followUp = await request(b.app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "use the invoice one" });
    expect(followUp.status).toBe(200);
    const preview = (followUp.body.results as PreviewItem[]).find((result) => result.kind === "preview");
    expect(preview).toBeDefined();

    const nextTurnTools = b.model.calls[1].tools.map((tool) => tool.name);
    expect(nextTurnTools).toContain("clockify_projects_delete");
    expect(nextTurnTools).toContain("clockify_invoices_create");
    expect(nextTurnTools.length).toBeLessThan(ACTION_CATALOG.length);

    const confirm = await request(b.app)
      .post(`/api/confirmations/${preview!.previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview!.nonce });
    expect(confirm.status).toBe(200);
    const resumeTools = b.model.calls[2].tools.map((tool) => tool.name);
    expect(resumeTools).toContain("clockify_projects_delete");
    expect(resumeTools).toContain("clockify_invoices_create");
    expect(resumeTools.length).toBeLessThan(ACTION_CATALOG.length);
    b.store.close();
  });
});
