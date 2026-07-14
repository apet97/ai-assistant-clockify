import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { testing } from "@apet97/clockify-addon-sdk";
import { testKeys } from "../helpers/test-keys.js";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { makeTestConfig } from "../helpers/config.js";
import type { ModelClient, ToolCompletion } from "../../src/assistant/model-client.js";
import { DEFAULT_MAX_STEPS, EXHAUSTED_TEXT } from "../../src/assistant/agent-loop.js";
import { HISTORY_WINDOW_MESSAGES } from "../../src/routes/chat-constants.js";
import { previewReplyText, sanitizeStoredReplyForModel } from "../../src/routes/history-sanitizer.js";
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

// Test keys come from the suite-wide keypair (tests/global-setup.ts) via testKeys().

async function makeApp(
  script: ToolCompletion[],
  fake: FakeWorkspace,
  opts: { agentic?: boolean; modelClient?: ModelClient } = {},
): Promise<TestApp> {
  const keys = await testKeys();
  const config = makeTestConfig({
    clockifyAddonPublicKeyPem: keys.pem,
    clockifyAddonKey: ADDON_KEY,
    llmAgentic: opts.agentic ?? true,
    // Preserve this file's original posture: the pre-migration inline literal left
    // llmToolSelect undefined (OFF). The factory default is ON; override back to
    // OFF so these turn-counting assertions stay behavior-identical (#37 migration
    // must not change behavior).
    llmToolSelect: false,
  });
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
  it("replays a duplicate requestId without rerunning the model or host write and rejects conflicting reuse", async () => {
    const fake = createFakeWorkspace();
    const { app, model, cookie } = await makeApp(
      [{ text: "", toolCalls: [{ id: "c1", name: "clockify_tags_create", arguments: { name: "once" } }] }],
      fake,
      { agentic: false },
    );
    const requestId = "e3956aa4-e39e-42f3-9778-7c40eb715321";
    const first = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "create tag once", requestId });
    const replay = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "create tag once", requestId });
    const conflict = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "create a different tag", requestId });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(model.completeWithTools).toHaveBeenCalledTimes(1);
    expect(fake.counts.createTag).toBe(1);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("operation_id_conflict");
  });

  it("serializes two-tab retries so an in-flight duplicate waits and replays", async () => {
    const fake = createFakeWorkspace();
    let release!: () => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const delayedModel: ModelClient = {
      async complete() { return "{}"; },
      completeWithTools: vi.fn(async () => {
        signalStarted();
        await blocked;
        return { text: "", toolCalls: [{ id: "c1", name: "clockify_tags_create", arguments: { name: "once" } }] };
      }),
    };
    const { app, cookie } = await makeApp([], fake, { agentic: false, modelClient: delayedModel });
    const requestId = "d3a40aeb-4a76-4f3a-85e1-a9686a8e1ab1";

    const first = request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "create tag once", requestId })
      .then((response) => response);
    await started;
    const second = request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "create tag once", requestId })
      .then((response) => response);
    const beforeRelease = await Promise.race([
      second.then(() => "responded" as const),
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 50)),
    ]);
    release();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    expect(beforeRelease).toBe("waiting");
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(secondResponse.body).toEqual(firstResponse.body);
    expect(delayedModel.completeWithTools).toHaveBeenCalledTimes(1);
    expect(fake.counts.createTag).toBe(1);
  });

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

  // safety-invariants-05: the raw one-use confirmation nonce must live ONLY in
  // the live HTTP response/page state, per confirmations.ts ("only its hash is
  // stored"). It must NEVER be durably persisted in chat_messages.payload_json.
  it("never persists the raw confirmation nonce in the stored chat message (only the live response carries it)", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, cookie, store } = await makeApp(
      [{ text: "Deleting the tag now.", toolCalls: [{ id: "r1", name: "clockify_tags_delete", arguments: { name: "urgent" } }] }],
      fake,
    );

    const res = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the urgent tag" });
    expect(res.status).toBe(200);
    const preview = previewsOf(res.body.results as ResultItem[])[0];
    // The live response DOES carry the nonce (the page needs it to confirm).
    expect(preview.nonce).toBeTruthy();

    const claims = verifySessionCookie(decodeURIComponent(cookie.split("=").slice(1).join("=")), "test-session-secret");
    if (!claims) throw new Error("could not decode the test session cookie");
    const stored = store
      .getRecentMessages(claims.sessionId, 1000, true)
      .filter((m) => m.role === "assistant")
      .at(-1);
    expect(stored).toBeDefined();
    // The persisted payload keeps the preview metadata but NOT the raw nonce.
    expect(JSON.stringify(stored?.payload ?? null)).not.toContain(preview.nonce as string);
    const storedPreview = (stored?.payload as { results?: ResultItem[] })?.results?.find((r) => r.kind === "preview");
    expect(storedPreview?.previewId).toBe(preview.previewId);
    expect((storedPreview as { nonce?: string } | undefined)?.nonce).toBeUndefined();
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

  // fix-clarify-double-render: a clarify message must be delivered EXACTLY ONCE
  // across results[] + reply.text. The UI appends both a clarify result bubble
  // (renderClarify) AND reply.text (onAssistant), so emitting the same message in
  // both renders it twice. The clarify (with its grounded options) rides in
  // results[]; reply.text must NOT echo it.
  it("delivers the clarify message exactly once (agentic path) — not in BOTH results[] and reply.text", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, cookie } = await makeApp(
      [{ text: "", toolCalls: [{ id: "c1", name: "clockify_tags_delete", arguments: { name: "nope-no-such-tag" } }] }],
      fake,
    );

    const res = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the nope tag" });

    expect(res.status).toBe(200);
    const clarifies = (res.body.results as Array<{ kind: string; message?: string }>).filter((r) => r.kind === "clarify");
    expect(clarifies).toHaveLength(1);
    const clarifyMessage = (clarifies[0].message ?? "").trim();
    expect(clarifyMessage.length).toBeGreaterThan(0);
    const replyText = String(res.body.reply?.text ?? "").trim();
    // The same message must NOT also ride in reply.text (that is the double render).
    expect(replyText).not.toBe(clarifyMessage);
    // Count occurrences across both delivery channels: exactly one.
    const channels = [replyText, ...clarifies.map((c) => (c.message ?? "").trim())];
    expect(channels.filter((t) => t === clarifyMessage)).toHaveLength(1);
  });

  it("delivers the clarify message exactly once (single-turn path) — not in BOTH results[] and reply.text", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, cookie } = await makeApp(
      // The single-turn planner narrates BEFORE the action runs; if its narration
      // echoes the clarify the UI renders it twice. Force that worst case.
      [{ text: "There are multiple tags matching — which did you mean?", toolCalls: [{ id: "c1", name: "clockify_tags_delete", arguments: { name: "nope-no-such-tag" } }] }],
      fake,
      { agentic: false },
    );

    const res = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the nope tag" });

    expect(res.status).toBe(200);
    const clarifies = (res.body.results as Array<{ kind: string; message?: string }>).filter((r) => r.kind === "clarify");
    expect(clarifies).toHaveLength(1);
    const clarifyMessage = (clarifies[0].message ?? "").trim();
    const replyText = String(res.body.reply?.text ?? "").trim();
    // When a turn ends in a clarify, reply.text must not echo the clarify message.
    expect(replyText).not.toBe(clarifyMessage);
    expect(fake.counts.deleteTag ?? 0).toBe(0);
  });

  it("stops a legacy single-turn plan after the first clarification", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, cookie } = await makeApp(
      [{
        text: "",
        toolCalls: [
          { id: "c1", name: "clockify_tags_delete", arguments: { name: "missing-tag" } },
          { id: "c2", name: "clockify_tags_create", arguments: { name: "must-not-run" } },
        ],
      }],
      fake,
      { agentic: false },
    );

    const res = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete one tag and create another" });

    expect(res.status).toBe(200);
    expect((res.body.results as Array<{ kind: string }>).some((r) => r.kind === "clarify")).toBe(true);
    expect(fake.counts.createTag ?? 0).toBe(0);
  });

  it("stops a legacy single-turn plan after the first preview", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, cookie } = await makeApp(
      [{
        text: "",
        toolCalls: [
          { id: "c1", name: "clockify_tags_delete", arguments: { name: "urgent" } },
          { id: "c2", name: "clockify_tags_create", arguments: { name: "must-not-run" } },
        ],
      }],
      fake,
      { agentic: false },
    );

    const res = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete one tag and create another" });

    expect(res.status).toBe(200);
    expect(previewsOf(res.body.results as ResultItem[])).toHaveLength(1);
    expect(fake.counts.createTag ?? 0).toBe(0);
  });

  // fix-clarify-double-render (single-turn worst case): the model's pre-action
  // narration can be BYTE-IDENTICAL to the clarify the harness produces. When the
  // single-turn action resolves to a clarify result, reply.text must NOT carry that
  // narration — the clarify rides ONLY in results[], so the UI bubble appears once.
  it("blanks reply.text when a single-turn action yields a clarify, even if narration equals the clarify verbatim", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, cookie } = await makeApp(
      // The harness clarify for an unknown tag is "I couldn't find a tag named
      // …. Did you mean one of these?"; force the model's narration to MATCH it.
      [
        {
          text: 'I couldn\'t find a tag named "nope-no-such-tag". Did you mean one of these?',
          toolCalls: [{ id: "c1", name: "clockify_tags_delete", arguments: { name: "nope-no-such-tag" } }],
        },
      ],
      fake,
      { agentic: false },
    );

    const res = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the nope tag" });

    expect(res.status).toBe(200);
    const clarifies = (res.body.results as Array<{ kind: string; message?: string }>).filter((r) => r.kind === "clarify");
    expect(clarifies).toHaveLength(1);
    const clarifyMessage = (clarifies[0].message ?? "").trim();
    expect(clarifyMessage.length).toBeGreaterThan(0);
    const replyText = String(res.body.reply?.text ?? "").trim();
    // The clarify rides ONLY in results[]; reply.text must be empty (the UI appends
    // an assistant bubble only for non-empty reply.text → exactly one clarify bubble).
    expect(replyText).toBe("");
    const channels = [replyText, ...clarifies.map((c) => (c.message ?? "").trim())];
    expect(channels.filter((t) => t === clarifyMessage)).toHaveLength(1);
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
    // Each tool execution announces itself with an ephemeral status line first.
    expect(kinds).toEqual(["status", "result:receipt", "status", "result:preview", "reply", "done"]);
    const reply = events.find((e) => e.type === "reply") as { text: string };
    expect(reply.text).toContain("Nothing has been changed yet");
    expect(fake.counts.deleteTag ?? 0).toBe(0);
  });

  // finding new-4-failed-tool-call-receipt-silently-hidden: when the agentic loop
  // attempts a tool call that FAILS (invalid_args) and then recovers with a
  // successful preview in the SAME turn, the truthful-preview override replaced
  // reply.text wholesale with the "Review the change… Confirm" boilerplate —
  // erasing every trace of the failed attempt. The admin then saw a Confirm card
  // for a pivoted action with no explanation. The failed receipts must be
  // acknowledged in reply.text alongside the truthful-preview instruction.
  it("acknowledges a failed tool call in reply.text when the loop recovers to a preview in the same turn", async () => {
    const fake = createFakeWorkspace({
      clients: [{ id: "client-1", name: "Acme Corp" }],
      invoices: [
        {
          id: "inv-1",
          number: "INV-001",
          clientId: "client-1",
          status: "DRAFT",
          currency: "USD",
          items: [{ order: 0, description: "Discount", quantity: 1, unitPrice: 0, itemType: "Discount" }],
        } as never,
      ],
    });
    const { app, cookie } = await makeApp(
      [
        // The model first tries a NEGATIVE unit price (a -10% discount) — Zod's
        // nonnegative() rejects it as invalid_args.
        {
          text: "",
          toolCalls: [
            { id: "f1", name: "clockify_invoices_items_add", arguments: { invoiceId: "inv-1", itemType: "Discount", description: "10% Discount", unitPrice: -7.5 } },
          ],
        },
        // It pivots to a positive workaround line item, which previews fine.
        {
          text: "Adding a discount line item instead.",
          toolCalls: [
            { id: "r1", name: "clockify_invoices_items_add", arguments: { invoiceId: "inv-1", itemType: "Discount", description: "10% Discount", unitPrice: 7.5 } },
          ],
        },
      ],
      fake,
    );

    const res = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "apply a 10% discount to invoice INV-001" });

    expect(res.status).toBe(200);
    const results = res.body.results as ResultItem[];
    const failed = results.filter((r) => r.kind === "receipt" && r.receipt?.ok === false);
    const previews = previewsOf(results);
    // The turn really did fail-then-recover: at least one failed receipt AND a preview.
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(previews).toHaveLength(1);

    const replyText = String(res.body.reply?.text ?? "");
    // The truthful-preview instruction is still present (nothing applied yet).
    expect(replyText).toContain("Nothing has been changed yet");
    // …but it must NOT silently hide the failed attempt: the reply must
    // acknowledge that an earlier attempt failed (a count or a "couldn't"/"failed"
    // note), so the admin understands why a different card appeared.
    expect(replyText).toMatch(/fail|couldn't|could not|didn't work/i);
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

  // plan-009 client-disconnect cancellation: when the admin closes the iframe (or a
  // proxy times out) mid-turn, the streaming route must stop the agentic loop — no
  // further model calls or writes for a turn nobody is watching.
  //
  // DETERMINISM (deliberately NOT a wall-clock `setTimeout(req.abort)` race): the
  // scripted model + fake client + sync SQLite all resolve on MICROTASKS, so once
  // the handler starts the loop runs to its 6-step budget in one uninterrupted
  // microtask burst — a timer-scheduled abort always loses that race (it fires after
  // res.end()). Instead the disconnect is driven FROM INSIDE the first model call:
  // we abort the request, then park that call on a real timer long enough for the
  // server's `res.on("close")` → `ac.abort()` to fire (loopback close-propagation is
  // sub-ms; 100ms is a vast margin). The loop is provably parked at that model await
  // when the signal flips, so it hits the abort guard before the NEXT boundary. The
  // unit test (tests/unit/agent-loop-abort.test.ts) covers the loop logic directly;
  // THIS test only proves the route wires the signal end-to-end.
  it("aborts the agentic loop when the client disconnects mid-stream (no runaway model calls)", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const reqHolder: { abort: () => void } = { abort: () => undefined };
    let calls = 0;
    const disconnectingModel: ModelClient = {
      complete: vi.fn(async () => "{}"),
      completeWithTools: vi.fn(async (): Promise<ToolCompletion> => {
        calls += 1;
        if (calls === 1) {
          reqHolder.abort(); // the iframe/proxy drops the connection mid-turn
          await new Promise((r) => setTimeout(r, 100)); // let the server abort the signal first
        }
        // Always propose another read, so ONLY the disconnect can stop the loop.
        return { text: "", toolCalls: [{ id: `c${calls}`, name: "clockify_tags_list", arguments: {} }] };
      }),
    };
    const { app, cookie } = await makeApp([], fake, { modelClient: disconnectingModel });

    const req = request(app).post("/api/chat/stream").set("Cookie", cookie).send({ message: "list tags repeatedly" });
    reqHolder.abort = () => req.abort();
    await req.catch(() => undefined); // the aborted request rejects; ignore it
    await new Promise((r) => setTimeout(r, 20)); // let the loop settle past the abort guard

    // The loop stopped at the boundary right after the disconnect: exactly the one
    // model call that triggered it (far below the 6-step budget), and the read it
    // proposed never executed (the guard sits BEFORE runAction).
    expect((disconnectingModel.completeWithTools as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(fake.counts.listTags ?? 0).toBe(0);
  });

  // plan-009 (sibling of the chat-stream abort test above): the CONFIRM-resume
  // stream route (/api/confirmations/:id/confirm?stream=1) wires the SAME signal
  // through runResume → runAgentTurn. CLAUDE.md pins BOTH streaming routes; only
  // the chat route had an end-to-end disconnect test (audit finding #6). Same
  // deterministic technique: drive the disconnect from inside the FIRST RESUME
  // model call (call #2 overall — call #1 is the chat turn that builds the
  // preview), park ~100ms so res.on("close") → ac.abort() fires, and keep
  // proposing a read so ONLY the disconnect can stop the resumed loop.
  it("aborts the RESUME loop when the client disconnects mid-confirm-stream (commit lands; no runaway resume)", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const reqHolder: { abort: () => void } = { abort: () => undefined };
    let calls = 0;
    const disconnectingModel: ModelClient = {
      complete: vi.fn(async () => "{}"),
      completeWithTools: vi.fn(async (): Promise<ToolCompletion> => {
        calls += 1;
        if (calls === 1) {
          // Chat turn: propose the risky delete → the loop interrupts into a preview.
          return { text: "", toolCalls: [{ id: "r1", name: "clockify_tags_delete", arguments: { name: "urgent" } }] };
        }
        if (calls === 2) {
          reqHolder.abort(); // the admin closes the iframe mid-resume
          await new Promise((r) => setTimeout(r, 100)); // let the server abort the signal first
        }
        // The resume keeps proposing a read, so ONLY the disconnect can stop the
        // loop. Use a CLIENTS read — the delete-tag flow lists tags to resolve
        // "urgent", so listClients is a clean "did the resume read run?" signal.
        return { text: "", toolCalls: [{ id: `c${calls}`, name: "clockify_clients_list", arguments: {} }] };
      }),
    };
    const { app, cookie } = await makeApp([], fake, { modelClient: disconnectingModel });

    const chat = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the urgent tag" });
    const preview = previewsOf(chat.body.results as ResultItem[])[0];

    const req = request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm?stream=1`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });
    reqHolder.abort = () => req.abort();
    await req.catch(() => undefined); // the aborted request rejects; ignore it
    await new Promise((r) => setTimeout(r, 20)); // let the loop settle past the abort guard

    // The confirmed delete committed (its receipt is streamed BEFORE the resume model call blocks)…
    expect(fake.counts.deleteTag).toBe(1);
    // …then the resume made exactly ONE model call (the one that triggered the disconnect),
    // and the read it then proposed never executed — the abort guard sits before runAction.
    expect((disconnectingModel.completeWithTools as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    expect(fake.counts.listClients ?? 0).toBe(0);
  });
});

// F10-truthfulness-assistant-falsely-claims-a-t: live tour turn 30 — the model
// answered "Done! The tag … has been renamed …" for a RENAME (a high_risk_write)
// while making ZERO tool calls. No preview, no receipt, no DB write — the rename
// never happened (the next-turn delete couldn't find the renamed tag), yet the
// admin was told it succeeded. A risky write can only ever be applied through the
// preview→button-confirm flow; a plain-answer turn that ran no actions can NEVER
// have mutated anything, so the route must not relay a fabricated success claim.
describe("post-turn truthfulness guard (F10: a plain answer with no tool calls must not claim a completed write)", () => {
  it("does not relay 'Done! … has been renamed' when the model ran no tool calls", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "AIASSIST_SMOKE_tour" }] });
    const { app, model, cookie } = await makeApp(
      // The exact live failure shape: free text claiming the rename succeeded, but
      // ZERO tool calls — so nothing previewed, nothing committed.
      [{ text: "Done! The tag **AIASSIST_SMOKE_tour** has been renamed to **AIASSIST_SMOKE_tour_renamed**.", toolCalls: [] }],
      fake,
    );

    const res = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "Rename the tag AIASSIST_SMOKE_tour to AIASSIST_SMOKE_tour_renamed." });

    expect(res.status).toBe(200);
    // The turn truly ran no actions: no receipts, no previews, nothing changed.
    expect(res.body.results).toEqual([]);
    expect(fake.counts.updateTag ?? 0).toBe(0);
    expect(fake.state.tags.find((t) => t.id === "t1")?.name).toBe("AIASSIST_SMOKE_tour"); // un-renamed
    // The user-visible reply must NOT carry the fabricated success claim.
    const replyText = String(res.body.reply?.text ?? "");
    expect(replyText).not.toMatch(/renamed/i);
    expect(replyText).not.toMatch(/\bDone\b/i);
    expect(model.completeWithTools).toHaveBeenCalledTimes(1);
  });

  it("does not relay a fabricated 'I deleted'/'created'/'updated' claim with no tool calls", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, cookie } = await makeApp(
      [{ text: "I've deleted the urgent tag and created a new one called done.", toolCalls: [] }],
      fake,
    );

    const res = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "delete urgent and create done" });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
    expect(fake.counts.deleteTag ?? 0).toBe(0);
    expect(fake.counts.createTag ?? 0).toBe(0);
    const replyText = String(res.body.reply?.text ?? "");
    expect(replyText).not.toMatch(/deleted|created/i);
  });

  it("does not relay a fabricated 'Done! I deleted X' after a READ-only agentic turn (results non-empty, but nothing mutated)", async () => {
    // The original F10 guard was gated on results.length === 0. But a read pushes a
    // {kind:"receipt"} result (carrying `data`, not `changed`), so the common
    // read-then-fabricate agentic shape left `results` non-empty and slipped the
    // fabricated completion claim straight past the guard — telling the admin a
    // write happened that never did. A read must NOT suppress the truthfulness
    // guard; only a real mutation receipt (a `changed` set) may back a "Done!".
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, cookie } = await makeApp(
      [
        { text: "", toolCalls: [{ id: "c1", name: "clockify_tags_list", arguments: {} }] },
        { text: "Done! I deleted the urgent tag.", toolCalls: [] },
      ],
      fake,
    );

    const res = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "delete the urgent tag" });

    expect(res.status).toBe(200);
    // A read DID run (its receipt is in results), but NOTHING mutated.
    expect((res.body.results as ResultItem[]).some((r) => r.kind === "receipt")).toBe(true);
    expect(fake.counts.deleteTag ?? 0).toBe(0);
    expect(fake.state.tags.find((t) => t.id === "t1")?.name).toBe("urgent"); // still there
    // The fabricated "Done! I deleted" must NOT reach the admin.
    const replyText = String(res.body.reply?.text ?? "");
    expect(replyText).not.toMatch(/deleted/i);
    expect(replyText).not.toMatch(/\bDone\b/i);
  });

  it("leaves an ordinary conversational answer with no actions untouched (no false positive)", async () => {
    const fake = createFakeWorkspace();
    const { app, cookie } = await makeApp(
      [{ text: "I can rename tags for you — which tag would you like to rename, and to what?", toolCalls: [] }],
      fake,
    );

    const res = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "can you rename tags?" });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
    // A future/conditional offer (no completed-mutation framing) passes through verbatim.
    expect(res.body.reply.text).toBe("I can rename tags for you — which tag would you like to rename, and to what?");
  });

  it("leaves a real 'Done — the tag was created.' reply that DID run a successful write untouched", async () => {
    const fake = createFakeWorkspace();
    const { app, cookie } = await makeApp(
      [
        { text: "", toolCalls: [{ id: "c1", name: "clockify_tags_create", arguments: { name: "new-tag" } }] },
        { text: "Done — the tag was created.", toolCalls: [] },
      ],
      fake,
    );

    const res = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "create a tag called new-tag" });

    expect(res.status).toBe(200);
    // A genuine safe write produced a success receipt; the claim is BACKED by a result.
    expect((res.body.results as ResultItem[]).filter((r) => r.kind === "receipt" && r.receipt?.ok)).toHaveLength(1);
    expect(fake.counts.createTag).toBe(1);
    expect(res.body.reply.text).toBe("Done — the tag was created.");
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

  // F10 false-positive on resume (live): after a confirmed write, the resume's
  // truthful completion narration ("Done! …", "I've created …", "has been …") was
  // wrongly REPLACED with the NO_CHANGE_MADE_REPLY ("nothing ran") because the
  // just-committed receipt isn't in the resume turn's own results, so the guard saw
  // "no mutation this turn" and fired. The committed write IS the mutation; the
  // resume must relay the truthful completion. (The headline test above dodged this
  // only because "Created the invoice …" doesn't match the completion-claim regex;
  // real models say "Done!"/"I've …", which do.)
  it("a post-confirm resume that narrates completion ('Done! …') is relayed, NOT replaced with 'nothing ran'", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, cookie } = await makeApp(
      [
        { text: "", toolCalls: [{ id: "r1", name: "clockify_tags_delete", arguments: { name: "urgent" } }] },
        // The resume narrates completion with wording that DOES match the F10 regex.
        { text: "Done! I've deleted the urgent tag.", toolCalls: [] },
      ],
      fake,
    );
    const chat = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the urgent tag" });
    const preview = previewsOf(chat.body.results as ResultItem[])[0];

    const confirm = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });
    expect(confirm.status).toBe(200);
    expect(confirm.body.receipt.ok).toBe(true);
    expect(fake.counts.deleteTag).toBe(1); // the mutation really happened
    // The resumed reply is the model's truthful completion — never "nothing ran".
    expect(confirm.body.resume.reply.text).toBe("Done! I've deleted the urgent tag.");
    expect(String(confirm.body.resume.reply.text)).not.toMatch(/nothing ran/i);
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

  // finding new-5-typed-consent-guard-has-a-narrow: consent-adjacent phrases
  // ("just do it already", "execute it now", "apply the change", "run it",
  // "please go ahead and apply the pending change") bypassed the narrow regex,
  // reached the planner, re-ran the SAME risky action and created a SECOND
  // pending preview. They express approval while a preview is pending and must
  // be intercepted deterministically — the model never sees them, nothing new
  // is planned, the single pending preview is untouched.
  it.each([
    "just do it already",
    "execute it now",
    "apply the change",
    "run it",
    "please go ahead and apply the pending change",
    // r1-safety-invariants-01 / live-dogfood-02: common approval idioms also
    // express consent and must NOT reach the planner (they re-ran the risky write
    // and stacked a SECOND duplicate preview).
    "approve",
    "approve the change",
    "go for it",
    "make it so",
    "ship it",
    "do the thing",
    // live-dogfood-03: "Confirm all" is a literal UI button label; typed in chat
    // (with "everything"/"them"/"those" siblings) it is pure batch-consent and
    // must redirect to the button, not re-plan a SECOND preview. The filler set
    // lacked "all"/"everything"; the pending-object set lacked "them"/"those".
    "confirm all",
    "confirm everything",
    "confirm them",
    "confirm those",
    "approve all",
    // broaden affirmative matching: affirmation + a bare trailing apply-verb
    // (no pending-object) is still pure consent — must hit the guard, not the planner.
    "yes please confirm",
    "yes confirm",
    "yes go ahead and confirm",
    "ok confirm",
    "sure do it",
  ])("a consent-adjacent '%s' while a preview is pending is answered deterministically (no second preview)", async (phrase) => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    // If the guard misses, the message reaches the planner; script a second
    // delete so a leaked planner turn would produce a SECOND preview.
    const { app, model, cookie } = await makeApp(
      [
        { text: "Deleting the tag now.", toolCalls: [{ id: "r1", name: "clockify_tags_delete", arguments: { name: "urgent" } }] },
        { text: "Deleting the tag now.", toolCalls: [{ id: "r2", name: "clockify_tags_delete", arguments: { name: "urgent" } }] },
      ],
      fake,
    );
    const first = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete tag urgent" });
    expect(first.status).toBe(200);
    expect(previewsOf(first.body.results as ResultItem[])).toHaveLength(1);
    const callsAfterPreview = model.calls.length;

    const consent = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: phrase });
    expect(consent.status).toBe(200);
    expect(model.calls.length).toBe(callsAfterPreview); // the model never saw the consent phrase
    expect(consent.body.results).toEqual([]); // no SECOND preview, no receipts
    expect(String(consent.body.reply?.text ?? "")).toMatch(/confirm button/i);
    expect(fake.counts.deleteTag ?? 0).toBe(0); // and nothing executed
  });

  // BOUNDARY: an affirmation that ALSO carries a NEW instruction must NOT be
  // swallowed — it has to reach the planner so the new work runs.
  it.each([
    "yes, also create a project named X",
    "yes and create a project named X",
    "yes but change the rate to 50",
    "approve the discount on invoice 5",
    "run the report",
    "apply the discount to invoice 5",
  ])("a follow-on instruction '%s' (even affirmation-prefixed) still reaches the planner", async (phrase) => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, model, cookie } = await makeApp(
      [
        { text: "Deleting the tag now.", toolCalls: [{ id: "r1", name: "clockify_tags_delete", arguments: { name: "urgent" } }] },
        { text: "On it.", toolCalls: [] },
      ],
      fake,
    );
    const first = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete tag urgent" });
    expect(first.status).toBe(200);
    expect(previewsOf(first.body.results as ResultItem[])).toHaveLength(1);
    const callsAfterPreview = model.calls.length;
    const follow = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: phrase });
    expect(follow.status, JSON.stringify(follow.body)).toBe(200);
    expect(model.calls.length).toBe(callsAfterPreview + 1); // guard did NOT intercept
  });

  it("a bare 'yes' with NOTHING pending still reaches the model (the guard is scoped to pending previews)", async () => {
    const fake = createFakeWorkspace();
    const { app, model, cookie } = await makeApp([{ text: "Could you say more?", toolCalls: [] }], fake);
    const res = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "yes" });
    expect(res.status).toBe(200);
    expect(model.calls.length).toBe(1);
  });

  // finding new-2-affirmative-after-completed-safe: a safe write executes
  // immediately and leaves NO pending confirmation, so the TYPED_CONSENT pending
  // guard (which keys on countPendingConfirmations) does not fire. A bare
  // affirmative on the next turn ("yes please go ahead") must NOT re-plan another
  // write — the prior turn already finished. The deterministic reply says it is
  // already done; the model never sees the affirmative, so it cannot duplicate.
  it("a bare affirmative right after a completed safe write does not log a duplicate entry", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Acme" } as never] });
    const { app, model, cookie } = await makeApp(
      [
        // Turn 1: log 2 hours on Acme — a safe write that completes immediately.
        { text: "", toolCalls: [{ id: "c1", name: "clockify_log_work", arguments: { description: "Work on Acme", projectName: "Acme", durationHours: 2, date: "today" } }] },
        { text: "Done! Logged 2 hours on Acme for today.", toolCalls: [] },
        // Turn 2 — if the affirmative ever reaches the model, it duplicates the log.
        { text: "", toolCalls: [{ id: "c2", name: "clockify_log_work", arguments: { description: "Work on Acme", projectName: "Acme", durationHours: 2, date: "today" } }] },
        { text: "All set!", toolCalls: [] },
      ],
      fake,
    );

    const first = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "log 2 hours on Acme today" });
    expect(first.status).toBe(200);
    expect((first.body.results as ResultItem[]).filter((r) => r.kind === "receipt")).toHaveLength(1);
    expect(fake.counts.createTimeEntry).toBe(1);
    const callsAfterFirst = model.calls.length;

    const yes = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "yes please go ahead" });
    expect(yes.status).toBe(200);
    // The model never saw the affirmative, so it could not plan a duplicate.
    expect(model.calls.length).toBe(callsAfterFirst);
    // And nothing new was logged — still exactly one entry.
    expect(fake.counts.createTimeEntry).toBe(1);
    expect(yes.body.results).toEqual([]);
    expect(yes.body.reply.kind).toBe("answer");
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
