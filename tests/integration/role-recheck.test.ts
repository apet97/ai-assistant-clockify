import { describe, expect, it } from "vitest";
import request, { type Response } from "supertest";
import { testKeys } from "../helpers/test-keys.js";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
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
 * authz-surface-01: every authenticated API request re-verifies a current
 * positive admin verdict. There is no cookie-only/fail-open mode.
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
  it("coalesces four concurrent cold authenticated surfaces into one role I/O", async () => {
    const keys = await testKeys();
    const config = makeTestConfig({
      clockifyAddonPublicKeyPem: keys.pem,
      clockifyAddonKey: ADDON_KEY,
      roleRecheckTtlMs: 60_000,
    });
    const store = createStore(":memory:", { encryptionKey: "test-key" });
    store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
    const fake = createFakeWorkspace();
    let releaseRole!: () => void;
    let roleStarted!: () => void;
    const roleGate = new Promise<void>((resolve) => { releaseRole = resolve; });
    const started = new Promise<void>((resolve) => { roleStarted = resolve; });
    let lookups = 0;
    const clockify = {
      ...fake.client,
      async getWorkspaceMemberRole() {
        lookups += 1;
        roleStarted();
        await roleGate;
        return "ADMIN";
      },
    };
    const paths = ["/api/me", "/api/permissions", "/api/metrics", "/api/chat/history"] as const;
    let requestsEntered = 0;
    let allRequestsEntered!: () => void;
    const entered = new Promise<void>((resolve) => { allRequestsEntered = resolve; });
    const app = createApp({
      config,
      store,
      parser: createSignatureParser(ADDON_KEY, keys.pem),
      modelClient,
      clockifyForWorkspace: () => {
        requestsEntered += 1;
        if (requestsEntered === paths.length) allRequestsEntered();
        return clockify;
      },
    });
    const cookie = mintAdminCookie(store, config.sessionSecret, { adminUserId: "admin-1" });
    const server = app.listen(0);
    let responsePromises: Array<Promise<Response>> = [];
    let readinessTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.once("listening", resolve);
          server.once("error", reject);
        });
      }
      const sharedRequest = request(server);
      responsePromises = paths.map(async (path) => {
        try {
          return await sharedRequest.get(path).set("Cookie", cookie);
        } catch (error) {
          throw new Error(`${path} request failed before settlement: ${String(error)}`);
        }
      });
      const readinessTimeout = new Promise<never>((_resolve, reject) => {
        readinessTimer = setTimeout(() => {
          reject(new Error(
            `Timed out waiting for all authenticated surfaces to reach role verification: `
            + `entered=${requestsEntered}/${paths.length}, roleLookups=${lookups}`,
          ));
        }, 10_000);
      });
      const readiness = await Promise.race([
        Promise.all([started, entered]).then(() => ({ kind: "entered" as const })),
        ...responsePromises.map(async (response, index) => ({
          kind: "early_response" as const,
          path: paths[index],
          response: await response,
        })),
        readinessTimeout,
      ]);
      if (readiness.kind === "early_response") {
        throw new Error(
          `${readiness.path} settled before all authenticated surfaces reached role verification: `
          + `${readiness.response.status} ${JSON.stringify(readiness.response.body)}`,
        );
      }
      const coldLookups = lookups;
      releaseRole();
      const responses = await Promise.all(responsePromises);

      for (const [index, response] of responses.entries()) {
        expect(response.status, `${paths[index]}: ${JSON.stringify(response.body)}`).toBe(200);
      }
      expect(requestsEntered).toBe(4);
      expect(coldLookups).toBe(1);
      expect(lookups).toBe(1);
    } finally {
      if (readinessTimer !== undefined) clearTimeout(readinessTimer);
      releaseRole();
      const closeSettlement = new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      }).then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
      server.closeAllConnections();
      try {
        await Promise.allSettled(responsePromises);
        const { error } = await closeSettlement;
        if (error) throw error;
      } finally {
        store.close();
      }
    }
  }, 20_000);

  it("does not recreate a session when uninstall erases the workspace during role verification", async () => {
    const keys = await testKeys();
    const config = makeTestConfig({
      clockifyAddonPublicKeyPem: keys.pem,
      clockifyAddonKey: ADDON_KEY,
      roleRecheckTtlMs: 60_000,
    });
    const store = createStore(":memory:", { encryptionKey: "test-key" });
    store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
    const fake = createFakeWorkspace();
    let roleStarted!: () => void;
    let releaseRole!: () => void;
    const started = new Promise<void>((resolve) => { roleStarted = resolve; });
    const roleGate = new Promise<void>((resolve) => { releaseRole = resolve; });
    const clockify = {
      ...fake.client,
      async getWorkspaceMemberRole() {
        roleStarted();
        await roleGate;
        return "ADMIN";
      },
    };
    const app = createApp({
      config,
      store,
      parser: createSignatureParser(ADDON_KEY, keys.pem),
      modelClient,
      clockifyForWorkspace: () => clockify,
    });
    const cookie = mintAdminCookie(store, config.sessionSecret, { adminUserId: "admin-1" });
    const responsePromise = Promise.resolve(request(app).post("/api/chat/new").set("Cookie", cookie).send({}));

    await started;
    const tombstone = store.tombstoneInstallation("ws-1");
    if (!tombstone) throw new Error("expected deletion tombstone");
    store.eraseWorkspaceForDeletion("ws-1", tombstone.generation);
    releaseRole();
    const response = await responsePromise;

    expect(response.status).toBe(503);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(store.getInstallation("ws-1")).toBeUndefined();
    expect(store.listSessions("ws-1", "admin-1", new Date().toISOString())).toEqual([]);
    store.close();
  });

  it("does not recreate a session when uninstall erases at the chat/new write boundary", async () => {
    const keys = await testKeys();
    const config = makeTestConfig({
      clockifyAddonPublicKeyPem: keys.pem,
      clockifyAddonKey: ADDON_KEY,
      roleRecheckTtlMs: 60_000,
    });
    const store = createStore(":memory:", { encryptionKey: "test-key" });
    store.saveInstallation({
      workspaceId: "ws-1",
      addonId: "addon-1",
      addonUserId: "addon-user-1",
      addonToken: "addon-token",
    });
    let armed = false;
    let installationReads = 0;
    const wrappedStore: Store = {
      ...store,
      getInstallation(workspaceId) {
        if (armed) {
          installationReads += 1;
          if (installationReads === 3) {
            const tombstone = store.tombstoneInstallation(workspaceId);
            if (!tombstone) throw new Error("expected deletion tombstone");
            store.eraseWorkspaceForDeletion(workspaceId, tombstone.generation);
          }
        }
        return store.getInstallation(workspaceId);
      },
    };
    const fake = createFakeWorkspace();
    const app = createApp({
      config,
      store: wrappedStore,
      parser: createSignatureParser(ADDON_KEY, keys.pem),
      modelClient,
      clockifyForWorkspace: () => fake.client,
    });
    const cookie = mintAdminCookie(store, config.sessionSecret, { adminUserId: "admin-1" });
    armed = true;

    const response = await request(app).post("/api/chat/new").set("Cookie", cookie).send({});

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("installation_changed");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(store.getInstallation("ws-1")).toBeUndefined();
    expect(store.listSessions("ws-1", "admin-1", new Date().toISOString())).toEqual([]);
    expect(Object.values(store.eraseWorkspace("ws-1")).every((count) => count === 0)).toBe(true);
    store.close();
  });

  it("does not recreate policy, result, or audit rows when uninstall erases at the permission write boundary", async () => {
    const keys = await testKeys();
    const config = makeTestConfig({
      clockifyAddonPublicKeyPem: keys.pem,
      clockifyAddonKey: ADDON_KEY,
      roleRecheckTtlMs: 60_000,
    });
    const store = createStore(":memory:", { encryptionKey: "test-key" });
    store.saveInstallation({
      workspaceId: "ws-1",
      addonId: "addon-1",
      addonUserId: "addon-user-1",
      addonToken: "addon-token",
    });
    let armed = false;
    let installationReads = 0;
    const wrappedStore: Store = {
      ...store,
      getInstallation(workspaceId) {
        if (armed) {
          installationReads += 1;
          if (installationReads === 5) {
            const tombstone = store.tombstoneInstallation(workspaceId);
            if (!tombstone) throw new Error("expected deletion tombstone");
            store.eraseWorkspaceForDeletion(workspaceId, tombstone.generation);
          }
        }
        return store.getInstallation(workspaceId);
      },
    };
    const fake = createFakeWorkspace();
    const app = createApp({
      config,
      store: wrappedStore,
      parser: createSignatureParser(ADDON_KEY, keys.pem),
      modelClient,
      clockifyForWorkspace: () => fake.client,
    });
    const cookie = mintAdminCookie(store, config.sessionSecret, { adminUserId: "admin-1" });

    // Preview-first contract (T16-E): mint the bound token while the
    // installation is intact, then arm erasure for the confirm request only.
    const preview = await request(app)
      .post("/api/permissions/preview")
      .set("Cookie", cookie)
      .send({ groups: { invoices: "off" } });
    expect(preview.status).toBe(200);
    armed = true;

    const response = await request(app)
      .post("/api/permissions/confirm")
      .set("Cookie", cookie)
      .send({ previewToken: preview.body.preview.previewToken });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("installation_changed");
    expect(store.getAdminPolicy("ws-1", "admin-1")).toBeUndefined();
    expect(store.listActionOutcomes("ws-1", "admin-1")).toEqual([]);
    expect(Object.values(store.eraseWorkspace("ws-1")).every((count) => count === 0)).toBe(true);
    store.close();
  });

  it("denies a write when its session is invalidated during the forced role check", async () => {
    const keys = await testKeys();
    const config = makeTestConfig({
      clockifyAddonPublicKeyPem: keys.pem,
      clockifyAddonKey: ADDON_KEY,
      roleRecheckTtlMs: 60_000,
    });
    const store = createStore(":memory:", { encryptionKey: "test-key" });
    store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
    const fake = createFakeWorkspace();
    let forcedStarted!: () => void;
    let releaseForced!: () => void;
    const started = new Promise<void>((resolve) => { forcedStarted = resolve; });
    const forcedGate = new Promise<void>((resolve) => { releaseForced = resolve; });
    let lookups = 0;
    const clockify = {
      ...fake.client,
      async getWorkspaceMemberRole() {
        lookups += 1;
        if (lookups === 1) return "ADMIN";
        forcedStarted();
        await forcedGate;
        return "ADMIN";
      },
    };
    const app = createApp({
      config,
      store,
      parser: createSignatureParser(ADDON_KEY, keys.pem),
      modelClient,
      clockifyForWorkspace: () => clockify,
    });
    const cookie = mintAdminCookie(store, config.sessionSecret, { adminUserId: "admin-1" });
    const responsePromise = Promise.resolve(request(app)
      .post("/api/permissions/confirm")
      .set("Cookie", cookie)
      .send({ groups: { invoices: "off" } }));

    await started;
    expect(store.invalidateAdminSessions("ws-1", "admin-1")).toBe(1);
    releaseForced();
    const response = await responsePromise;

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("admin_required");
    expect(store.getAdminPolicy("ws-1", "admin-1")).toBeUndefined();
    store.close();
  });

  it("denies a demoted admin with 403 {forbidden}", async () => {
    const { app, cookie } = await buildApp(true, "MEMBER"); // demoted in Clockify
    const res = await request(app).get("/api/me").set("Cookie", cookie);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("forbidden");
  });

  it("admits a current admin with 200", async () => {
    const { app, cookie } = await buildApp(true, "ADMIN");
    const res = await request(app).get("/api/me").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("ignores the legacy ROLE_RECHECK toggle and still denies a demoted admin", async () => {
    const { app, cookie } = await buildApp(false, "MEMBER");
    const res = await request(app).get("/api/me").set("Cookie", cookie);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("forbidden");
  });

  it("fails authenticated reads closed when Clockify cannot verify the role", async () => {
    const { app, cookie } = await buildApp(false, "ADMIN", true);
    for (const path of ["/api/me", "/api/permissions", "/api/metrics", "/api/chat/history", "/api/chat/sessions"]) {
      const response = await request(app).get(path).set("Cookie", cookie);
      expect(response.status, path).toBe(503);
      expect(response.body.code, path).toBe("role_verification_unavailable");
    }
  });

  it("always rechecks immediately before a write and invalidates a demoted admin's sessions", async () => {
    const { app, cookie } = await buildApp(false, "MEMBER");
    const denied = await request(app)
      .post("/api/permissions/confirm")
      .set("Cookie", cookie)
      .send({ groups: { invoices: "off" } });

    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("forbidden");
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
