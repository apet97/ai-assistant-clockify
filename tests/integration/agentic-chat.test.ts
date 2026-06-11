import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { testing } from "@apet97/clockify-addon-sdk";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import type { AppConfig } from "../../src/config.js";
import type { ModelClient, ToolCompletion } from "../../src/assistant/model-client.js";
import { DEFAULT_MAX_STEPS, EXHAUSTED_TEXT } from "../../src/assistant/agent-loop.js";
import { HISTORY_WINDOW_MESSAGES, previewReplyText, sanitizeStoredReplyForModel } from "../../src/routes/api.js";
import { verifySessionCookie } from "../../src/auth/sessions.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import { scriptedToolModel, type ScriptedToolModel } from "../helpers/scripted-model.js";

/**
 * Phase 2b: the agentic loop wired into the chat route behind LLM_AGENTIC.
 * Read-then-act chains through POST /api/chat/messages; a risky write interrupts
 * into the EXISTING preview→button-confirm flow; default OFF stays single-turn.
 */
const ADDON_KEY = "ai-assistant";

let stores: Store[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores = [];
});

interface TestApp {
  app: Express;
  model: ScriptedToolModel;
  cookie: string;
  store: Store;
}

async function makeApp(
  script: ToolCompletion[],
  fake: FakeWorkspace,
  opts: { agentic?: boolean; modelClient?: ModelClient } = {},
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
    llmAgentic: opts.agentic ?? true,
  };
  const store = createStore(":memory:", { encryptionKey: "test-key" });
  stores.push(store);
  store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
  const parser = createSignatureParser(ADDON_KEY, keys.pem);
  const model = scriptedToolModel(script);
  const app = createApp({
    config,
    store,
    parser,
    modelClient: opts.modelClient ?? model,
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
  return { app, model, cookie, store };
}

describe("agentic chat turn (LLM_AGENTIC=1)", () => {
  it("chains read-then-act through the chat route, feeding the read back to the model", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, model, cookie } = await makeApp(
      [
        { text: "", toolCalls: [{ id: "c1", name: "clockify_tags_list", arguments: {} }] },
        { text: "", toolCalls: [{ id: "c2", name: "clockify_tags_create", arguments: { name: "urgent-copy" } }] },
        { text: "Created urgent-copy.", toolCalls: [] },
      ],
      fake,
    );

    const res = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "copy the first tag" });

    expect(res.status).toBe(200);
    expect(res.body.reply.kind).toBe("answer");
    expect(res.body.reply.text).toBe("Created urgent-copy.");
    const kinds = (res.body.results as Array<{ kind: string }>).map((r) => r.kind);
    expect(kinds).toEqual(["receipt", "receipt"]);
    expect(fake.counts.createTag).toBe(1);
    // The model's second call saw the read's receipt as a tool message keyed to c1.
    expect(model.calls[1].messages.some((m) => m.role === "tool" && m.toolCallId === "c1")).toBe(true);
  });

  it("interrupts at a risky write: one preview, nothing executed, the button-confirm commits", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, model, cookie } = await makeApp(
      [{ text: "Deleting the tag now.", toolCalls: [{ id: "r1", name: "clockify_tags_delete", arguments: { name: "urgent" } }] }],
      fake,
    );

    const res = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the urgent tag" });

    expect(res.status).toBe(200);
    const previews = (res.body.results as Array<{ kind: string; previewId?: string; nonce?: string }>).filter(
      (r) => r.kind === "preview",
    );
    expect(previews).toHaveLength(1);
    expect(fake.counts.deleteTag ?? 0).toBe(0);
    // Truthful reply, never the model's "Deleting the tag now." narration.
    expect(res.body.reply.text).toContain("Nothing has been changed yet");
    // The loop must not have been re-planned past the interrupt.
    expect(model.completeWithTools).toHaveBeenCalledTimes(1);

    const confirm = await request(app)
      .post(`/api/confirmations/${previews[0].previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: previews[0].nonce });
    expect(confirm.status).toBe(200);
    expect(confirm.body.receipt.ok).toBe(true);
    expect(fake.counts.deleteTag).toBe(1);
    expect(fake.state.tags.find((t) => t.id === "t1")).toBeUndefined();
  });

  it("reads executed before the interrupt are kept as receipts alongside the preview", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, cookie } = await makeApp(
      [
        {
          text: "",
          toolCalls: [
            { id: "a1", name: "clockify_tags_list", arguments: {} },
            { id: "a2", name: "clockify_tags_delete", arguments: { name: "urgent" } },
          ],
        },
      ],
      fake,
    );

    const res = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "clean up tags" });

    expect(res.status).toBe(200);
    const kinds = (res.body.results as Array<{ kind: string }>).map((r) => r.kind);
    expect(kinds).toEqual(["receipt", "preview"]);
    expect(fake.counts.deleteTag ?? 0).toBe(0);
  });

  it("returns a clarify result when an action needs disambiguation", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, cookie } = await makeApp(
      [{ text: "", toolCalls: [{ id: "c1", name: "clockify_tags_delete", arguments: { name: "nope-no-such-tag" } }] }],
      fake,
    );

    const res = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the nope tag" });

    expect(res.status).toBe(200);
    expect(res.body.reply.kind).toBe("clarify");
    const clarifies = (res.body.results as Array<{ kind: string }>).filter((r) => r.kind === "clarify");
    expect(clarifies).toHaveLength(1);
    expect(fake.counts.deleteTag ?? 0).toBe(0);
  });

  it("surfaces a calm model_unavailable error when the model fails mid-loop", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const failing: ModelClient = {
      complete: vi.fn(async () => "{}"),
      completeWithTools: vi
        .fn()
        .mockResolvedValueOnce({ text: "", toolCalls: [{ id: "c1", name: "clockify_tags_list", arguments: {} }] })
        .mockRejectedValueOnce(new Error("model down")),
    };
    const { app, cookie } = await makeApp([], fake, { modelClient: failing });

    const res = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "hello" });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe("model_unavailable");
  });

  it("stays single-turn when LLM_AGENTIC is off (default behavior unchanged)", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, model, cookie } = await makeApp(
      [
        { text: "", toolCalls: [{ id: "c1", name: "clockify_tags_list", arguments: {} }] },
        { text: "", toolCalls: [{ id: "c2", name: "clockify_tags_create", arguments: { name: "urgent-copy" } }] },
      ],
      fake,
      { agentic: false },
    );

    const res = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "copy the first tag" });

    expect(res.status).toBe(200);
    // One model call, the read executed, and no second turn ever happens.
    expect(model.completeWithTools).toHaveBeenCalledTimes(1);
    expect(fake.counts.createTag ?? 0).toBe(0);
  });
});

type ResultItem = { kind: string; previewId?: string; nonce?: string; receipt?: { ok: boolean; action: string } };

function previewsOf(results: ResultItem[]): ResultItem[] {
  return results.filter((r) => r.kind === "preview");
}

function parseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("streaming confirm — receipt instant, resume streamed (no blocking the button)", () => {
  it("emits the committed receipt FIRST, then resume results, then the reply, then done", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "cl1", name: "qwen" }] });
    const { app, model, cookie } = await makeApp(
      [
        {
          text: "",
          toolCalls: [
            {
              id: "r1",
              name: "clockify_invoices_create",
              arguments: { clientName: "qwen", items: [{ description: "Consulting", quantity: 1, amount: 1000 }] },
            },
          ],
        },
        { text: "The invoice for qwen is created.", toolCalls: [] },
      ],
      fake,
    );

    const chat = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "create an invoice for qwen for 1000" });
    const preview = previewsOf(chat.body.results as ResultItem[])[0];
    const callsAfterChat = (model.completeWithTools as ReturnType<typeof vi.fn>).mock.calls.length;

    const res = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm?stream=1`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("x-ndjson");
    const events = parseEvents(res.text);
    // The committed receipt is the FIRST event (instant feedback) — before any
    // resume model call blocks.
    expect(events[0].type).toBe("receipt");
    expect((events[0] as { receipt: { ok: boolean; action: string } }).receipt).toMatchObject({ ok: true, action: "clockify_invoices_create" });
    // Then the resume runs and a truthful reply + done close the stream.
    const replyIdx = events.findIndex((e) => e.type === "reply");
    expect(replyIdx).toBeGreaterThan(0);
    expect((events[replyIdx] as { text: string }).text).toContain("qwen");
    expect(events[events.length - 1].type).toBe("done");
    // The invoice committed exactly once; the resume only re-planned (1 model call).
    expect(fake.counts.createInvoice).toBe(1);
    expect((model.completeWithTools as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterChat + 1);
  });

  it("streams a CHAINED preview from the resumed loop as a result event (next Confirm appears)", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }, { id: "t2", name: "stale" }] });
    const { app, cookie } = await makeApp(
      [
        { text: "", toolCalls: [{ id: "r1", name: "clockify_tags_delete", arguments: { name: "urgent" } }] },
        { text: "", toolCalls: [{ id: "r2", name: "clockify_tags_delete", arguments: { name: "stale" } }] },
        { text: "Both gone.", toolCalls: [] },
      ],
      fake,
    );
    const chat = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete urgent and stale" });
    const preview = previewsOf(chat.body.results as ResultItem[])[0];

    const res = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm?stream=1`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });

    const events = parseEvents(res.text);
    expect(events[0].type).toBe("receipt"); // first delete committed
    const chained = events.find((e) => e.type === "result" && (e.result as ResultItem).kind === "preview");
    expect(chained).toBeDefined();
    expect((chained!.result as ResultItem).previewId).toBeTruthy();
    expect(fake.counts.deleteTag).toBe(1); // only the confirmed one; the chained is still pending
  });

  it("a model EXCEPTION mid-resume never loses the committed receipt: the stream still opens with it and closes cleanly", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    let modelCalls = 0;
    const script = scriptedToolModel([
      { text: "", toolCalls: [{ id: "r1", name: "clockify_tags_delete", arguments: { name: "urgent" } }] },
    ]);
    const throwingOnResume: ModelClient = {
      complete: script.complete,
      completeWithTools: async (messages, tools) => {
        modelCalls += 1;
        if (modelCalls > 1) throw new Error("model unavailable"); // the resume call
        return script.completeWithTools!(messages, tools);
      },
    };
    const { app, cookie } = await makeApp([], fake, { modelClient: throwingOnResume });

    const chat = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the urgent tag" });
    const preview = previewsOf(chat.body.results as ResultItem[])[0];

    const res = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm?stream=1`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });

    expect(res.status).toBe(200);
    const events = parseEvents(res.text);
    // The committed receipt was flushed BEFORE the failing resume model call…
    expect(events[0].type).toBe("receipt");
    expect((events[0] as { receipt: { ok: boolean } }).receipt.ok).toBe(true);
    // …and the stream closes cleanly (a swallowed model failure loses only the
    // follow-up narration — never the commit).
    expect(events[events.length - 1].type).toBe("done");
    expect(fake.counts.deleteTag).toBe(1);
    expect(modelCalls).toBe(2);
  });

  it("legacy single-turn preview streams just the receipt + done (no resume model call)", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, model, cookie } = await makeApp(
      [{ text: "", toolCalls: [{ id: "r1", name: "clockify_tags_delete", arguments: { name: "urgent" } }] }],
      fake,
      { agentic: false },
    );
    const chat = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete urgent" });
    const preview = previewsOf(chat.body.results as ResultItem[])[0];

    const res = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm?stream=1`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });

    const events = parseEvents(res.text);
    expect(events[0].type).toBe("receipt");
    expect(events.some((e) => e.type === "reply")).toBe(false);
    expect(events[events.length - 1].type).toBe("done");
    expect(model.completeWithTools).toHaveBeenCalledTimes(1); // only the chat turn, no resume
    expect(fake.counts.deleteTag).toBe(1);
  });

  it("a policy lowered after the preview denies a streaming confirm cleanly as JSON (nonce not burned)", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, cookie, store } = await makeApp(
      [
        { text: "", toolCalls: [{ id: "r1", name: "clockify_tags_delete", arguments: { name: "urgent" } }] },
        { text: "Gone.", toolCalls: [] },
      ],
      fake,
    );
    const chat = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete urgent" });
    const preview = previewsOf(chat.body.results as ResultItem[])[0];
    const lowered = defaultAdminPolicy();
    lowered.groups.work_structure = "read";
    store.upsertAdminPolicy("ws-1", "admin-1", lowered);

    const denied = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm?stream=1`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });
    expect(denied.status).toBe(400);
    expect(denied.headers["content-type"]).toContain("application/json");
    expect(denied.body.code).toBe("policy_denied");
    expect(fake.counts.deleteTag ?? 0).toBe(0);

    // Same nonce works after restore (it was never burned).
    store.upsertAdminPolicy("ws-1", "admin-1", defaultAdminPolicy());
    const ok = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm?stream=1`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });
    expect(parseEvents(ok.text)[0].type).toBe("receipt");
    expect(fake.counts.deleteTag).toBe(1);
  });
});

describe("agentic loop bounds + streaming + mid-loop failures (Phase 4)", () => {
  it("streams each loop step as a result event, then the truthful reply, then done", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, cookie } = await makeApp(
      [
        { text: "", toolCalls: [{ id: "c1", name: "clockify_tags_list", arguments: {} }] },
        { text: "Deleting it.", toolCalls: [{ id: "r1", name: "clockify_tags_delete", arguments: { name: "urgent" } }] },
      ],
      fake,
    );

    const res = await request(app).post("/api/chat/stream").set("Cookie", cookie).send({ message: "clean up the urgent tag" });
    expect(res.status).toBe(200);
    const events = parseEvents(res.text);
    const kinds = events.map((e) => (e.type === "result" ? `result:${(e.result as ResultItem).kind}` : e.type));
    expect(kinds).toEqual(["result:receipt", "result:preview", "reply", "done"]);
    const reply = events.find((e) => e.type === "reply") as { text: string };
    expect(reply.text).toContain("Nothing has been changed yet");
    expect(fake.counts.deleteTag ?? 0).toBe(0);
  });

  it("answers truthfully when the step budget is exhausted", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, model, cookie } = await makeApp(
      [{ text: "", toolCalls: [{ id: "x", name: "clockify_tags_list", arguments: {} }] }],
      fake,
    );

    const res = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "loop forever" });

    expect(res.status).toBe(200);
    expect(res.body.reply.kind).toBe("answer");
    expect(res.body.reply.text).toBe(EXHAUSTED_TEXT);
    expect(model.completeWithTools).toHaveBeenCalledTimes(DEFAULT_MAX_STEPS);
    expect((res.body.results as ResultItem[]).every((r) => r.kind === "receipt")).toBe(true);
  });

  it("feeds a mid-loop action failure back to the model as an error receipt and continues", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, model, cookie } = await makeApp(
      [
        { text: "", toolCalls: [{ id: "c1", name: "clockify_does_not_exist", arguments: {} }] },
        { text: "That tool isn't available; nothing was changed.", toolCalls: [] },
      ],
      fake,
    );

    const res = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "do the impossible" });

    expect(res.status).toBe(200);
    const results = res.body.results as ResultItem[];
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe("receipt");
    expect(results[0].receipt?.ok).toBe(false);
    // The error receipt was fed back, and the model answered truthfully.
    const second = model.calls[1].messages;
    const toolMsg = second[second.length - 1];
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.content).toContain('"ok":false');
    expect(res.body.reply.text).toBe("That tool isn't available; nothing was changed.");
  });
});

describe("durable resume after the button-confirm (Phase 3)", () => {
  it("completes the headline flow: list clients → invoice preview → confirm → resumed truthful summary", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "cl1", name: "qwen" }] });
    const { app, model, cookie, store } = await makeApp(
      [
        { text: "", toolCalls: [{ id: "c1", name: "clockify_clients_list", arguments: {} }] },
        {
          text: "",
          toolCalls: [
            {
              id: "r1",
              name: "clockify_invoices_create",
              arguments: { clientName: "qwen", items: [{ description: "Consulting", quantity: 1, amount: 1000 }] },
            },
          ],
        },
        { text: "Created the invoice for qwen for $1,000.", toolCalls: [] },
      ],
      fake,
    );

    const chat = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "create an invoice for qwen for 1000" });
    expect(chat.status).toBe(200);
    const previews = previewsOf(chat.body.results as ResultItem[]);
    expect(previews).toHaveLength(1);
    expect(fake.counts.createInvoice ?? 0).toBe(0);

    const confirm = await request(app)
      .post(`/api/confirmations/${previews[0].previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: previews[0].nonce });

    expect(confirm.status).toBe(200);
    expect(confirm.body.receipt.ok).toBe(true);
    expect(fake.counts.createInvoice).toBe(1);
    // The loop resumed: the model saw the COMMITTED receipt as the risky call's tool result...
    const resumeCall = model.calls[2];
    const toolMsg = resumeCall.messages[resumeCall.messages.length - 1];
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.toolCallId).toBe("r1");
    expect(toolMsg.content).toContain('"ok":true');
    // ...and the truthful final summary came back and was persisted to history.
    expect(confirm.body.resume.reply.kind).toBe("answer");
    expect(confirm.body.resume.reply.text).toContain("qwen");
    const record = store.getPendingConfirmation(previews[0].previewId as string);
    const history = store.getRecentMessages(record!.sessionId, 10);
    expect(history.some((m) => m.role === "assistant" && m.content.includes("qwen"))).toBe(true);
  });

  it("chains a second interrupt: the resumed loop may return another preview, confirmable in turn", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }, { id: "t2", name: "stale" }] });
    const { app, cookie } = await makeApp(
      [
        { text: "", toolCalls: [{ id: "r1", name: "clockify_tags_delete", arguments: { name: "urgent" } }] },
        { text: "", toolCalls: [{ id: "r2", name: "clockify_tags_delete", arguments: { name: "stale" } }] },
        { text: "Both tags are deleted.", toolCalls: [] },
      ],
      fake,
    );

    const chat = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the urgent and stale tags" });
    const first = previewsOf(chat.body.results as ResultItem[]);
    expect(first).toHaveLength(1);

    const confirm1 = await request(app)
      .post(`/api/confirmations/${first[0].previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: first[0].nonce });
    expect(confirm1.status).toBe(200);
    // The resume hit the SECOND risky write → another preview, with a truthful reply.
    const second = previewsOf(confirm1.body.resume.results as ResultItem[]);
    expect(second).toHaveLength(1);
    expect(confirm1.body.resume.reply.text).toContain("Nothing has been changed yet");
    expect(fake.counts.deleteTag).toBe(1);

    const confirm2 = await request(app)
      .post(`/api/confirmations/${second[0].previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: second[0].nonce });
    expect(confirm2.status).toBe(200);
    expect(confirm2.body.resume.reply.text).toBe("Both tags are deleted.");
    expect(fake.counts.deleteTag).toBe(2);
    expect(fake.state.tags).toHaveLength(0);
  });

  it("re-checks policy at confirm time: a lowered policy denies cleanly WITHOUT burning the nonce or resuming", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, model, cookie, store } = await makeApp(
      [
        { text: "", toolCalls: [{ id: "r1", name: "clockify_tags_delete", arguments: { name: "urgent" } }] },
        { text: "The urgent tag is gone.", toolCalls: [] },
      ],
      fake,
    );

    const chat = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the urgent tag" });
    const previews = previewsOf(chat.body.results as ResultItem[]);
    const callsAfterChat = (model.completeWithTools as ReturnType<typeof vi.fn>).mock.calls.length;

    const lowered = defaultAdminPolicy();
    lowered.groups.work_structure = "read";
    store.upsertAdminPolicy("ws-1", "admin-1", lowered);

    const denied = await request(app)
      .post(`/api/confirmations/${previews[0].previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: previews[0].nonce });
    expect(denied.status).toBe(400);
    expect(denied.body.code).toBe("policy_denied");
    expect(fake.counts.deleteTag ?? 0).toBe(0);
    // No resume happened on the denial.
    expect((model.completeWithTools as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterChat);

    // Restore the policy: the SAME nonce still works (it was never burned) and the loop resumes.
    store.upsertAdminPolicy("ws-1", "admin-1", defaultAdminPolicy());
    const confirm = await request(app)
      .post(`/api/confirmations/${previews[0].previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: previews[0].nonce });
    expect(confirm.status).toBe(200);
    expect(confirm.body.resume.reply.text).toBe("The urgent tag is gone.");
    expect(fake.counts.deleteTag).toBe(1);
  });

  it("rejects a replayed confirm after a resumed commit (one-use nonce holds; no second resume)", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, model, cookie } = await makeApp(
      [
        { text: "", toolCalls: [{ id: "r1", name: "clockify_tags_delete", arguments: { name: "urgent" } }] },
        { text: "Done.", toolCalls: [] },
      ],
      fake,
    );

    const chat = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the urgent tag" });
    const previews = previewsOf(chat.body.results as ResultItem[]);

    const confirm = await request(app)
      .post(`/api/confirmations/${previews[0].previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: previews[0].nonce });
    expect(confirm.status).toBe(200);
    const callsAfterResume = (model.completeWithTools as ReturnType<typeof vi.fn>).mock.calls.length;

    const replay = await request(app)
      .post(`/api/confirmations/${previews[0].previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: previews[0].nonce });
    expect(replay.status).toBe(400);
    expect(fake.counts.deleteTag).toBe(1);
    expect((model.completeWithTools as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterResume);
  });

  it("confirms a legacy single-turn preview exactly as today (no resume key)", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, model, cookie } = await makeApp(
      [{ text: "", toolCalls: [{ id: "r1", name: "clockify_tags_delete", arguments: { name: "urgent" } }] }],
      fake,
      { agentic: false },
    );

    const chat = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the urgent tag" });
    const previews = previewsOf(chat.body.results as ResultItem[]);
    expect(previews).toHaveLength(1);

    const confirm = await request(app)
      .post(`/api/confirmations/${previews[0].previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: previews[0].nonce });
    expect(confirm.status).toBe(200);
    expect(confirm.body.receipt.ok).toBe(true);
    expect(confirm.body.resume).toBeUndefined();
    expect(model.completeWithTools).toHaveBeenCalledTimes(1);
    expect(fake.counts.deleteTag).toBe(1);
  });

  it("never persists a secret in the suspended transcript (agent_state_json tripwire)", async () => {
    // The transcript is stored PLAINTEXT — safe only because it's provably
    // secret-free (system prompt = policy only; receipts carry no token). This
    // tripwire fails loudly if a future change ever leaks the install token or
    // session secret into the persisted state.
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, cookie, store } = await makeApp(
      [{ text: "", toolCalls: [{ id: "r1", name: "clockify_tags_delete", arguments: { name: "urgent" } }] }],
      fake,
    );

    const chat = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the urgent tag" });
    const previews = previewsOf(chat.body.results as ResultItem[]);
    const record = store.getPendingConfirmation(previews[0].previewId as string);
    const serialized = JSON.stringify(record?.agentState ?? null);

    expect(record?.agentState).toBeDefined(); // the turn really suspended
    expect(serialized).not.toContain("addon-token"); // the install token
    expect(serialized).not.toContain("test-session-secret"); // the session secret
    expect(serialized).not.toContain("llm-key"); // the model API key
  });

  it("keeps the committed receipt when the model fails during resume (commit is never lost)", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const failing: ModelClient = {
      complete: vi.fn(async () => "{}"),
      completeWithTools: vi
        .fn()
        .mockResolvedValueOnce({ text: "", toolCalls: [{ id: "r1", name: "clockify_tags_delete", arguments: { name: "urgent" } }] })
        .mockRejectedValue(new Error("model down")),
    };
    const { app, cookie } = await makeApp([], fake, { modelClient: failing });

    const chat = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the urgent tag" });
    const previews = previewsOf(chat.body.results as ResultItem[]);

    const confirm = await request(app)
      .post(`/api/confirmations/${previews[0].previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: previews[0].nonce });

    expect(confirm.status).toBe(200);
    expect(confirm.body.receipt.ok).toBe(true);
    expect(confirm.body.resume).toBeUndefined();
    expect(fake.counts.deleteTag).toBe(1);
  });
});

describe("typed consent guard (live item 157: typing 'yes' at a pending preview planned a NEW operation)", () => {
  it("a bare 'yes' while a preview is pending is answered deterministically — the model never sees it, nothing new is planned", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, model, cookie } = await makeApp(
      [{ text: "Deleting the tag now.", toolCalls: [{ id: "r1", name: "clockify_tags_delete", arguments: { name: "urgent" } }] }],
      fake,
    );
    const first = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete tag urgent" });
    expect(first.status).toBe(200);
    expect(previewsOf(first.body.results as ResultItem[])).toHaveLength(1);
    const callsAfterPreview = model.calls.length;

    const yes = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "yes" });
    expect(yes.status).toBe(200);
    expect(model.calls.length).toBe(callsAfterPreview); // the model never saw "yes"
    expect(yes.body.results).toEqual([]); // no new previews, no receipts
    expect(String(yes.body.reply?.text ?? "")).toMatch(/confirm button/i);
    expect(fake.counts.deleteTag ?? 0).toBe(0); // and nothing executed
  });

  it("a bare 'yes' with NOTHING pending still reaches the model (the guard is scoped to pending previews)", async () => {
    const fake = createFakeWorkspace();
    const { app, model, cookie } = await makeApp([{ text: "Could you say more?", toolCalls: [] }], fake);
    const res = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "yes" });
    expect(res.status).toBe(200);
    expect(model.calls.length).toBe(1);
  });
});

describe("model-visible history window (live-loop FIX 3: the session must stay responsive at item 300)", () => {
  it("sends only the window to the model even when the session has hundreds of stored messages", async () => {
    const fake = createFakeWorkspace();
    const { app, model, cookie, store } = await makeApp([{ text: "Hi!", toolCalls: [] }], fake);

    // Recover the route's sessionId from the signed cookie and stuff the session
    // with 300 stored messages (the loop reached 650 live).
    const claims = verifySessionCookie(decodeURIComponent(cookie.split("=").slice(1).join("=")), "test-session-secret");
    if (!claims) throw new Error("could not decode the test session cookie");
    for (let i = 0; i < 300; i += 1) {
      store.addMessage({
        sessionId: claims.sessionId,
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        role: i % 2 === 0 ? "user" : "assistant",
        content: `filler message ${i}`,
      });
    }

    const res = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "list tags" });
    expect(res.status).toBe(200);

    const seen = model.calls[0].messages;
    // system prompt + at most HISTORY_WINDOW_MESSAGES of history (the new user
    // message is inside the window).
    expect(seen.length).toBeLessThanOrEqual(1 + HISTORY_WINDOW_MESSAGES);
    expect(seen[0].role).toBe("system");
    // The window holds the MOST RECENT history; ancient filler is gone.
    expect(seen.some((m) => m.content === "filler message 299")).toBe(true);
    expect(seen.some((m) => m.content === "filler message 0")).toBe(false);
    expect(seen[seen.length - 1].content).toBe("list tags");

    // The STORED history stays complete — only the model-visible window shrinks.
    expect(store.getRecentMessages(claims.sessionId, 1000).length).toBeGreaterThanOrEqual(301);
  });

  it("replaces stored truthful-preview boilerplate in PRIOR assistant turns so the model can't learn to parrot it (live item 318)", async () => {
    const fake = createFakeWorkspace();
    const { app, model, cookie, store } = await makeApp([{ text: "Hi!", toolCalls: [] }], fake);
    const claims = verifySessionCookie(decodeURIComponent(cookie.split("=").slice(1).join("=")), "test-session-secret");
    if (!claims) throw new Error("could not decode the test session cookie");

    // Saturate the visible window with the EXACT deterministic reply this route
    // stores for pending previews — the live failure shape: the model
    // reproduced it as its own answer with zero tool calls.
    for (let i = 0; i < HISTORY_WINDOW_MESSAGES; i += 2) {
      store.addMessage({
        sessionId: claims.sessionId,
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        role: "user",
        content: `delete tag t${i}`,
      });
      store.addMessage({
        sessionId: claims.sessionId,
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        role: "assistant",
        content: 'Review the change below and click "Confirm" to apply it. Nothing has been changed yet.',
      });
    }

    const res = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "delete every AIASSIST client" });
    expect(res.status).toBe(200);

    const seen = model.calls[0].messages;
    const assistantTurns = seen.filter((m) => m.role === "assistant");
    expect(assistantTurns.length).toBeGreaterThan(0);
    for (const turn of assistantTurns) {
      expect(turn.content).not.toContain('click "Confirm"');
      expect(turn.content).not.toContain("Review the change below");
    }
    // The factual content survives — a pending change existed at that point.
    expect(assistantTurns.some((m) => (m.content ?? "").includes("button confirmation"))).toBe(true);

    // Only the MODEL-VISIBLE copy is sanitized; the stored history is untouched.
    expect(
      store.getRecentMessages(claims.sessionId, 1000).some((m) => m.content.includes('click "Confirm"')),
    ).toBe(true);
  });

  // safety-invariants-02: the REAL produce-then-sanitize round trip. The route's
  // stored truthful-preview reply and the sanitizer regex must derive from ONE
  // constant — so any future reword of the boilerplate stays sanitized. This test
  // never hardcodes the boilerplate string: it derives the expected stored reply
  // from the SAME exported builder the route uses, so it passes for ANY wording.
  it("sanitizes a REAL stored preview reply in the next turn's model window (single source of truth)", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, model, cookie, store } = await makeApp(
      [
        // Turn 1: a risky delete → one preview, route stores the truthful reply.
        { text: "Deleting the tag now.", toolCalls: [{ id: "r1", name: "clockify_tags_delete", arguments: { name: "urgent" } }] },
        // Turn 2: any plain answer (no tool call) — we only inspect what it SAW.
        { text: "Sure.", toolCalls: [] },
      ],
      fake,
    );
    const claims = verifySessionCookie(decodeURIComponent(cookie.split("=").slice(1).join("=")), "test-session-secret");
    if (!claims) throw new Error("could not decode the test session cookie");

    // Turn 1: produce a genuine preview via the route.
    const t1 = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the urgent tag" });
    expect(t1.status).toBe(200);
    expect((t1.body.results as Array<{ kind: string }>).filter((r) => r.kind === "preview")).toHaveLength(1);

    // The STORED assistant reply is exactly what the route's builder generates for
    // ONE pending preview — derived, never re-typed. Drift the builder and this
    // assertion follows it; drift only the sanitizer and the next-turn check breaks.
    const storedTurn1 = store
      .getRecentMessages(claims.sessionId, 1000)
      .filter((msg) => msg.role === "assistant")
      .at(-1);
    expect(storedTurn1?.content).toBe(previewReplyText(1));
    // The route's own boilerplate must round-trip through the sanitizer to the note.
    expect(sanitizeStoredReplyForModel(previewReplyText(1))).toContain("button confirmation");

    // Turn 2: whatever the route now feeds the model must NOT contain the stored
    // boilerplate verbatim, and must carry the neutral note instead.
    const t2 = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "anything else" });
    expect(t2.status).toBe(200);
    const seen = model.calls[model.calls.length - 1].messages;
    const assistantTurns = seen.filter((msg) => msg.role === "assistant");
    expect(assistantTurns.length).toBeGreaterThan(0);
    expect(assistantTurns.some((msg) => (msg.content ?? "") === previewReplyText(1))).toBe(false);
    for (const turn of assistantTurns) {
      expect(turn.content).not.toContain('click "Confirm"');
      expect(turn.content).not.toContain("Review the change below");
    }
    expect(assistantTurns.some((msg) => (msg.content ?? "").includes("button confirmation"))).toBe(true);
  });
});
