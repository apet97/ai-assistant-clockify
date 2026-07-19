import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { testing } from "@apet97/clockify-addon-sdk";
import { SignJWT } from "jose";
import { testKeys } from "../helpers/test-keys.js";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser, ClockifyHeaders } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { makeTestConfig } from "../helpers/config.js";
import type { ModelClient } from "../../src/assistant/model-client.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import {
  createWorkspaceMutationCoordinator,
  type WorkspaceMutationCoordinator,
} from "../../src/clockify/workspace-mutation-coordinator.js";

/**
 * The INSTALLED lifecycle hook is the ONLY time Clockify hands us the
 * non-expiring installation token, so it must persist on a valid signed token.
 * Before this suite the endpoint had no coverage, and a broken/placeholder
 * verification key (or over-strict payload validation) silently 401/400'd every
 * install. These tests pin the contract end-to-end.
 */
const ADDON_KEY = "ai-assistant";
const LIFECYCLE_HEADER = ClockifyHeaders.LIFECYCLE_TOKEN;

let keys: { privateKey: unknown; pem: string };
let store: Store;
let app: Express;

const modelClient: ModelClient = {
  async complete() {
    return JSON.stringify({ kind: "answer", text: "unused" });
  },
};

async function lifecycleToken(claims: Record<string, unknown>): Promise<string> {
  return testing.signTestToken(keys.privateKey, ADDON_KEY, {
    iat: Math.floor(Date.now() / 1000),
    ...claims,
  });
}

beforeAll(async () => {
  keys = await testKeys();
  const config = makeTestConfig({
    clockifyAddonPublicKeyPem: keys.pem,
    clockifyAddonKey: ADDON_KEY,
  });
  store = createStore(":memory:", { encryptionKey: "test-key" });
  const parser = createSignatureParser(ADDON_KEY, keys.pem);
  const fake = createFakeWorkspace();
  app = createApp({
    config,
    store,
    parser,
    modelClient,
    clockifyForWorkspace: () => fake.client,
  });
});

afterAll(() => store.close());

describe("POST /lifecycle/installed", () => {
  it("persists the installation token on a valid signed token", async () => {
    const token = await lifecycleToken({
      workspaceId: "ws-install",
      addonId: "addon-install",
      backendUrl: "https://api.clockify.me",
    });
    const res = await request(app)
      .post("/lifecycle/installed")
      .set(LIFECYCLE_HEADER, token)
      .send({
        addonId: "addon-install",
        authToken: "install-token-xyz",
        workspaceId: "ws-install",
        asUser: "owner-1",
        apiUrl: "https://api.clockify.me",
        addonUserId: "addon-user-1",
        webhooks: [],
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const saved = store.getInstallation("ws-install");
    expect(saved?.addonToken).toBe("install-token-xyz");
    expect(saved?.addonId).toBe("addon-install");
    expect(saved?.addonUserId).toBe("addon-user-1");
    expect(saved?.status).toBe("active");
    expect(saved?.installedByUserId).toBe("owner-1");
    expect(saved?.backendUrl).toBe("https://api.clockify.me");
    expect(saved?.generation).toBe(1);
  });

  it("increments the authority generation when Clockify replaces the install token", async () => {
    const workspaceId = "ws-reinstall-generation";
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (const [index, authToken] of ["token-one", "token-two"].entries()) {
      const token = await lifecycleToken({
        workspaceId,
        addonId: "addon-install",
        iat: nowSeconds + index,
      });
      const response = await request(app)
        .post("/lifecycle/installed")
        .set(LIFECYCLE_HEADER, token)
        .send({ workspaceId, addonId: "addon-install", authToken });
      expect(response.status).toBe(200);
    }
    expect(store.getInstallation(workspaceId)).toMatchObject({
      addonToken: "token-two",
      generation: 2,
      status: "active",
    });
  });

  it("ignores an unseen older installation callback that physically arrives after a newer install", async () => {
    const workspaceId = "ws-unseen-old-install-replay";
    const nowSeconds = Math.floor(Date.now() / 1000);
    const newer = await lifecycleToken({ workspaceId, addonId: "addon-install", iat: nowSeconds });
    const older = await lifecycleToken({ workspaceId, addonId: "addon-install", iat: nowSeconds - 60 });

    expect((await request(app)
      .post("/lifecycle/installed")
      .set(LIFECYCLE_HEADER, newer)
      .send({ workspaceId, authToken: "newer-authority-token" })).status).toBe(200);
    expect((await request(app)
      .post("/lifecycle/installed")
      .set(LIFECYCLE_HEADER, older)
      .send({ workspaceId, authToken: "never-before-observed-old-token" })).status).toBe(200);

    expect(store.getInstallation(workspaceId)).toMatchObject({
      addonToken: "newer-authority-token",
      generation: 1,
      lifecycleIssuedAt: nowSeconds,
      status: "active",
    });
  });

  it("rejects a lifecycle body service URL that disagrees with the signed URL claim", async () => {
    const token = await lifecycleToken({
      workspaceId: "ws-origin-mismatch",
      addonId: "addon-install",
      backendUrl: "https://api.clockify.me/api",
    });
    const res = await request(app)
      .post("/lifecycle/installed")
      .set(LIFECYCLE_HEADER, token)
      .send({
        authToken: "install-token-xyz",
        workspaceId: "ws-origin-mismatch",
        apiUrl: "https://developer.clockify.me/api",
      });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("service_origin_mismatch");
    expect(store.getInstallation("ws-origin-mismatch")).toBeUndefined();
  });

  it.each([
    "http://api.clockify.me/api",
    "https://api.clockify.me.evil.example/api",
    "https://127.0.0.1/api",
    "https://api.clockify.me/admin",
  ])("rejects a malicious installation service URL before persistence: %s", async (apiUrl) => {
    const token = await lifecycleToken({ workspaceId: `ws-malicious-${Buffer.from(apiUrl).toString("hex").slice(0, 8)}` });
    const workspaceId = `ws-malicious-${Buffer.from(apiUrl).toString("hex").slice(0, 8)}`;
    const res = await request(app)
      .post("/lifecycle/installed")
      .set(LIFECYCLE_HEADER, token)
      .send({ authToken: "install-token-xyz", workspaceId, apiUrl });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_service_origin");
    expect(store.getInstallation(workspaceId)).toBeUndefined();
  });

  it("rejects an unsigned/invalid lifecycle token with 401", async () => {
    const res = await request(app)
      .post("/lifecycle/installed")
      .set(LIFECYCLE_HEADER, "not-a-real-jwt")
      .send({ workspaceId: "ws-x", addonId: "a", authToken: "t" });
    expect(res.status).toBe(401);
    expect(store.getInstallation("ws-x")).toBeUndefined();
  });

  it("rejects lifecycle JWTs missing exp or iat, and an iat materially in the future", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const missingExp = await new SignJWT({
      type: "addon",
      workspaceId: "ws-missing-exp",
      iat: nowSeconds,
    })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("clockify")
      .setSubject(ADDON_KEY)
      .sign(keys.privateKey as never);
    const missingIat = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: "ws-missing-iat",
    });
    const futureIat = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: "ws-future-iat",
      iat: nowSeconds + 120,
    });

    for (const [workspaceId, token] of [
      ["ws-missing-exp", missingExp],
      ["ws-missing-iat", missingIat],
      ["ws-future-iat", futureIat],
    ] as const) {
      const response = await request(app)
        .post("/lifecycle/installed")
        .set(LIFECYCLE_HEADER, token)
        .send({ workspaceId, authToken: "must-not-persist" });
      expect(response.status).toBe(401);
      expect(store.getInstallation(workspaceId)).toBeUndefined();
    }
  });

  it("uses the injected application clock for lifecycle freshness boundaries", async () => {
    const workspaceId = "ws-injected-lifecycle-clock";
    const eventIat = Math.floor(Date.now() / 1000) + 300;
    const fixedNow = new Date(eventIat * 1000);
    const isolatedStore = createStore(":memory:", { encryptionKey: "test-key" });
    const parser = createSignatureParser(ADDON_KEY, keys.pem);
    const fake = createFakeWorkspace();
    const isolatedApp = createApp({
      config: makeTestConfig({
        clockifyAddonPublicKeyPem: keys.pem,
        clockifyAddonKey: ADDON_KEY,
      }),
      store: isolatedStore,
      parser,
      modelClient,
      clockifyForWorkspace: () => fake.client,
      now: () => fixedNow,
    });
    const token = await lifecycleToken({ workspaceId, iat: eventIat });

    try {
      const response = await request(isolatedApp)
        .post("/lifecycle/installed")
        .set(LIFECYCLE_HEADER, token)
        .send({ workspaceId, authToken: "clock-bound-install-token" });

      expect(response.status).toBe(200);
      expect(isolatedStore.getInstallation(workspaceId)?.lifecycleIssuedAt).toBe(eventIat);
    } finally {
      isolatedStore.close();
    }
  });

  it("rejects when the signed token header is absent with 401", async () => {
    const res = await request(app)
      .post("/lifecycle/installed")
      .send({ workspaceId: "ws-y", addonId: "a", authToken: "t" });
    expect(res.status).toBe(401);
    expect(store.getInstallation("ws-y")).toBeUndefined();
  });

  it("returns 400 when the installation token is missing from the payload", async () => {
    const token = await lifecycleToken({ workspaceId: "ws-noauth", addonId: "a" });
    const res = await request(app)
      .post("/lifecycle/installed")
      .set(LIFECYCLE_HEADER, token)
      .send({ workspaceId: "ws-noauth", addonId: "a" });
    expect(res.status).toBe(400);
    expect(store.getInstallation("ws-noauth")).toBeUndefined();
  });

  it("still installs when optional metadata (addonUserId) is absent", async () => {
    const token = await lifecycleToken({
      workspaceId: "ws-minimal",
      addonId: "addon-minimal",
    });
    const res = await request(app)
      .post("/lifecycle/installed")
      .set(LIFECYCLE_HEADER, token)
      .send({ authToken: "minimal-token" });

    expect(res.status).toBe(200);
    const saved = store.getInstallation("ws-minimal");
    expect(saved?.addonToken).toBe("minimal-token");
    // workspaceId and addonId fall back to the verified token claims.
    expect(saved?.addonId).toBe("addon-minimal");
    expect(saved?.addonUserId).toBe("");
  });

  it("rejects a token signed for workspace A that targets a different workspace B", async () => {
    // Pre-existing legitimate install for the VICTIM workspace.
    store.saveInstallation({
      workspaceId: "ws-victim-install",
      addonId: "addon-victim",
      addonUserId: "victim-user",
      addonToken: "victim-real-token",
      apiUrl: "https://victim.api.clockify.me",
      backendUrl: "https://victim.api.clockify.me",
      status: "active",
      installedByUserId: "victim-owner",
    });

    // Attacker holds a VALID lifecycle token, but signed for THEIR workspace.
    const token = await lifecycleToken({
      workspaceId: "ws-attacker",
      addonId: "addon-attacker",
    });
    const res = await request(app)
      .post("/lifecycle/installed")
      .set(LIFECYCLE_HEADER, token)
      .send({
        workspaceId: "ws-victim-install",
        authToken: "attacker-evil-token",
        apiUrl: "https://attacker.api.example.com",
      });

    // Must NOT overwrite the victim's encrypted install token / host.
    expect(res.status).toBe(403);
    const victim = store.getInstallation("ws-victim-install");
    expect(victim?.addonToken).toBe("victim-real-token");
    expect(victim?.apiUrl).toBe("https://victim.api.clockify.me");
  });
});

describe("POST /lifecycle/deleted", () => {
  it("does not let an unseen older install resurrect an erased workspace", async () => {
    const workspaceId = "ws-erased-lineage-same-process";
    const nowSeconds = Math.floor(Date.now() / 1000);
    const installed = await lifecycleToken({ workspaceId, iat: nowSeconds });
    const deleted = await lifecycleToken({ workspaceId, iat: nowSeconds + 10 });
    const unseenOlderInstall = await lifecycleToken({ workspaceId, iat: nowSeconds - 60 });

    expect((await request(app)
      .post("/lifecycle/installed")
      .set(LIFECYCLE_HEADER, installed)
      .send({ workspaceId, authToken: "new-authority-token" })).status).toBe(200);
    expect((await request(app)
      .post("/lifecycle/deleted")
      .set(LIFECYCLE_HEADER, deleted)
      .send({ workspaceId })).status).toBe(200);
    expect(store.getInstallation(workspaceId)).toBeUndefined();

    expect((await request(app)
      .post("/lifecycle/installed")
      .set(LIFECYCLE_HEADER, unseenOlderInstall)
      .send({ workspaceId, authToken: "never-before-seen-old-token" })).status).toBe(200);
    expect(store.getInstallation(workspaceId)).toBeUndefined();
  });

  it("retains erased lifecycle lineage across database reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aiassist-lifecycle-lineage-"));
    const databasePath = join(directory, "lineage.sqlite");
    const workspaceId = "ws-erased-lineage-reopen";
    const nowSeconds = Math.floor(Date.now() / 1000);
    const installed = await lifecycleToken({ workspaceId, iat: nowSeconds });
    const deleted = await lifecycleToken({ workspaceId, iat: nowSeconds + 10 });
    const unseenOlderInstall = await lifecycleToken({ workspaceId, iat: nowSeconds - 60 });
    const parser = createSignatureParser(ADDON_KEY, keys.pem);
    const fake = createFakeWorkspace();
    const createPersistentApp = (persistentStore: Store): Express => createApp({
      config: makeTestConfig({ clockifyAddonPublicKeyPem: keys.pem, clockifyAddonKey: ADDON_KEY }),
      store: persistentStore,
      parser,
      modelClient,
      clockifyForWorkspace: () => fake.client,
    });

    let persistentStore = createStore(databasePath, { encryptionKey: "test-key" });
    try {
      let persistentApp = createPersistentApp(persistentStore);
      expect((await request(persistentApp)
        .post("/lifecycle/installed")
        .set(LIFECYCLE_HEADER, installed)
        .send({ workspaceId, authToken: "new-authority-token" })).status).toBe(200);
      expect((await request(persistentApp)
        .post("/lifecycle/deleted")
        .set(LIFECYCLE_HEADER, deleted)
        .send({ workspaceId })).status).toBe(200);
      persistentStore.close();

      persistentStore = createStore(databasePath, { encryptionKey: "test-key" });
      persistentApp = createPersistentApp(persistentStore);
      expect((await request(persistentApp)
        .post("/lifecycle/installed")
        .set(LIFECYCLE_HEADER, unseenOlderInstall)
        .send({ workspaceId, authToken: "never-before-seen-old-token" })).status).toBe(200);
      expect(persistentStore.getInstallation(workspaceId)).toBeUndefined();
    } finally {
      persistentStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("hard-deletes the workspace's data and installation metadata on a valid uninstall", async () => {
    store.saveInstallation({
      workspaceId: "ws-erase",
      addonId: "addon-erase",
      addonUserId: "u",
      addonToken: "erase-real-token",
      status: "active",
    });
    const session = store.createSession({ workspaceId: "ws-erase", adminUserId: "admin-1" });
    store.addMessage({ sessionId: session.id, workspaceId: "ws-erase", adminUserId: "admin-1", role: "user", content: "hi" });

    const token = await lifecycleToken({ workspaceId: "ws-erase", addonId: "addon-erase" });
    const res = await request(app)
      .post("/lifecycle/deleted")
      .set(LIFECYCLE_HEADER, token)
      .send({ workspaceId: "ws-erase" });

    expect(res.status).toBe(200);
    expect(store.getInstallation("ws-erase")).toBeUndefined();
    expect(store.getRecentMessages(session.id, 10)).toHaveLength(0); // data erased
  });

  it("wipes the token immediately, then waits for mutation settlement before erasing", async () => {
    const workspaceId = "ws-drain-uninstall";
    const isolatedStore = createStore(":memory:", { encryptionKey: "test-key" });
    isolatedStore.saveInstallation({
      workspaceId,
      addonId: "addon-drain",
      addonUserId: "u",
      addonToken: "must-disappear-immediately",
    });
    const coordinator = createWorkspaceMutationCoordinator();
    coordinator.activate(workspaceId, 1);
    const inFlight = coordinator.acquire(workspaceId, 1);
    let tombstoned!: () => void;
    const tombstoneReached = new Promise<void>((resolve) => { tombstoned = resolve; });
    const wrappedStore: Store = {
      ...isolatedStore,
      tombstoneInstallationForLifecycle(id, lifecycleIssuedAt) {
        const result = isolatedStore.tombstoneInstallationForLifecycle(id, lifecycleIssuedAt);
        tombstoned();
        return result;
      },
    };
    const parser = createSignatureParser(ADDON_KEY, keys.pem);
    const fake = createFakeWorkspace();
    const isolatedApp = createApp({
      config: makeTestConfig({ clockifyAddonPublicKeyPem: keys.pem, clockifyAddonKey: ADDON_KEY }),
      store: wrappedStore,
      parser,
      modelClient,
      clockifyForWorkspace: () => fake.client,
      mutationCoordinator: coordinator,
    });
    const token = await lifecycleToken({ workspaceId, addonId: "addon-drain" });
    const responsePromise = request(isolatedApp)
      .post("/lifecycle/deleted")
      .set(LIFECYCLE_HEADER, token)
      .send({ workspaceId })
      .then((response) => response);

    await tombstoneReached;
    expect(isolatedStore.getInstallation(workspaceId)).toMatchObject({
      status: "deleted",
      addonToken: "",
      generation: 2,
    });

    inFlight.release();
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(isolatedStore.getInstallation(workspaceId)).toBeUndefined();
    isolatedStore.close();
  });

  it("finishes the old generation's erase before accepting a concurrent reinstall", async () => {
    const workspaceId = "ws-delete-reinstall-race";
    const isolatedStore = createStore(":memory:", { encryptionKey: "test-key" });
    isolatedStore.saveInstallation({
      workspaceId,
      addonId: "addon-race",
      addonUserId: "addon-user-old",
      addonToken: "old-token",
    });
    const oldSession = isolatedStore.createSession({
      workspaceId,
      adminUserId: "admin-old",
    });
    isolatedStore.addMessage({
      sessionId: oldSession.id,
      workspaceId,
      adminUserId: "admin-old",
      role: "user",
      content: "old generation data",
    });

    const baseCoordinator = createWorkspaceMutationCoordinator();
    baseCoordinator.activate(workspaceId, 1);
    const inFlight = baseCoordinator.acquire(workspaceId, 1);
    let installQueued!: () => void;
    const installWaiting = new Promise<void>((resolve) => { installQueued = resolve; });
    let lifecycleCalls = 0;
    const coordinator: WorkspaceMutationCoordinator = {
      ...baseCoordinator,
      runLifecycle<T>(
        id: string,
        operation: () => Promise<T>,
        ordering?: { sequence: number; stale: () => Promise<T> | T },
      ): Promise<T> {
        lifecycleCalls += 1;
        if (lifecycleCalls === 2) installQueued();
        return baseCoordinator.runLifecycle(id, operation, ordering);
      },
    };
    let tombstoneReached!: () => void;
    const tombstoned = new Promise<void>((resolve) => { tombstoneReached = resolve; });
    let erasedGeneration: number | undefined;
    const wrappedStore: Store = {
      ...isolatedStore,
      tombstoneInstallationForLifecycle(id, lifecycleIssuedAt) {
        const result = isolatedStore.tombstoneInstallationForLifecycle(id, lifecycleIssuedAt);
        tombstoneReached();
        return result;
      },
      eraseWorkspaceForDeletion(id, generation) {
        erasedGeneration = generation;
        return isolatedStore.eraseWorkspaceForDeletion(id, generation);
      },
    };
    const parser = createSignatureParser(ADDON_KEY, keys.pem);
    const fake = createFakeWorkspace();
    const isolatedApp = createApp({
      config: makeTestConfig({ clockifyAddonPublicKeyPem: keys.pem, clockifyAddonKey: ADDON_KEY }),
      store: wrappedStore,
      parser,
      modelClient,
      clockifyForWorkspace: () => fake.client,
      mutationCoordinator: coordinator,
    });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const deleteToken = await lifecycleToken({
      workspaceId,
      addonId: "addon-race",
      iat: nowSeconds,
    });
    const installToken = await lifecycleToken({
      workspaceId,
      addonId: "addon-race",
      iat: nowSeconds + 1,
    });

    const deletionResponse = request(isolatedApp)
      .post("/lifecycle/deleted")
      .set(LIFECYCLE_HEADER, deleteToken)
      .send({ workspaceId })
      .then((response) => response);
    await tombstoned;

    let installationSettled = false;
    const installationResponse = request(isolatedApp)
      .post("/lifecycle/installed")
      .set(LIFECYCLE_HEADER, installToken)
      .send({
        workspaceId,
        addonId: "addon-race",
        addonUserId: "addon-user-new",
        authToken: "replacement-token",
      })
      .then((response) => {
        installationSettled = true;
        return response;
      });
    await installWaiting;

    expect(installationSettled).toBe(false);
    expect(isolatedStore.getInstallation(workspaceId)).toMatchObject({
      status: "deleted",
      addonToken: "",
      generation: 2,
    });

    inFlight.release();
    expect((await deletionResponse).status).toBe(200);
    expect((await installationResponse).status).toBe(200);
    expect(erasedGeneration).toBe(2);
    expect(isolatedStore.getSession(oldSession.id)).toBeUndefined();
    expect(isolatedStore.getInstallation(workspaceId)).toMatchObject({
      status: "active",
      addonToken: "replacement-token",
      addonUserId: "addon-user-new",
      generation: 3,
    });
    isolatedStore.close();
  });

  it("ignores an older uninstall whose token verification finishes after a newer install", async () => {
    const workspaceId = "ws-delete-verification-race";
    const isolatedStore = createStore(":memory:", { encryptionKey: "test-key" });
    isolatedStore.saveInstallation({
      workspaceId,
      addonId: "addon-race",
      addonUserId: "addon-user-old",
      addonToken: "old-token",
    });
    const deleteToken = await lifecycleToken({ workspaceId, addonId: "addon-race", event: "delete" });
    const installToken = await lifecycleToken({ workspaceId, addonId: "addon-race", event: "install" });
    const baseParser = createSignatureParser(ADDON_KEY, keys.pem);
    let releaseDeleteVerification!: () => void;
    const deleteVerificationGate = new Promise<void>((resolve) => { releaseDeleteVerification = resolve; });
    let markDeleteVerificationStarted!: () => void;
    const deleteVerificationStarted = new Promise<void>((resolve) => { markDeleteVerificationStarted = resolve; });
    const delayedParser = {
      async parseClaims(token: string) {
        if (token === deleteToken) {
          markDeleteVerificationStarted();
          await deleteVerificationGate;
        }
        return baseParser.parseClaims(token);
      },
    } as unknown as typeof baseParser;
    const fake = createFakeWorkspace();
    const isolatedApp = createApp({
      config: makeTestConfig({ clockifyAddonPublicKeyPem: keys.pem, clockifyAddonKey: ADDON_KEY }),
      store: isolatedStore,
      parser: delayedParser,
      modelClient,
      clockifyForWorkspace: () => fake.client,
      mutationCoordinator: createWorkspaceMutationCoordinator(),
    });

    const deletionResponse = request(isolatedApp)
      .post("/lifecycle/deleted")
      .set(LIFECYCLE_HEADER, deleteToken)
      .send({ workspaceId })
      .then((response) => response);
    await deleteVerificationStarted;

    const installationResponse = await request(isolatedApp)
      .post("/lifecycle/installed")
      .set(LIFECYCLE_HEADER, installToken)
      .send({
        workspaceId,
        addonId: "addon-race",
        addonUserId: "addon-user-new",
        authToken: "replacement-token",
      });
    expect(installationResponse.status).toBe(200);
    expect(isolatedStore.getInstallation(workspaceId)).toMatchObject({
      addonToken: "replacement-token",
      generation: 2,
      status: "active",
    });

    releaseDeleteVerification();
    expect((await deletionResponse).status).toBe(200);
    expect(isolatedStore.getInstallation(workspaceId)).toMatchObject({
      addonToken: "replacement-token",
      generation: 2,
      status: "active",
    });
    isolatedStore.close();
  });

  it.each(["deleted", "inactive"] as const)(
    "ignores a signed old %s event that arrives after a newer installation generation",
    async (event) => {
      const workspaceId = `ws-old-${event}-after-reinstall`;
      const nowSeconds = Math.floor(Date.now() / 1000);
      const oldInstallToken = await lifecycleToken({
        workspaceId,
        addonId: "addon-generation-order",
        iat: nowSeconds - 120,
      });
      const newInstallToken = await lifecycleToken({
        workspaceId,
        addonId: "addon-generation-order",
        iat: nowSeconds,
      });
      const staleEventToken = await lifecycleToken({
        workspaceId,
        addonId: "addon-generation-order",
        iat: nowSeconds - 60,
      });

      expect((await request(app)
        .post("/lifecycle/installed")
        .set(LIFECYCLE_HEADER, oldInstallToken)
        .send({ workspaceId, authToken: `old-${event}-token` })).status).toBe(200);
      expect((await request(app)
        .post("/lifecycle/installed")
        .set(LIFECYCLE_HEADER, newInstallToken)
        .send({ workspaceId, authToken: `new-${event}-token` })).status).toBe(200);

      const response = await request(app)
        .post(event === "deleted" ? "/lifecycle/deleted" : "/lifecycle/status-changed")
        .set(LIFECYCLE_HEADER, staleEventToken)
        .send({ workspaceId, ...(event === "inactive" ? { status: "INACTIVE" } : {}) });

      expect(response.status).toBe(200);
      expect(store.getInstallation(workspaceId)).toMatchObject({
        addonToken: `new-${event}-token`,
        generation: 2,
        status: "active",
      });
    },
  );

  it("rejects a token signed for workspace A that disables a different workspace B (cross-tenant DoS)", async () => {
    store.saveInstallation({
      workspaceId: "ws-victim-delete",
      addonId: "addon-victim",
      addonUserId: "victim-user",
      addonToken: "victim-token",
      apiUrl: "https://victim.api.clockify.me",
      backendUrl: "https://victim.api.clockify.me",
      status: "active",
      installedByUserId: "victim-owner",
    });

    const token = await lifecycleToken({
      workspaceId: "ws-attacker",
      addonId: "addon-attacker",
    });
    const res = await request(app)
      .post("/lifecycle/deleted")
      .set(LIFECYCLE_HEADER, token)
      .send({ workspaceId: "ws-victim-delete" });

    expect(res.status).toBe(403);
    // Victim install stays active; it must NOT be flipped to "deleted".
    expect(store.getInstallation("ws-victim-delete")?.status).toBe("active");
  });
});

describe("POST /lifecycle/status-changed", () => {
  it.each([
    ["older", -30],
    ["equal", 0],
    ["later", 30],
  ] as const)(
    "keeps an exact-token %s INSTALLED retry authority-neutral after INACTIVE",
    async (label, retryOffset) => {
      const workspaceId = `ws-inactive-same-token-${label}`;
      const nowSeconds = Math.floor(Date.now() / 1000);
      const installed = await lifecycleToken({ workspaceId, iat: nowSeconds - 60 });
      const inactiveIat = nowSeconds;
      const inactive = await lifecycleToken({ workspaceId, iat: inactiveIat });
      const retriedInstall = await lifecycleToken({
        workspaceId,
        iat: inactiveIat + retryOffset,
      });

      expect((await request(app)
        .post("/lifecycle/installed")
        .set(LIFECYCLE_HEADER, installed)
        .send({ workspaceId, authToken: "same-install-token" })).status).toBe(200);
      expect((await request(app)
        .post("/lifecycle/status-changed")
        .set(LIFECYCLE_HEADER, inactive)
        .send({ workspaceId, status: "INACTIVE" })).status).toBe(200);
      expect((await request(app)
        .post("/lifecycle/installed")
        .set(LIFECYCLE_HEADER, retriedInstall)
        .send({ workspaceId, authToken: "same-install-token" })).status).toBe(200);

      expect(store.getInstallation(workspaceId)).toMatchObject({
        addonToken: "same-install-token",
        generation: 1,
        lifecycleIssuedAt: inactiveIat,
        status: "inactive",
      });
    },
  );

  it("requires a different-token install after INACTIVE to have a strictly newer iat", async () => {
    const workspaceId = "ws-inactive-replacement-order";
    const nowSeconds = Math.floor(Date.now() / 1000);
    const installed = await lifecycleToken({ workspaceId, iat: nowSeconds - 60 });
    const inactive = await lifecycleToken({ workspaceId, iat: nowSeconds });
    const equalReplacement = await lifecycleToken({ workspaceId, iat: nowSeconds });
    const newerReplacement = await lifecycleToken({ workspaceId, iat: nowSeconds + 1 });

    await request(app).post("/lifecycle/installed").set(LIFECYCLE_HEADER, installed)
      .send({ workspaceId, authToken: "first-token" });
    await request(app).post("/lifecycle/status-changed").set(LIFECYCLE_HEADER, inactive)
      .send({ workspaceId, status: "INACTIVE" });
    await request(app).post("/lifecycle/installed").set(LIFECYCLE_HEADER, equalReplacement)
      .send({ workspaceId, authToken: "equal-second-replacement" });
    expect(store.getInstallation(workspaceId)).toMatchObject({
      addonToken: "first-token",
      generation: 1,
      status: "inactive",
    });

    await request(app).post("/lifecycle/installed").set(LIFECYCLE_HEADER, newerReplacement)
      .send({ workspaceId, authToken: "strictly-newer-replacement" });
    expect(store.getInstallation(workspaceId)).toMatchObject({
      addonToken: "strictly-newer-replacement",
      generation: 2,
      status: "active",
    });
  });

  it("keeps INACTIVE authoritative over an equal-iat STATUS ACTIVE callback", async () => {
    const workspaceId = "ws-inactive-equal-active-status";
    const nowSeconds = Math.floor(Date.now() / 1000);
    const installed = await lifecycleToken({ workspaceId, iat: nowSeconds - 60 });
    const inactive = await lifecycleToken({ workspaceId, iat: nowSeconds });
    const equalActive = await lifecycleToken({ workspaceId, iat: nowSeconds });
    const newerActive = await lifecycleToken({ workspaceId, iat: nowSeconds + 1 });

    await request(app).post("/lifecycle/installed").set(LIFECYCLE_HEADER, installed)
      .send({ workspaceId, authToken: "status-order-token" });
    await request(app).post("/lifecycle/status-changed").set(LIFECYCLE_HEADER, inactive)
      .send({ workspaceId, status: "INACTIVE" });
    await request(app).post("/lifecycle/status-changed").set(LIFECYCLE_HEADER, equalActive)
      .send({ workspaceId, status: "ACTIVE" });
    expect(store.getInstallation(workspaceId)).toMatchObject({
      generation: 1,
      lifecycleIssuedAt: nowSeconds,
      status: "inactive",
    });

    await request(app).post("/lifecycle/status-changed").set(LIFECYCLE_HEADER, newerActive)
      .send({ workspaceId, status: "ACTIVE" });
    expect(store.getInstallation(workspaceId)).toMatchObject({
      generation: 2,
      lifecycleIssuedAt: nowSeconds + 1,
      status: "active",
    });
  });

  it("does not let ACTIVE resurrect a tokenless deletion tombstone", async () => {
    const workspaceId = "ws-deleted-status-route";
    store.saveInstallation({
      workspaceId,
      addonId: "addon-status",
      addonUserId: "addon-user",
      addonToken: "must-stay-wiped",
    });
    const tombstone = store.tombstoneInstallation(workspaceId);
    const token = await lifecycleToken({ workspaceId, addonId: "addon-status" });

    const res = await request(app)
      .post("/lifecycle/status-changed")
      .set(LIFECYCLE_HEADER, token)
      .send({ workspaceId, status: "ACTIVE" });

    expect(res.status).toBe(200);
    expect(store.getInstallation(workspaceId)).toMatchObject({
      status: "deleted",
      addonToken: "",
      generation: tombstone?.generation,
    });
  });

  it("rejects a token signed for workspace A that flips a different workspace B's status", async () => {
    store.saveInstallation({
      workspaceId: "ws-victim-status",
      addonId: "addon-victim",
      addonUserId: "victim-user",
      addonToken: "victim-token",
      apiUrl: "https://victim.api.clockify.me",
      backendUrl: "https://victim.api.clockify.me",
      status: "active",
      installedByUserId: "victim-owner",
    });

    const token = await lifecycleToken({
      workspaceId: "ws-attacker",
      addonId: "addon-attacker",
    });
    const res = await request(app)
      .post("/lifecycle/status-changed")
      .set(LIFECYCLE_HEADER, token)
      .send({ workspaceId: "ws-victim-status", status: "INACTIVE" });

    expect(res.status).toBe(403);
    expect(store.getInstallation("ws-victim-status")?.status).toBe("active");
  });
});

describe("lifecycle workspace binding: an absent workspaceId claim must NEVER fall back to the attacker-controlled body", () => {
  // The mismatch tests above cover claim-PRESENT-but-different (403). This is the
  // claim-ABSENT hole: ClockifyAddonClaims.workspaceId is OPTIONAL, so the parser
  // accepts a validly-signed token with no workspace claim. resolveWorkspaceId
  // must bind to the verified claim ONLY — never the body — or a token with no
  // workspace claim could erase / hijack a victim named only in the body.
  it("/lifecycle/deleted with NO workspaceId claim does not erase a victim named only in the body", async () => {
    store.saveInstallation({
      workspaceId: "ws-victim-noclaim-del",
      addonId: "addon-victim",
      addonUserId: "victim-user",
      addonToken: "victim-token-del",
      status: "active",
    });
    const sess = store.createSession({ workspaceId: "ws-victim-noclaim-del", adminUserId: "admin-1" });
    store.addMessage({ sessionId: sess.id, workspaceId: "ws-victim-noclaim-del", adminUserId: "admin-1", role: "user", content: "secret" });

    const token = await lifecycleToken({ addonId: "addon-attacker" }); // NO workspaceId / activeWs
    const res = await request(app)
      .post("/lifecycle/deleted")
      .set(LIFECYCLE_HEADER, token)
      .send({ workspaceId: "ws-victim-noclaim-del" });

    expect(res.status).not.toBe(200);
    const inst = store.getInstallation("ws-victim-noclaim-del");
    expect(inst?.status).toBe("active"); // NOT erased
    expect(inst?.addonToken).toBe("victim-token-del"); // token intact
    expect(store.getRecentMessages(sess.id, 10)).toHaveLength(1); // data intact
  });

  it("/lifecycle/installed with NO workspaceId claim does not overwrite a victim's install token named only in the body", async () => {
    store.saveInstallation({
      workspaceId: "ws-victim-noclaim-inst",
      addonId: "addon-victim",
      addonUserId: "victim-user",
      addonToken: "victim-real-token",
      status: "active",
    });
    const token = await lifecycleToken({ addonId: "addon-attacker" }); // NO workspaceId / activeWs
    const res = await request(app)
      .post("/lifecycle/installed")
      .set(LIFECYCLE_HEADER, token)
      .send({ workspaceId: "ws-victim-noclaim-inst", authToken: "attacker-token" });

    expect(res.status).not.toBe(200);
    // The victim's stored install token must NOT be overwritten with the attacker's.
    expect(store.getInstallation("ws-victim-noclaim-inst")?.addonToken).toBe("victim-real-token");
  });

  it("accepts a legacy token that carries the workspace as `activeWs` (claim-sourced, normalized to workspaceId)", async () => {
    const token = await lifecycleToken({ activeWs: "ws-legacy-activews", addonId: "addon-legacy" });
    const res = await request(app)
      .post("/lifecycle/installed")
      .set(LIFECYCLE_HEADER, token)
      .send({ authToken: "legacy-install-token" }); // body carries NO workspaceId

    expect(res.status).toBe(200);
    // Resolved from the claim's activeWs, not the body.
    expect(store.getInstallation("ws-legacy-activews")?.status).toBe("active");
  });
});
