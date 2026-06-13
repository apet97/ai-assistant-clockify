import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { testing } from "@apet97/clockify-addon-sdk";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import type { AppConfig } from "../../src/config.js";
import type { ToolCompletion } from "../../src/assistant/model-client.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import { scriptedToolModel, type ScriptedToolModel } from "../helpers/scripted-model.js";

/**
 * r2-new-ops-layer-04: the per-session chat rate limit exists to damp the cost
 * of the PAID model loop. The confirm-time resume (POST /confirmations/:id/confirm
 * → runResume → runAgentTurn) is itself a paid loop — up to DEFAULT_MAX_STEPS
 * model round-trips — and a chained confirm→resume→preview→confirm sequence can
 * keep that loop running indefinitely. The resume must be charged against the
 * SAME per-session budget: the commit always lands (its receipt is flushed), but
 * when the budget is exhausted the paid follow-up loop is skipped, never run.
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
}

async function makeApp(
  script: ToolCompletion[],
  fake: FakeWorkspace,
  rateMax: number,
): Promise<TestApp> {
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
    chatRateLimitMax: rateMax,
    chatRateLimitWindowMs: 60_000,
  };
  const store = createStore(":memory:", { encryptionKey: "test-key" });
  stores.push(store);
  store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
  const model = scriptedToolModel(script);
  const app = createApp({
    config,
    store,
    parser: createSignatureParser(ADDON_KEY, keys.pem),
    modelClient: model,
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
  return { app, model, cookie };
}

type ResultItem = { kind: string; previewId?: string; nonce?: string };
function previewsOf(results: ResultItem[]): ResultItem[] {
  return results.filter((r) => r.kind === "preview");
}
function parseEvents(body: string): Array<Record<string, unknown>> {
  return body.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("confirm-resume is charged against the chat rate budget (r2-new-ops-layer-04)", () => {
  it("commits but SKIPS the paid resume loop when the session budget is exhausted (JSON path)", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, model, cookie } = await makeApp(
      [
        { text: "", toolCalls: [{ id: "r1", name: "clockify_tags_delete", arguments: { name: "urgent" } }] },
        // The resume would run THIS model call — it must NOT, because the single
        // budget slot was spent by the chat turn that produced the preview.
        { text: "The urgent tag is gone.", toolCalls: [] },
      ],
      fake,
      /* rateMax */ 1,
    );

    // The chat turn (preview) consumes the only budget slot.
    const chat = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the urgent tag" });
    expect(chat.status).toBe(200);
    const preview = previewsOf(chat.body.results as ResultItem[])[0];
    expect(preview).toBeDefined();
    const callsAfterChat = (model.completeWithTools as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterChat).toBe(1);

    const confirm = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });

    // The commit ALWAYS lands — the receipt is returned and the write happened.
    expect(confirm.status).toBe(200);
    expect(confirm.body.receipt.ok).toBe(true);
    expect(fake.counts.deleteTag).toBe(1);
    // …but the paid resume loop was skipped (budget exhausted): no new model call.
    expect((model.completeWithTools as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterChat);
    // No resumed reply rode along.
    expect(confirm.body.resume).toBeUndefined();
  });

  it("commits but SKIPS the paid resume loop when the session budget is exhausted (stream path)", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, model, cookie } = await makeApp(
      [
        { text: "", toolCalls: [{ id: "r1", name: "clockify_tags_delete", arguments: { name: "urgent" } }] },
        { text: "The urgent tag is gone.", toolCalls: [] },
      ],
      fake,
      /* rateMax */ 1,
    );

    const chat = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the urgent tag" });
    const preview = previewsOf(chat.body.results as ResultItem[])[0];
    const callsAfterChat = (model.completeWithTools as ReturnType<typeof vi.fn>).mock.calls.length;

    const res = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm?stream=1`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });

    expect(res.status).toBe(200);
    const events = parseEvents(res.text);
    // The committed receipt still flushes first, and the stream closes cleanly.
    expect(events[0].type).toBe("receipt");
    expect((events[0] as { receipt: { ok: boolean } }).receipt.ok).toBe(true);
    expect(events[events.length - 1].type).toBe("done");
    expect(fake.counts.deleteTag).toBe(1);
    // No resume model call was made (over budget).
    expect((model.completeWithTools as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterChat);
  });

  it("runs the resume normally when there IS budget left (the limiter only damps abuse)", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, model, cookie } = await makeApp(
      [
        { text: "", toolCalls: [{ id: "r1", name: "clockify_tags_delete", arguments: { name: "urgent" } }] },
        { text: "The urgent tag is gone.", toolCalls: [] },
      ],
      fake,
      // Plenty of budget: chat (1) + resume (1) both fit.
      /* rateMax */ 10,
    );

    const chat = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the urgent tag" });
    const preview = previewsOf(chat.body.results as ResultItem[])[0];
    const callsAfterChat = (model.completeWithTools as ReturnType<typeof vi.fn>).mock.calls.length;

    const confirm = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });

    expect(confirm.status).toBe(200);
    expect(confirm.body.receipt.ok).toBe(true);
    expect(fake.counts.deleteTag).toBe(1);
    // The resume DID run (one more model call) and the truthful summary came back.
    expect((model.completeWithTools as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterChat + 1);
    expect(confirm.body.resume.reply.text).toBe("The urgent tag is gone.");
  });
});
