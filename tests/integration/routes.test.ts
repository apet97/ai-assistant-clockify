import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

const ADDON_KEY = "ai-assistant";

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

async function adminCookie(role = "ADMIN"): Promise<string> {
  const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
    workspaceId: "ws-1",
    user: "admin-1",
    workspaceRole: role,
    backendUrl: "https://api.clockify.me",
    addonId: "addon-1",
  });
  const res = await request(app).get("/component/assistant").query({ auth_token: token });
  const setCookie = res.headers["set-cookie"];
  return Array.isArray(setCookie) ? setCookie[0].split(";")[0] : "";
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
      version: "1.0.0",
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
        reasoningEffort: null,
        thinkingMode: null,
      },
    });
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
    const setCookie = res.headers["set-cookie"];
    expect(Array.isArray(setCookie) && setCookie[0]).toContain("ai_assistant_session=");
    expect(Array.isArray(setCookie) && setCookie[0]).toContain("HttpOnly");
    // Cross-site iframe: cookie must be SameSite=None over HTTPS or the chat 401s.
    expect(Array.isArray(setCookie) && setCookie[0]).toContain("SameSite=None");
  });

  it("propagates verified Clockify theme/language into sanitized UI preferences and public links", async () => {
    const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: "ws-1",
      user: "admin-1",
      workspaceRole: "ADMIN",
      language: "SR",
      theme: "DARK",
    });
    const component = await request(app).get("/component/assistant").query({ auth_token: token });
    const setCookie = component.headers["set-cookie"];
    const cookie = Array.isArray(setCookie) ? setCookie[0].split(";")[0] : "";
    const me = await request(app).get("/api/me").set("Cookie", cookie);

    expect(me.status).toBe(200);
    expect(me.body.preferences).toMatchObject({ theme: "dark", language: "sr", timeZone: "UTC" });
    expect(me.body.links).toEqual({
      privacy: "https://example.com/privacy",
      support: "https://example.com/support",
      security: "https://example.com/security",
    });
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
