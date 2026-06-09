import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { testing } from "@apet97/clockify-addon-sdk";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import type { AppConfig } from "../../src/config.js";
import type { ModelClient, ToolCompletion } from "../../src/assistant/model-client.js";
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
  return { app, model, cookie };
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
