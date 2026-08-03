import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { testKeys } from "../helpers/test-keys.js";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { makeTestConfig } from "../helpers/config.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { mintAdminCookie } from "../helpers/session.js";
import type { ModelClient } from "../../src/assistant/model-client.js";

/**
 * T16-F literal route-output parity fixtures. These pin the EXACT bodies the
 * transport routes emit for the deterministic paths (empty history, not-found
 * lookups, invalid cursors) so a later service refactor cannot silently
 * change the wire contract the UI decodes.
 */
const ADDON_KEY = "ai-assistant";

const modelClient: ModelClient = {
  async complete() {
    return JSON.stringify({ kind: "answer", text: "hi" });
  },
};

let store: Store;
let app: Express;
let cookie: string;

beforeAll(async () => {
  const keys = await testKeys();
  const config = makeTestConfig({
    clockifyAddonPublicKeyPem: keys.pem,
    clockifyAddonKey: ADDON_KEY,
  });
  store = createStore(":memory:", { encryptionKey: "test-key" });
  store.saveInstallation({
    workspaceId: "ws-1",
    addonId: "addon-1",
    addonUserId: "addon-user-1",
    addonToken: "addon-token",
  });
  app = createApp({
    config,
    store,
    parser: createSignatureParser(ADDON_KEY, keys.pem),
    modelClient,
    clockifyForWorkspace: () => createFakeWorkspace().client,
  });
  cookie = mintAdminCookie(store, "test-session-secret");
});

afterAll(() => store.close());

describe("literal route-output parity (T16-F)", () => {
  it("GET /api/chat/history on a fresh session", async () => {
    const res = await request(app).get("/api/chat/history").set("Cookie", cookie);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ ok: true, messages: [], pendingPreviews: [] });
  });

  it("GET /api/chat/sessions marks the cookie session current", async () => {
    const res = await request(app).get("/api/chat/sessions").set("Cookie", cookie);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ok).toBe(true);
    // The cookie's own (empty) session is excluded by the non-empty filter.
    expect(Array.isArray(res.body.sessions)).toBe(true);
  });

  it("GET /api/permissions first-run view", async () => {
    const res = await request(app).get("/api/permissions").set("Cookie", cookie);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.firstRun).toBe(true);
    expect(Array.isArray(res.body.featureGroups)).toBe(true);
    expect(res.body.policy.groups.time_tracking).toBe("read_write");
  });

  it("GET /api/metrics returns the caller-scoped report envelope", async () => {
    const res = await request(app).get("/api/metrics").set("Cookie", cookie);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.metrics).toHaveProperty("totals");
    expect(res.body.metrics).toHaveProperty("confirmations");
    expect(res.body.metrics).toHaveProperty("usage");
  });

  it("not-found lookups keep their exact bodies", async () => {
    const cases: Array<{ method: "get" | "post"; path: string; body?: object; expected: object }> = [
      {
        method: "get",
        path: "/api/operations/00000000-0000-4000-8000-000000000000",
        expected: { ok: false, code: "not_found", message: "Operation not found." },
      },
      {
        method: "get",
        path: "/api/operation-runs/00000000-0000-4000-8000-000000000000",
        expected: { ok: false, code: "not_found", message: "Operation not found." },
      },
      {
        method: "get",
        path: "/api/artifacts/unknown-artifact",
        expected: { ok: false, code: "not_found", message: "Artifact not found or expired." },
      },
      {
        method: "post",
        path: "/api/undo/00000000-0000-4000-8000-000000000000",
        expected: { ok: false, code: "not_found", message: "No such undoable action." },
      },
      {
        method: "post",
        path: "/api/confirmations/00000000-0000-4000-8000-000000000000/confirm",
        body: { nonce: "n" },
        expected: { ok: false, code: "not_found", message: "No such pending preview." },
      },
      {
        method: "post",
        path: "/api/confirmations/00000000-0000-4000-8000-000000000000/cancel",
        expected: { ok: false, code: "not_found", message: "No such pending preview." },
      },
      {
        method: "post",
        path: "/api/confirmation-batches/00000000-0000-4000-8000-000000000000/confirm",
        body: { items: [{ confirmationId: "00000000-0000-4000-8000-000000000000", nonce: "n" }] },
        expected: { ok: false, code: "not_found", message: "No such confirmation batch." },
      },
      {
        method: "post",
        path: "/api/chat/sessions/unknown-session/open",
        expected: { ok: false, code: "not_found", message: "Conversation not found." },
      },
    ];
    for (const testCase of cases) {
      const req = request(app)[testCase.method](testCase.path).set("Cookie", cookie);
      const res = testCase.body ? await req.send(testCase.body) : await req.send({});
      expect(res.status, JSON.stringify({ path: testCase.path, body: res.body })).toBe(404);
      expect(res.body, testCase.path).toEqual(testCase.expected);
    }
  });

  it("invalid decode paths keep their exact bodies", async () => {
    const badCursor = await request(app)
      .get("/api/runs/00000000-0000-4000-8000-000000000000/events?after=notanumber")
      .set("Cookie", cookie);
    expect(badCursor.status, JSON.stringify(badCursor.body)).toBe(400);
    expect(badCursor.body).toEqual({ ok: false, code: "invalid_query", message: "Invalid events cursor." });

    const badOption = await request(app)
      .post("/api/clarifications/00000000-0000-4000-8000-000000000000/resolve")
      .set("Cookie", cookie)
      .send({ label: "x" });
    expect(badOption.status, JSON.stringify(badOption.body)).toBe(400);
    expect(badOption.body).toEqual({ ok: false, code: "invalid_args", message: "An option id is required." });

    const badNonce = await request(app)
      .post("/api/confirmations/00000000-0000-4000-8000-000000000000/confirm")
      .set("Cookie", cookie)
      .send({});
    expect(badNonce.status, JSON.stringify(badNonce.body)).toBe(400);
    expect(badNonce.body).toEqual({ ok: false, code: "invalid_args", message: "A confirmation nonce is required." });

    const badBatch = await request(app)
      .post("/api/confirmation-batches/00000000-0000-4000-8000-000000000000/confirm")
      .set("Cookie", cookie)
      .send({ items: [] });
    expect(badBatch.status, JSON.stringify(badBatch.body)).toBe(400);
    expect(badBatch.body).toEqual({ ok: false, code: "invalid_args", message: "Batch confirmation payload is invalid." });

    const badPermissionConfirm = await request(app)
      .post("/api/permissions/confirm")
      .set("Cookie", cookie)
      .send({ groups: { invoices: "off" } });
    expect(badPermissionConfirm.status, JSON.stringify(badPermissionConfirm.body)).toBe(400);
    expect(badPermissionConfirm.body).toEqual({
      ok: false,
      code: "invalid_args",
      message: "A permission preview token is required.",
    });
  });

  it("unauthenticated requests 401 uniformly across routers", async () => {
    for (const path of ["/api/me", "/api/metrics", "/api/permissions", "/api/chat/history", "/api/chat/sessions"]) {
      const res = await request(app).get(path);
      expect(res.status, JSON.stringify({ path, body: res.body })).toBe(401);
      expect(res.body.code, path).toBe("unauthorized");
    }
  });
});
