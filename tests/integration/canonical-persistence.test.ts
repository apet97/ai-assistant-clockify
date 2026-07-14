import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { testing } from "@apet97/clockify-addon-sdk";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { createApp } from "../../src/server.js";
import { makeTestConfig } from "../helpers/config.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import { scriptedToolModel } from "../helpers/scripted-model.js";
import { testKeys } from "../helpers/test-keys.js";
import type { ToolCompletion } from "../../src/assistant/model-client.js";

const ADDON_KEY = "ai-assistant";
const REQUEST_ID = "99fe86fb-a0a4-4ddd-8b84-b8001cce27a7";
const tempDirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function startTurn(input: {
  script: ToolCompletion[];
  fake: FakeWorkspace;
  message: string;
  requestId: string;
  agentic?: boolean;
}) {
  const dir = mkdtempSync(join(tmpdir(), "aiassist-canonical-"));
  tempDirs.push(dir);
  const databasePath = join(dir, "test.db");
  const store = createStore(databasePath, { encryptionKey: "test-key" });
  stores.push(store);
  store.saveInstallation({
    workspaceId: "ws-1",
    addonId: "addon-1",
    addonUserId: "addon-user-1",
    addonToken: "addon-token",
  });

  const keys = await testKeys();
  const app = createApp({
    config: makeTestConfig({
      clockifyAddonPublicKeyPem: keys.pem,
      clockifyAddonKey: ADDON_KEY,
      llmAgentic: input.agentic ?? true,
      llmToolSelect: false,
    }),
    store,
    parser: createSignatureParser(ADDON_KEY, keys.pem),
    modelClient: scriptedToolModel(input.script),
    clockifyForWorkspace: () => input.fake.client,
  });
  const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
    workspaceId: "ws-1",
    user: "admin-1",
    workspaceRole: "ADMIN",
    addonId: "addon-1",
  });
  const component = await request(app).get("/component/assistant").query({ auth_token: token });
  const setCookie = component.headers["set-cookie"];
  const cookie = Array.isArray(setCookie) ? setCookie[0].split(";")[0] : "";
  const turn = await request(app)
    .post("/api/chat/messages")
    .set("Cookie", cookie)
    .send({ message: input.message, requestId: input.requestId });
  return { app, cookie, databasePath, turn };
}

async function riskyTurn() {
  const started = await startTurn({
    script: [{
      text: "Deleting now.",
      toolCalls: [
        { id: "delete-1", name: "clockify_tags_delete", arguments: { name: "urgent" } },
      ],
    }],
    fake: createFakeWorkspace({ tags: [{ id: "tag-1", name: "urgent" }] }),
    message: "delete the urgent tag",
    requestId: REQUEST_ID,
  });
  const { turn } = started;
  const preview = (turn.body.results as Array<{ kind: string; previewId?: string; nonce?: string }>).find(
    (result) => result.kind === "preview",
  );
  if (!preview?.previewId || !preview.nonce) throw new Error("expected a live preview nonce");
  return { ...started, preview };
}

describe("canonical persistence safety", () => {
  it("creates one canonical safe-write result and reuses it for journal, audit, history, and replay", async () => {
    const requestId = "83cae8b6-7a5b-42ad-a3f7-1d892679b55e";
    const { app, cookie, databasePath, turn } = await startTurn({
      script: [{
        text: "Created.",
        toolCalls: [{ id: "create-1", name: "clockify_tags_create", arguments: { name: "canonical" } }],
      }],
      fake: createFakeWorkspace(),
      message: "create a canonical tag",
      requestId,
      agentic: false,
    });
    expect(turn.status).toBe(200);

    const raw = new Database(databasePath, { readonly: true });
    const actionResults = raw.prepare("SELECT id FROM action_results").all() as Array<{ id: string }>;
    expect(actionResults).toHaveLength(1);
    const id = actionResults[0]!.id;
    expect((raw.prepare("SELECT action_result_id FROM operation_runs").get() as { action_result_id: string }).action_result_id).toBe(id);
    expect((raw.prepare("SELECT action_result_id FROM audit_events").get() as { action_result_id: string }).action_result_id).toBe(id);
    expect((raw.prepare("SELECT action_result_id FROM chat_message_result_links").get() as { action_result_id: string }).action_result_id).toBe(id);
    expect((raw.prepare("SELECT action_result_id FROM turn_run_result_links").get() as { action_result_id: string }).action_result_id).toBe(id);
    expect(raw.prepare(
      "SELECT plan_step_id, kind, status, external_id FROM operation_steps ORDER BY step_index",
    ).all()).toEqual([
      {
        plan_step_id: "create-tag",
        kind: "primary",
        status: "succeeded",
        external_id: expect.any(String),
      },
    ]);
    raw.close();

    const replay = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "create a canonical tag", requestId });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(turn.body);
    const afterReplay = new Database(databasePath, { readonly: true });
    expect((afterReplay.prepare("SELECT COUNT(*) AS count FROM action_results").get() as { count: number }).count).toBe(1);
    afterReplay.close();
  });

  it.each([
    { label: "read", args: {}, expectedKind: "succeeded" },
    { label: "definitive failure", args: { unexpected: true }, expectedKind: "definitive_failed" },
  ])("creates one canonical $label result", async ({ label, args, expectedKind }) => {
    const requestId = label === "read"
      ? "aaaf0db3-b9e6-4430-a271-cc6ce9bbc255"
      : "bf893d74-f064-4cc8-9a82-b99ffc4b5ea5";
    const { databasePath, turn } = await startTurn({
      script: [{
        text: "Checking.",
        toolCalls: [{ id: "status-1", name: "clockify_status", arguments: args }],
      }],
      fake: createFakeWorkspace(),
      message: `canonical ${label}`,
      requestId,
      agentic: false,
    });
    expect(turn.status).toBe(200);

    const raw = new Database(databasePath, { readonly: true });
    const results = raw.prepare("SELECT id, kind FROM action_results").all() as Array<{ id: string; kind: string }>;
    expect(results).toEqual([{ id: expect.any(String), kind: expectedKind }]);
    expect((raw.prepare("SELECT COUNT(*) AS count FROM operation_runs").get() as { count: number }).count).toBe(0);
    const id = results[0]!.id;
    expect((raw.prepare("SELECT action_result_id FROM audit_events").get() as { action_result_id: string }).action_result_id).toBe(id);
    expect((raw.prepare("SELECT action_result_id FROM turn_run_result_links").get() as { action_result_id: string }).action_result_id).toBe(id);
    raw.close();
  });

  it("never writes a live preview nonce into the durable turn replay envelope", async () => {
    const { databasePath, preview } = await riskyTurn();
    const raw = new Database(databasePath, { readonly: true });
    const row = raw
      .prepare("SELECT response_envelope_json FROM turn_runs WHERE request_id = ?")
      .get(REQUEST_ID) as { response_envelope_json: string };
    raw.close();

    expect(row.response_envelope_json).not.toContain(preview.nonce);
  });

  it("atomically scrubs a cancelled confirmation's nonce hash, agent state, and operation payload", async () => {
    const { app, cookie, databasePath, preview } = await riskyTurn();
    const cancelled = await request(app)
      .post(`/api/confirmations/${preview.previewId}/cancel`)
      .set("Cookie", cookie)
      .send({});
    expect(cancelled.status).toBe(200);

    const raw = new Database(databasePath, { readonly: true });
    const row = raw
      .prepare(
        `SELECT status, nonce_hash, agent_state_json, operation_json
           FROM pending_confirmations WHERE id = ?`,
      )
      .get(preview.previewId) as {
      status: string;
      nonce_hash: string;
      agent_state_json: string | null;
      operation_json: string | null;
    };
    raw.close();

    expect(row).toEqual({
      status: "cancelled",
      nonce_hash: "",
      agent_state_json: null,
      operation_json: null,
    });
  });

  it("hydrates a duplicate request from canonical links and rotates a fresh nonce only for its live preview", async () => {
    const { app, cookie, databasePath, preview } = await riskyTurn();
    const replay = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "delete the urgent tag", requestId: REQUEST_ID });
    expect(replay.status).toBe(200);
    const replayed = (replay.body.results as Array<{ kind: string; previewId?: string; nonce?: string }>).find(
      (result) => result.kind === "preview",
    );
    expect(replayed).toMatchObject({ previewId: preview.previewId, nonce: expect.any(String) });
    expect(replayed?.nonce).not.toBe(preview.nonce);

    const stale = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });
    expect(stale.status).toBe(400);
    expect(stale.body.code).toBe("invalid_confirmation");

    const fresh = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: replayed?.nonce });
    expect(fresh.status).toBe(200);

    const raw = new Database(databasePath, { readonly: true });
    const confirmation = raw.prepare(
      `SELECT status, nonce_hash, operation_json, agent_state_json, action_result_id
         FROM pending_confirmations WHERE id = ?`,
    ).get(preview.previewId) as Record<string, unknown>;
    expect(confirmation).toMatchObject({
      status: "succeeded",
      nonce_hash: "",
      operation_json: null,
      agent_state_json: null,
      action_result_id: expect.any(String),
    });
    const actionResultId = confirmation.action_result_id as string;
    expect((raw.prepare("SELECT COUNT(*) AS count FROM action_results").get() as { count: number }).count).toBe(1);
    expect((raw.prepare("SELECT action_result_id FROM audit_events").get() as { action_result_id: string }).action_result_id).toBe(actionResultId);
    expect((raw.prepare("SELECT action_result_id FROM operation_runs").get() as { action_result_id: string }).action_result_id).toBe(actionResultId);
    raw.close();
  });
});
