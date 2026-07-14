import { describe, expect, it } from "vitest";
import request from "supertest";
import { testKeys } from "../helpers/test-keys.js";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore } from "../../src/db/store.js";
import { makeTestConfig } from "../helpers/config.js";
import type { ModelClient } from "../../src/assistant/model-client.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { mintAdminCookie } from "../helpers/session.js";

const ADDON_KEY = "ai-assistant";

const modelClient: ModelClient = {
  async complete() {
    return "{}";
  },
};

/**
 * authz-surface-01: with ROLE_RECHECK=1, a session minted for an admin who is
 * then demoted in Clockify is denied on the next /api request (the fake's
 * member-role read returns a non-admin role). With ROLE_RECHECK off, the same
 * request succeeds (the prior cookie-only posture, byte-identical).
 */
async function buildApp(roleRecheckEnabled: boolean, memberRole: string, roleLookupFails = false) {
  const keys = await testKeys();
  const config = makeTestConfig({
    clockifyAddonPublicKeyPem: keys.pem,
    clockifyAddonKey: ADDON_KEY,
    roleRecheckEnabled,
    roleRecheckTtlMs: 60_000,
  });
  const store = createStore(":memory:", { encryptionKey: "test-key" });
  store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
  const parser = createSignatureParser(ADDON_KEY, keys.pem);
  // Seed the caller's CURRENT workspace role (the per-request re-check reads it).
  const fake = createFakeWorkspace({ memberRoles: { "admin-1": memberRole } });
  const clockify = roleLookupFails
    ? { ...fake.client, getWorkspaceMemberRole: async () => { throw new Error("Clockify unavailable"); } }
    : fake.client;
  const app = createApp({ config, store, parser, modelClient, clockifyForWorkspace: () => clockify });
  const cookie = mintAdminCookie(store, config.sessionSecret, { adminUserId: "admin-1" });
  return { app, cookie, store };
}

describe("per-request admin re-check (authz-surface-01)", () => {
  it("denies a demoted admin with 403 {forbidden} when ROLE_RECHECK is on", async () => {
    const { app, cookie } = await buildApp(true, "MEMBER"); // demoted in Clockify
    const res = await request(app).get("/api/me").set("Cookie", cookie);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("forbidden");
  });

  it("still admits a current admin with 200 when ROLE_RECHECK is on", async () => {
    const { app, cookie } = await buildApp(true, "ADMIN");
    const res = await request(app).get("/api/me").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("admits the same demoted admin with 200 when ROLE_RECHECK is off (prior posture)", async () => {
    const { app, cookie } = await buildApp(false, "MEMBER");
    const res = await request(app).get("/api/me").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("always rechecks immediately before a write and invalidates a demoted admin's sessions", async () => {
    const { app, cookie } = await buildApp(false, "MEMBER");
    const denied = await request(app)
      .post("/api/permissions/confirm")
      .set("Cookie", cookie)
      .send({ groups: { invoices: "off" } });

    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("admin_required");
    const after = await request(app).get("/api/me").set("Cookie", cookie);
    expect(after.status).toBe(401);
  });

  it("fails a write closed when the current role cannot be verified", async () => {
    const { app, cookie, store } = await buildApp(false, "ADMIN", true);
    const denied = await request(app)
      .post("/api/permissions/confirm")
      .set("Cookie", cookie)
      .send({ groups: { invoices: "off" } });

    expect(denied.status).toBe(503);
    expect(denied.body.code).toBe("role_verification_unavailable");
    expect(store.getAdminPolicy("ws-1", "admin-1")).toBeUndefined();
  });
});
