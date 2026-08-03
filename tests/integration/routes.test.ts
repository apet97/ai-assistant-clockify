import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { testing } from "@apet97/clockify-addon-sdk";
import { testKeys } from "../helpers/test-keys.js";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { makeTestConfig } from "../helpers/config.js";
import type { ModelClient } from "../../src/assistant/model-client.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import type { Express } from "express";
import { mintAdminCookie, requireSessionCookie, requireSessionSetCookie } from "../helpers/session.js";
import { createChatPipeline, type ChatPipeline } from "../../src/routes/chat-pipeline.js";
import type { AppDeps } from "../../src/routes/deps.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ADDON_KEY = "ai-assistant";

// The reported /version product version must come from the ONE source of
// truth (package.json), not a literal duplicated in src/server.ts. Reading
// it here independently means this test fails the moment the two drift.
const packageJsonVersion = (
  JSON.parse(
    readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
  ) as { version: string }
).version;

let keys: { privateKey: unknown; pem: string };
let store: Store;
let app: Express;
let fake: FakeWorkspace;

function authoredSpan(source: string, literal: string) {
  const index = source.indexOf(literal);
  if (index < 0) throw new Error(`missing declaration literal: ${literal}`);
  const startByte = Buffer.byteLength(source.slice(0, index), "utf8");
  return { startByte, endByte: startByte + Buffer.byteLength(literal, "utf8"), text: literal };
}

// Smart fake model: returns a delete action for "delete" messages, else an answer.
const modelClient: ModelClient = {
  async complete(messages) {
    if (messages[0]?.role === "system" && messages[0].content.includes("constrained intent declaration pass")) {
      const requestPayload = JSON.parse(messages[1]?.content ?? "{}") as { segments?: Array<{ text?: string }> };
      const source = (requestPayload.segments ?? []).map((segment) => segment.text ?? "").join("\n");
      if (source.toLowerCase().includes("delete")) {
        const action = authoredSpan(source, "delete");
        const entityType = authoredSpan(source, "project");
        const name = authoredSpan(source, "Acme");
        const id = authoredSpan(source, "p1");
        return JSON.stringify({
          writeActions: [{
            actionName: "clockify_delete_entity",
            sourceSpans: [action, entityType, name, id],
            literalConstraints: [
              { path: "entityType", value: "project", sourceSpan: entityType },
              { path: "name", value: "Acme", sourceSpan: name },
              { path: "id", value: "p1", sourceSpan: id },
            ],
            maxExecutions: 1,
          }],
        });
      }
      if (source.toLowerCase().includes("create tag")) {
        const action = authoredSpan(source, "create tag");
        const name = authoredSpan(source, "Billing");
        return JSON.stringify({
          writeActions: [{
            actionName: "clockify_tags_create",
            sourceSpans: [action, name],
            literalConstraints: [{ path: "name", value: "Billing", sourceSpan: name }],
            maxExecutions: 1,
          }],
        });
      }
      return JSON.stringify({ writeActions: [] });
    }
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const text = lastUser?.content ?? "";
    if (text.toLowerCase().includes("what failed")) {
      return JSON.stringify({
        kind: "actions",
        text: "Here is what actually happened.",
        actions: [{ name: "assistant_recent_outcomes", arguments: {} }],
      });
    }
    if (text.toLowerCase().includes("delete")) {
      return JSON.stringify({
        // The model optimistically (and falsely) claims it already executed — the
        // route must NOT surface this for a pending preview.
        kind: "actions",
        text: "Done! I've deleted the project and confirmed it.",
        actions: [
          { name: "clockify_delete_entity", arguments: { entityType: "project", id: "p1", name: "Acme" } },
        ],
      });
    }
    if (text.toLowerCase().includes("create tag")) {
      return JSON.stringify({
        // truthfulness-02: the model narrates success BEFORE execution, but the
        // proposed safe write has invalid args (no name) so it FAILS. The route
        // must not surface this pre-execution success claim.
        kind: "actions",
        text: 'Done! I created the tag "Billing" for you.',
        actions: [{ name: "clockify_tags_create", arguments: {} }],
      });
    }
    return JSON.stringify({ kind: "answer", text: "Hello, admin." });
  },
};

function adminCookie(): string {
  return mintAdminCookie(store, "test-session-secret");
}

function isolatedRouteApp(
  assistantEngine: "v1" | "v2",
  isolatedModelClient: ModelClient,
  pipelineFactories?: {
    v1: (deps: AppDeps) => ChatPipeline;
    v2: (deps: AppDeps) => ChatPipeline;
  },
  existingStore?: Store,
): { app: Express; store: Store; fake: FakeWorkspace } {
  const isolatedStore = existingStore ?? createStore(":memory:", { encryptionKey: "test-key" });
  if (!existingStore) {
    isolatedStore.saveInstallation({
      workspaceId: "ws-1",
      addonId: "addon-1",
      addonUserId: "addon-user-1",
      addonToken: "addon-token",
    });
  }
  const isolatedFake = createFakeWorkspace({ projects: [{ id: "p1", name: "Acme" }] });
  const deps: AppDeps = {
    config: makeTestConfig({
      assistantEngine,
      clockifyAddonPublicKeyPem: keys.pem,
      clockifyAddonKey: ADDON_KEY,
    }),
    store: isolatedStore,
    parser: createSignatureParser(ADDON_KEY, keys.pem),
    modelClient: isolatedModelClient,
    clockifyForWorkspace: () => isolatedFake.client,
  };
  return {
    app: createApp(deps, pipelineFactories),
    store: isolatedStore,
    fake: isolatedFake,
  };
}

beforeAll(async () => {
  keys = await testKeys();
  const config = makeTestConfig({
    clockifyAddonPublicKeyPem: keys.pem,
    clockifyAddonKey: ADDON_KEY,
    publicContactUrl: "mailto:support@example.com",
    // Deliberately different from the verified artifact proof below: /version
    // must never echo these environment-shaped config values.
    releaseSha: "d".repeat(40),
    releaseBuildHash: "e".repeat(64),
  });
  store = createStore(":memory:", { encryptionKey: "test-key" });
  store.saveInstallation({
    workspaceId: "ws-1",
    addonId: "addon-1",
    addonUserId: "addon-user-1",
    addonToken: "addon-token",
  });
  const parser = createSignatureParser(ADDON_KEY, keys.pem);
  // The fake model's delete plan targets project p1/Acme — it must exist now
  // that the generic delete resolves identity at preview time.
  fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Acme" }] });
  app = createApp({
    config,
    store,
    parser,
    modelClient,
    clockifyForWorkspace: () => fake.client,
    releaseArtifactIdentity: {
      releaseSha: "a".repeat(40),
      releaseBuildHash: "b".repeat(64),
      serverArtifactSha256: "c".repeat(64),
      sourceBindingSha256: null,
      sourceRelationship: "exact_head",
    },
  });
});

afterAll(() => store.close());

// Each test starts from a fresh workspace. The generic delete now truly removes
// the row (fake-fidelity), so a confirmed "delete project Acme" in one test must
// not leave Acme missing for the next that needs it.
beforeEach(() => {
  fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Acme" }] });
});

describe("routes", () => {
  it("GET /manifest returns the manifest", async () => {
    const res = await request(app).get("/manifest");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("AI Assistant for Clockify");
    expect(res.body.components?.[0].label).toBe("AI Assistant");
    expect(res.body.components?.[0].path).toBe("/component/assistant");
    expect(res.body.components?.[0].type).toBe("sidebar");
    expect(res.body.iconPath).toBe("/icon.svg");
  });

  it("GET /version binds the deployed process to immutable release metadata", async () => {
    const res = await request(app).get("/version");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.body).toEqual({
      version: packageJsonVersion,
      releaseSha: "a".repeat(40),
      buildHash: "b".repeat(64),
      serverArtifactSha256: "c".repeat(64),
      sourceRelationship: "exact_head",
      sourceBindingSha256: null,
      modelConfiguration: {
        provider: "http",
        model: "cheap-model",
        endpointSha256: null,
        mode: "tool",
        agentic: true,
        toolSelect: true,
        assistantEngine: "v1",
        reasoningEffort: null,
        thinkingMode: null,
      },
    });
  });

  it("GET /version reports the injected product version, not a literal", async () => {
    // Proves the reported version is NOT a hardcoded string in server.ts: an
    // app built with a distinct injected productVersion must echo it. If the
    // route special-cased a literal (e.g. "2.0.0"), this would fail even
    // though the injected value differs from package.json's current version.
    const overrideApp = createApp({
      config: makeTestConfig({
        clockifyAddonPublicKeyPem: keys.pem,
        clockifyAddonKey: ADDON_KEY,
      }),
      store,
      parser: createSignatureParser(ADDON_KEY, keys.pem),
      modelClient,
      clockifyForWorkspace: () => fake.client,
      productVersion: "9.9.9-test-override",
    });
    const res = await request(overrideApp).get("/version");
    expect(res.status).toBe(200);
    expect(res.body.version).toBe("9.9.9-test-override");
  });

  it("GET /icon.svg serves the sidebar icon", async () => {
    const res = await request(app).get("/icon.svg");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/svg+xml");
    // supertest buffers non-text bodies into res.body (a Buffer), not res.text.
    const body = res.text || (Buffer.isBuffer(res.body) ? res.body.toString("utf8") : "");
    expect(body).toContain("<svg");
  });

  it("component route rejects a non-admin role", async () => {
    const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: "ws-1",
      user: "member-1",
      workspaceRole: "USER",
    });
    const res = await request(app).get("/component/assistant").query({ auth_token: token });
    expect(res.status).toBe(403);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("component route accepts an admin and sets a session cookie", async () => {
    const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: "ws-1",
      user: "admin-1",
      workspaceRole: "ADMIN",
    });
    const res = await request(app).get("/component/assistant").query({ auth_token: token });
    expect(res.status).toBe(200);
    const setCookie = requireSessionSetCookie(res.headers);
    expect(setCookie).toContain("ai_assistant_session=");
    expect(setCookie).toContain("HttpOnly");
    // Cross-site iframe: cookie must be SameSite=None over HTTPS or the chat 401s.
    expect(setCookie).toContain("SameSite=None");
  });

  it("ignores Clockify language while preserving verified theme/timezone preferences and public links", async () => {
    const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: "ws-1",
      user: "admin-1",
      workspaceRole: "ADMIN",
      language: "SR",
      theme: "DARK",
    });
    const component = await request(app).get("/component/assistant").query({ auth_token: token });
    expect(component.status).toBe(200);
    const cookie = requireSessionCookie(component.headers);
    const me = await request(app).get("/api/me").set("Cookie", cookie);

    expect(me.status).toBe(200);
    expect(me.body.preferences).toEqual({ theme: "dark", timeZone: "UTC" });
    expect(me.body.links).toEqual({
      privacy: "https://example.com/privacy",
      support: "https://example.com/support",
      security: "https://example.com/security",
    });
  });

  /**
   * `parseCookies` called bare `decodeURIComponent(value)`, which THROWS on a
   * malformed escape. Any request carrying an unrelated cookie with a bad
   * escape — set by any other app on the domain — became an uncaught parser
   * exception and a generic 500, before any auth decision was made.
   *
   * A cookie header is attacker/third-party influenced input. It must fail
   * closed to the ordinary unauthenticated path, and one bad pair must not
   * discard the pairs around it.
   */
  it("survives a malformed escape in an UNRELATED cookie", async () => {
    const response = await request(app).get("/api/me").set("Cookie", "other=%zz");
    expect(response.status).not.toBe(500);
    expect(response.status).toBe(401);
  });

  it("keeps a valid session usable alongside a malformed cookie", async () => {
    const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: "ws-1",
      user: "admin-1",
      workspaceRole: "ADMIN",
    });
    const component = await request(app).get("/component/assistant").query({ auth_token: token });
    const cookie = requireSessionCookie(component.headers);

    const response = await request(app).get("/api/me").set("Cookie", `other=%zz; ${cookie}; another=%E0%A4%A`);

    expect(response.status).toBe(200);
    expect(response.body.preferences).toBeDefined();
  });

  it("treats a malformed SESSION cookie as unauthenticated, not a crash", async () => {
    const response = await request(app).get("/api/me").set("Cookie", "ai_assistant_session=%zz");
    expect(response.status).toBe(401);
  });

  it("still decodes ordinary percent-encoded cookie values", async () => {
    const response = await request(app).get("/api/me").set("Cookie", "other=a%20b");
    expect(response.status).toBe(401);
  });

  it.each(["/privacy", "/terms", "/support", "/security"])("serves a customer-facing public document at %s", async (path) => {
    const response = await request(app).get(path);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["cache-control"]).toContain("public");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.text).toContain("mailto:support@example.com");
    expect(response.text).not.toContain("src/");
    expect(response.text).not.toContain("admin package");
    expect(response.text).not.toContain("MARKETPLACE_READINESS");
    expect(response.text.length).toBeGreaterThan(100);
  });

  it("publishes prepared Terms with the complete public-document navigation", async () => {
    const response = await request(app).get("/terms");

    expect(response.status).toBe(200);
    expect(response.text).toContain("Terms of Use");
    expect(response.text).toContain('href="/privacy"');
    expect(response.text).toContain('href="/terms"');
    expect(response.text).toContain('href="/support"');
    expect(response.text).toContain('href="/security"');
    expect(response.text).toContain("partial or unknown outcome");
  });

  it("component route rejects an admin whose workspace has no active installation (no session minted)", async () => {
    // The add-on was never installed (or was uninstalled) for this workspace. A
    // valid admin token must NOT mint a privileged session/cookie — that session
    // would otherwise read permissions/metrics/history for an uninstalled workspace.
    const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: "ws-not-installed",
      user: "admin-1",
      workspaceRole: "ADMIN",
    });
    const res = await request(app).get("/component/assistant").query({ auth_token: token });
    expect(res.status).toBe(409);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("chat route requires a session", async () => {
    const res = await request(app).post("/api/chat/messages").send({ message: "hi" });
    expect(res.status).toBe(401);
  });

  it.each([
    { engine: "v1" as const, selected: "v1" },
    { engine: "v2" as const, selected: "v2" },
  ])("constructs and runs only the $selected assistant pipeline", async ({ engine, selected }) => {
    const v1Run = vi.fn<ChatPipeline["executeChatTurn"]>(async () => ({
      ok: true,
      replyKind: "answer",
      replyText: "selected-v1",
      results: [],
      resultLinks: [],
    }));
    const v2Run = vi.fn<ChatPipeline["executeChatTurn"]>(async () => ({
      ok: false,
      code: "selected-v2",
      message: "selected-v2",
    }));
    const v1Factory = vi.fn((deps: AppDeps): ChatPipeline => ({
      ...createChatPipeline(deps),
      executeChatTurn: v1Run,
    }));
    const v2Factory = vi.fn((deps: AppDeps): ChatPipeline => ({
      ...createChatPipeline(deps),
      executeChatTurn: v2Run,
    }));
    const isolated = isolatedRouteApp(engine, modelClient, {
      v1: v1Factory,
      v2: v2Factory,
    });
    expect(v1Factory).toHaveBeenCalledTimes(engine === "v1" ? 1 : 0);
    expect(v2Factory).toHaveBeenCalledTimes(engine === "v2" ? 1 : 0);
    expect(v1Run).not.toHaveBeenCalled();
    expect(v2Run).not.toHaveBeenCalled();

    try {
      const cookie = mintAdminCookie(isolated.store, "test-session-secret");
      const response = await request(isolated.app)
        .post("/api/chat/messages")
        .set("Cookie", cookie)
        .send({ message: "route this turn" });

      expect(v1Factory).toHaveBeenCalledTimes(engine === "v1" ? 1 : 0);
      expect(v2Factory).toHaveBeenCalledTimes(engine === "v2" ? 1 : 0);
      expect(v1Run).toHaveBeenCalledTimes(engine === "v1" ? 1 : 0);
      expect(v2Run).toHaveBeenCalledTimes(engine === "v2" ? 1 : 0);
      expect(response.body).toMatchObject(
        engine === "v1"
          ? { ok: true, reply: { kind: "answer", text: "selected-v1" } }
          : { ok: false, code: "selected-v2", message: "selected-v2" },
      );
    } finally {
      isolated.store.close();
    }
  });

  it("returns v2 model_unavailable without calling the v1 JSON model runner", async () => {
    const complete = vi.fn<ModelClient["complete"]>(async () => {
      throw new Error("v1 assistant runner was called");
    });
    const isolated = isolatedRouteApp("v2", { complete });

    try {
      const cookie = mintAdminCookie(isolated.store, "test-session-secret");
      const response = await request(isolated.app)
        .post("/api/chat/messages")
        .set("Cookie", cookie)
        .send({ message: "route this turn" });

      expect(response.status).toBe(502);
      expect(response.body).toEqual({
        ok: false,
        code: "model_unavailable",
        message: "Assistant engine v2 requires a native tool-calling model client.",
      });
      expect(complete).not.toHaveBeenCalled();
    } finally {
      isolated.store.close();
    }
  });

  it("commits a pre-v2 preview without running the v1 model resume", async () => {
    let modelCallCount = 0;
    const completeWithTools = vi.fn<NonNullable<ModelClient["completeWithTools"]>>(async () => {
      modelCallCount += 1;
      return {
        text: "v1 resume ran",
        toolCalls: modelCallCount === 1
        ? [{
            id: "delete-call",
            name: "clockify_delete_entity",
            arguments: { entityType: "project", id: "p1", name: "Acme" },
          }]
        : [],
      };
    });
    const resumableModel: ModelClient = {
      complete: modelClient.complete,
      completeWithTools,
    };
    const v1 = isolatedRouteApp("v1", resumableModel);

    try {
      const cookie = mintAdminCookie(v1.store, "test-session-secret");
      const chat = await request(v1.app)
        .post("/api/chat/messages")
        .set("Cookie", cookie)
        .send({ message: "delete project Acme with id p1" });
      const preview = chat.body.results.find((result: { kind: string }) => result.kind === "preview");
      expect(preview?.previewId).toBeTruthy();
      expect(completeWithTools).toHaveBeenCalledTimes(1);

      const v2 = isolatedRouteApp("v2", resumableModel, undefined, v1.store);
      const confirmed = await request(v2.app)
        .post(`/api/confirmations/${preview.previewId}/confirm`)
        .set("Cookie", cookie)
        .send({ nonce: preview.nonce });

      expect(confirmed.status).toBe(200);
      expect(confirmed.body.ok).toBe(true);
      expect(v2.fake.counts.archiveProjectAtomic).toBe(1);
      expect(v2.fake.counts.deleteProjectAtomic).toBe(1);
      expect(confirmed.body.resume).toBeUndefined();
      expect(completeWithTools).toHaveBeenCalledTimes(1);
    } finally {
      v1.store.close();
    }
  });

  it("permissions route returns the default policy on first run", async () => {
    const cookie = await adminCookie();
    const res = await request(app).get("/api/permissions").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.firstRun).toBe(true);
    expect(res.body.policy.groups.time_tracking).toBe("read_write");
  });

  it("confirm route requires an existing pending preview", async () => {
    const cookie = await adminCookie();
    const res = await request(app)
      .post("/api/confirmations/does-not-exist/confirm")
      .set("Cookie", cookie)
      .send({ nonce: "whatever" });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("not_found");
  });

  it("recap questions read the AUDIT LOG through assistant_recent_outcomes — the route wires the capability (live items 304/316)", async () => {
    const cookie = await adminCookie();
    const res = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "what failed today?" });
    expect(res.status).toBe(200);
    const receipt = res.body.results.find((r: { kind: string }) => r.kind === "receipt");
    expect(receipt).toBeDefined();
    expect(receipt.receipt.ok).toBe(true);
    expect(receipt.receipt.data.metrics.totals).toBeDefined();
    expect(Array.isArray(receipt.receipt.data.metrics.byAction)).toBe(true);
  });

  it("a pending preview never reports the risky action as done — reply text is truthful", async () => {
    const cookie = await adminCookie();
    const chat = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "delete project Acme with id p1" });
    expect(chat.status).toBe(200);
    expect(chat.body.results.some((r: { kind: string }) => r.kind === "preview")).toBe(true);
    const reply = String(chat.body.reply?.text ?? "");
    // The model lied ("Done!… confirmed"); the route must replace that with a truthful,
    // action-not-yet-applied instruction.
    expect(reply).not.toMatch(/\bdone\b/i);
    expect(reply).not.toMatch(/\bconfirmed\b/i);
    expect(reply).toMatch(/confirm/i); // tells the user to click Confirm
    expect(reply).toMatch(/not|nothing|yet/i); // makes clear nothing has changed
  });

  it("a failed single-turn safe write never reports the model's pre-execution success claim (truthfulness-02)", async () => {
    const cookie = await adminCookie();
    const chat = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "create tag Billing" });
    expect(chat.status).toBe(200);
    // The only proposed write failed (invalid_args) — no preview, a failed receipt.
    expect(chat.body.results.some((r: { kind: string }) => r.kind === "preview")).toBe(false);
    const receipt = chat.body.results.find((r: { kind: string }) => r.kind === "receipt");
    expect(receipt).toBeDefined();
    expect(receipt.receipt.ok).toBe(false);

    const reply = String(chat.body.reply?.text ?? "");
    // The model lied ("Done! I created the tag"); the route must replace that with
    // deterministic honest text that reports the failure, not the optimistic claim.
    expect(reply).not.toMatch(/\bdone\b/i);
    expect(reply).not.toMatch(/\bcreated\b/i);
    expect(reply).toMatch(/fail/i); // tells the user the action failed
  });

  it("a risky chat message creates a preview that can be cancelled", async () => {
    const cookie = await adminCookie();
    const chat = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "delete project Acme with id p1" });
    expect(chat.status).toBe(200);
    const preview = chat.body.results.find((r: { kind: string }) => r.kind === "preview");
    expect(preview).toBeDefined();
    expect(preview.previewId).toBeTruthy();

    const cancel = await request(app)
      .post(`/api/confirmations/${preview.previewId}/cancel`)
      .set("Cookie", cookie)
      .send({});
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe("cancelled");
  });

  it("two concurrent confirms execute the operation exactly once (one-use)", async () => {
    const cookie = await adminCookie();
    const chat = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "delete project Acme with id p1" });
    const preview = chat.body.results.find((r: { kind: string }) => r.kind === "preview");
    expect(preview?.previewId).toBeTruthy();

    const archiveBefore = fake.counts.archiveProjectAtomic ?? 0;
    const deleteBefore = fake.counts.deleteProjectAtomic ?? 0;
    const [a, b] = await Promise.all([
      request(app)
        .post(`/api/confirmations/${preview.previewId}/confirm`)
        .set("Cookie", cookie)
        .send({ nonce: preview.nonce }),
      request(app)
        .post(`/api/confirmations/${preview.previewId}/confirm`)
        .set("Cookie", cookie)
        .send({ nonce: preview.nonce }),
    ]);

    const statuses = [a.status, b.status].sort();
    // exactly one succeeds (200); the other is rejected (not pending / already used)
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBeGreaterThanOrEqual(400);
    expect((fake.counts.archiveProjectAtomic ?? 0) - archiveBefore).toBe(1);
    expect((fake.counts.deleteProjectAtomic ?? 0) - deleteBefore).toBe(1);
  });

  it("a confirm denied by lowered policy does not consume the preview", async () => {
    const cookie = await adminCookie();
    const chat = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "delete project Acme with id p1" });
    const preview = chat.body.results.find((r: { kind: string }) => r.kind === "preview");
    expect(preview?.previewId).toBeTruthy();

    // Lower the policy after the preview was issued.
    const lowered = defaultAdminPolicy();
    lowered.groups.work_structure = "off";
    store.upsertAdminPolicy("ws-1", "admin-1", lowered);

    const archiveBefore = fake.counts.archiveProjectAtomic ?? 0;
    const deleteBefore = fake.counts.deleteProjectAtomic ?? 0;
    const denied = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });
    expect(denied.status).toBe(400);
    expect(denied.body.code).toBe("policy_denied");
    expect((fake.counts.archiveProjectAtomic ?? 0) - archiveBefore).toBe(0);
    expect((fake.counts.deleteProjectAtomic ?? 0) - deleteBefore).toBe(0);

    // Re-enable and confirm the SAME preview — it was never consumed.
    store.upsertAdminPolicy("ws-1", "admin-1", defaultAdminPolicy());
    const ok = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect((fake.counts.archiveProjectAtomic ?? 0) - archiveBefore).toBe(1);
    expect((fake.counts.deleteProjectAtomic ?? 0) - deleteBefore).toBe(1);
  });
});
