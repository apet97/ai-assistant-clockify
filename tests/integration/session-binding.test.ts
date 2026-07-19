import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { makeTestConfig } from "../helpers/config.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { scriptedToolModel } from "../helpers/scripted-model.js";
import { testKeys } from "../helpers/test-keys.js";
import { signSessionCookie, type SessionClaims } from "../../src/auth/sessions.js";
import { buildSessionCookie } from "../../src/routes/deps.js";

/**
 * Cross-workspace session binding (IDOR defense-in-depth). `resolveSession`
 * (src/routes/deps.ts) does NOT trust the signed cookie alone — it cross-checks
 * the cookie's claims against the SERVER-SIDE session row: a validly-signed cookie
 * whose `workspaceId`/`adminUserId` disagree with the stored session is rejected
 * (returns `undefined` → 401). These tests prove the guard rejects a
 * signed-but-MISMATCHED cookie at the `/api` boundary — not merely a missing or
 * unsigned one. The CONTROL case (a matching cookie → 200) anchors the result: the
 * 401s come from the binding guard, not a bad signature or wrong secret.
 *
 * Each cookie is signed with the REAL session secret (`config.sessionSecret`), so
 * `verifySessionCookie` PASSES and the binding guard — not signature rejection —
 * is what's under test (the distinction the unsigned-cookie tests don't cover).
 */
const ADDON_KEY = "ai-assistant";

let stores: Store[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores = [];
});

async function makeApp(): Promise<{ app: Express; store: Store; sessionSecret: string }> {
  const keys = await testKeys();
  const config = makeTestConfig({ clockifyAddonPublicKeyPem: keys.pem, clockifyAddonKey: ADDON_KEY });
  const store = createStore(":memory:", { encryptionKey: "test-key" });
  stores.push(store);
  store.saveInstallation({
    workspaceId: "ws-A",
    addonId: "addon-ws-A",
    addonUserId: "addon-user-ws-A",
    addonToken: "addon-token-ws-A",
  });
  const fake = createFakeWorkspace({ memberRoles: { "admin-1": "ADMIN" } });
  const app = createApp({
    config,
    store,
    parser: createSignatureParser(ADDON_KEY, keys.pem),
    modelClient: scriptedToolModel([]),
    clockifyForWorkspace: () => fake.client,
  });
  return { app, store, sessionSecret: config.sessionSecret };
}

/** Sign `claims` with the real secret and reduce to the `name=value` pair routes set. */
function signedCookie(claims: SessionClaims, sessionSecret: string): string {
  return buildSessionCookie(signSessionCookie(claims, sessionSecret), false).split(";")[0];
}

describe("GET /api/me cross-workspace session binding (IDOR defense-in-depth)", () => {
  it("rejects a validly-signed cookie whose workspaceId ≠ the stored session's (401)", async () => {
    const { app, store, sessionSecret } = await makeApp();
    // A real session row bound to ws-A.
    const session = store.createSession({ workspaceId: "ws-A", adminUserId: "admin-1" });
    // A VALIDLY signed cookie (correct secret, unexpired) but claiming ws-B for the
    // SAME session id — a cross-tenant cookie the binding guard must reject.
    const cookie = signedCookie(
      {
        sessionId: session.id,
        workspaceId: "ws-B", // ← mismatch vs the stored ws-A row
        adminUserId: "admin-1",
        workspaceRole: "ADMIN",
        expiresAt: session.expiresAt,
      },
      sessionSecret,
    );

    const res = await request(app).get("/api/me").set("Cookie", cookie);

    expect(res.status).toBe(401);
  });

  it("rejects a validly-signed cookie whose adminUserId ≠ the stored session's (401)", async () => {
    const { app, store, sessionSecret } = await makeApp();
    const session = store.createSession({ workspaceId: "ws-A", adminUserId: "admin-1" });
    const cookie = signedCookie(
      {
        sessionId: session.id,
        workspaceId: "ws-A",
        adminUserId: "admin-2", // ← mismatch vs the stored admin-1 row
        workspaceRole: "ADMIN",
        expiresAt: session.expiresAt,
      },
      sessionSecret,
    );

    const res = await request(app).get("/api/me").set("Cookie", cookie);

    expect(res.status).toBe(401);
  });

  it("CONTROL: a matching validly-signed cookie is accepted (200) — so the 401s are the binding guard, not a bad signature", async () => {
    const { app, store, sessionSecret } = await makeApp();
    const session = store.createSession({ workspaceId: "ws-A", adminUserId: "admin-1" });
    const cookie = signedCookie(
      {
        sessionId: session.id,
        workspaceId: "ws-A",
        adminUserId: "admin-1",
        workspaceRole: "ADMIN",
        expiresAt: session.expiresAt,
      },
      sessionSecret,
    );

    const res = await request(app).get("/api/me").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, workspaceId: "ws-A", adminUserId: "admin-1" });
  });
});
