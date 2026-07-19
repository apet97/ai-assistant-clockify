import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { testKeys } from "../helpers/test-keys.js";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { makeTestConfig } from "../helpers/config.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import { scriptedToolModel } from "../helpers/scripted-model.js";
import type { ToolCompletion } from "../../src/assistant/model-client.js";
import { mintAdminCookie, requireSessionCookie } from "../helpers/session.js";

/**
 * GET /api/chat/sessions (the chat-history switcher list): a session-gated,
 * tenant-scoped list of the admin's live, non-empty conversations, newest-first,
 * each marked `current` for the cookie's own session. The route — not the client
 * — decides which is current (the cookie is HttpOnly, so the UI can't know its
 * own session id). No cookie ⇒ 401, mirroring GET /api/chat/history.
 */
const ADDON_KEY = "ai-assistant";

let stores: Store[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores = [];
});

async function makeApp(
  script: ToolCompletion[],
  fake: FakeWorkspace,
): Promise<{ app: Express; cookie: string; store: Store }> {
  const keys = await testKeys();
  const config = makeTestConfig({
    clockifyAddonPublicKeyPem: keys.pem,
    clockifyAddonKey: ADDON_KEY,
  });
  const store = createStore(":memory:", { encryptionKey: "test-key" });
  stores.push(store);
  store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
  const app = createApp({
    config,
    store,
    parser: createSignatureParser(ADDON_KEY, keys.pem),
    modelClient: scriptedToolModel(script),
    clockifyForWorkspace: () => fake.client,
  });
  const cookie = mintAdminCookie(store, config.sessionSecret);
  return { app, cookie, store };
}

describe("GET /api/chat/sessions (chat-history list)", () => {
  it("requires a session (no cookie ⇒ 401)", async () => {
    const { app } = await makeApp([], createFakeWorkspace());
    const res = await request(app).get("/api/chat/sessions");
    expect(res.status).toBe(401);
  });

  it("lists the admin's live non-empty conversations newest-first and marks the cookie's session current", async () => {
    // Two replies per "turn" because tags_create previews then commits in the
    // scripted model; here the model just answers — one user message per session
    // is enough to make a session non-empty (and give it a title).
    const { app, cookie } = await makeApp(
      [{ text: "Sure.", toolCalls: [] }, { text: "Sure.", toolCalls: [] }],
      createFakeWorkspace(),
    );

    // First conversation: a user message in the original session.
    await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "first conversation" });

    // Start a second conversation: /chat/new re-cookies to a FRESH session.
    const fresh = await request(app).post("/api/chat/new").set("Cookie", cookie).send({});
    expect(fresh.status).toBe(200);
    const cookie2 = requireSessionCookie(fresh.headers);
    await request(app).post("/api/chat/messages").set("Cookie", cookie2).send({ message: "second conversation" });

    const res = await request(app).get("/api/chat/sessions").set("Cookie", cookie2);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const sessions = res.body.sessions as Array<{
      id: string;
      title: string;
      messageCount: number;
      lastMessageAt: string;
      current: boolean;
    }>;
    expect(sessions).toHaveLength(2);
    // Newest-first: the second conversation (most recent activity) leads.
    expect(sessions[0]).toMatchObject({ title: "second conversation", current: true });
    expect(sessions[1]).toMatchObject({ title: "first conversation", current: false });
    expect(sessions[0].messageCount).toBeGreaterThan(0);
    expect(typeof sessions[0].lastMessageAt).toBe("string");
    // Exactly one session is the current one (the cookie's session).
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
  });
});

/**
 * POST /api/chat/sessions/:id/open (the chat-history SWITCH). The IDOR guard is
 * the point: `:id` is attacker-controlled, so the route MUST verify the target
 * session belongs to the authenticated workspace+admin (mirroring resolveSession /
 * the component reuse gate) BEFORE re-cookieing. A foreign/other-admin/expired id
 * returns 404 (never 403 — existence is not confirmed) and sets NO cookie. The
 * happy path re-cookies to the OWNED target (carrying the target's own, UNEXTENDED
 * expiry) and a subsequent /chat/history then replays THAT session.
 */
describe("POST /api/chat/sessions/:id/open (chat-history switch)", () => {
  it("requires a session (no cookie ⇒ 401)", async () => {
    const { app } = await makeApp([], createFakeWorkspace());
    const res = await request(app).post("/api/chat/sessions/whatever/open");
    expect(res.status).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("404s an IDOR attempt to switch to ANOTHER admin's session and sets NO cookie", async () => {
    const { app, cookie, store } = await makeApp([], createFakeWorkspace());
    // A live session in the SAME workspace owned by a DIFFERENT admin — a foreign
    // target the cookie's admin (admin-1) must never be able to open.
    const foreign = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-2" });

    const res = await request(app)
      .post(`/api/chat/sessions/${foreign.id}/open`)
      .set("Cookie", cookie)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    // CRITICAL: the IDOR attempt must NOT re-cookie the caller to the foreign session.
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("404s an IDOR attempt to switch to a session in ANOTHER workspace and sets NO cookie", async () => {
    const { app, cookie, store } = await makeApp([], createFakeWorkspace());
    // Same admin id, DIFFERENT workspace — cross-tenant target.
    const foreign = store.createSession({ workspaceId: "ws-2", adminUserId: "admin-1" });

    const res = await request(app)
      .post(`/api/chat/sessions/${foreign.id}/open`)
      .set("Cookie", cookie)
      .send({});

    expect(res.status).toBe(404);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("404s an unknown id and sets NO cookie", async () => {
    const { app, cookie } = await makeApp([], createFakeWorkspace());
    const res = await request(app)
      .post("/api/chat/sessions/does-not-exist/open")
      .set("Cookie", cookie)
      .send({});
    expect(res.status).toBe(404);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("404s an expired id (getSession drops it) and sets NO cookie", async () => {
    const { app, cookie, store } = await makeApp([], createFakeWorkspace());
    // Owned by THIS admin+workspace but already expired → getSession returns
    // undefined → 404 for free (no TTL revival, no cookie issued).
    const expired = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1", ttlMs: -1000 });
    const res = await request(app)
      .post(`/api/chat/sessions/${expired.id}/open`)
      .set("Cookie", cookie)
      .send({});
    expect(res.status).toBe(404);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("switches to the admin's OWN other session: {ok:true}, re-cookies, and /chat/history replays THAT session", async () => {
    const { app, cookie } = await makeApp(
      [{ text: "Sure.", toolCalls: [] }, { text: "Sure.", toolCalls: [] }],
      createFakeWorkspace(),
    );

    // First conversation in the original session.
    await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "first conversation" });

    // Capture the FIRST session id from the list (it's owned by admin-1).
    const listed = await request(app).get("/api/chat/sessions").set("Cookie", cookie);
    const firstSessionId = (listed.body.sessions as Array<{ id: string; title: string }>).find(
      (s) => s.title === "first conversation",
    )?.id as string;
    expect(typeof firstSessionId).toBe("string");

    // Start a second conversation (re-cookies to a fresh session).
    const fresh = await request(app).post("/api/chat/new").set("Cookie", cookie).send({});
    expect(fresh.status).toBe(200);
    const cookie2 = requireSessionCookie(fresh.headers);
    await request(app).post("/api/chat/messages").set("Cookie", cookie2).send({ message: "second conversation" });

    // From the second session, switch BACK to the first (owned) session.
    const open = await request(app)
      .post(`/api/chat/sessions/${firstSessionId}/open`)
      .set("Cookie", cookie2)
      .send({});
    expect(open.status).toBe(200);
    expect(open.body).toEqual({ ok: true });
    const switchedCookie = requireSessionCookie(open.headers);

    // The re-cookie now binds the first session: /chat/history replays IT.
    const history = await request(app).get("/api/chat/history").set("Cookie", switchedCookie);
    expect(history.status).toBe(200);
    const contents = (history.body.messages as Array<{ role: string; content: string }>)
      .filter((m) => m.role === "user")
      .map((m) => m.content);
    expect(contents).toContain("first conversation");
    expect(contents).not.toContain("second conversation");
  });
});
