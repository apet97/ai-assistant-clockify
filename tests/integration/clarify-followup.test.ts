import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { testKeys } from "../helpers/test-keys.js";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { makeTestConfig } from "../helpers/config.js";
import type { ToolCompletion } from "../../src/assistant/model-client.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import { scriptedToolModel, type ScriptedToolModel } from "../helpers/scripted-model.js";
import { mintAdminCookie } from "../helpers/session.js";

/**
 * finding new-7-clarify-dead-end-loop-contradict: when the harness clarifies an
 * unresolvable entity reference, the assistant's clarify QUESTION must survive
 * into the model-visible history. Today the clarify rides ONLY in results[] and
 * the stored assistant content is empty (blanked to avoid a UI double-render) —
 * so on the NEXT turn the model has no record of what it asked, can't connect a
 * one-word follow-up ("Acme Corp") to the pending disambiguation, and re-issues
 * the same losing tool call. The admin is stuck in an infinite clarify loop.
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

async function makeApp(script: ToolCompletion[], fake: FakeWorkspace): Promise<TestApp> {
  const keys = await testKeys();
  const config = makeTestConfig({
    clockifyAddonPublicKeyPem: keys.pem,
    clockifyAddonKey: ADDON_KEY,
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
    modelClient: model,
    clockifyForWorkspace: () => fake.client,
  });
  const cookie = mintAdminCookie(store, config.sessionSecret);
  return { app, model, cookie, store };
}

type ResultItem = { kind: string; message?: string };

describe("finding new-7: a clarify question survives into the next turn's model history", () => {
  it("feeds the clarify question back to the model so a follow-up can resolve it (no dead-end loop)", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Acme Corp" }] });
    const { app, model, cookie } = await makeApp(
      [
        // Turn 1: the model tries to delete a project that doesn't exist → harness clarify.
        { text: "", toolCalls: [{ id: "c1", name: "clockify_projects_delete", arguments: { name: "GhostProject" } }] },
        // Turn 2: the model gets the follow-up; with the clarify in history it can
        // re-target the real project. (We only assert what the model SAW in turn 2.)
        { text: "", toolCalls: [{ id: "c2", name: "clockify_projects_delete", arguments: { name: "Acme Corp" } }] },
      ],
      fake,
    );

    const first = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "delete the project GhostProject" });
    expect(first.status).toBe(200);
    const clarifies = (first.body.results as ResultItem[]).filter((r) => r.kind === "clarify");
    expect(clarifies).toHaveLength(1);
    const clarifyMessage = (clarifies[0].message ?? "").trim();
    expect(clarifyMessage.length).toBeGreaterThan(0);
    // reply.text must STILL be empty — the clarify rides in results[], no UI double-render.
    expect(String(first.body.reply?.text ?? "").trim()).toBe("");

    // Turn 2: the follow-up naming the real project.
    const second = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "Acme Corp" });
    expect(second.status).toBe(200);

    // What did the model SEE entering turn 2? The clarify question must be in the
    // model-visible history as an assistant turn — otherwise the model has no
    // record of having asked, and a one-word follow-up dead-ends in the same loop.
    const turn2Messages = model.calls[model.calls.length - 1].messages;
    const assistantTurns = turn2Messages.filter((msg) => msg.role === "assistant");
    expect(
      assistantTurns.some((msg) => (msg.content ?? "").includes(clarifyMessage)),
    ).toBe(true);
  });
});
