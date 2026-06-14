import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { testing } from "@apet97/clockify-addon-sdk";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser, ClockifyHeaders } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import type { AppConfig } from "../../src/config.js";
import type { ModelClient } from "../../src/assistant/model-client.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";

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
  return testing.signTestToken(keys.privateKey, ADDON_KEY, claims);
}

beforeAll(async () => {
  keys = await testing.generateTestKeys();
  const config: AppConfig = {
    nodeEnv: "test",
    port: 3998,
    baseUrl: "https://example.com/ai-assistant",
    clockifyAddonPublicKeyPem: keys.pem,
    clockifyAddonKey: ADDON_KEY,
    sessionSecret: "test-session-secret",
    databasePath: ":memory:",
    llmBaseUrl: "https://llm.example.com",
    llmApiKey: "llm-key",
    llmModel: "cheap-model",
    llmProvider: "http",
  };
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
  });

  it("rejects an unsigned/invalid lifecycle token with 401", async () => {
    const res = await request(app)
      .post("/lifecycle/installed")
      .set(LIFECYCLE_HEADER, "not-a-real-jwt")
      .send({ workspaceId: "ws-x", addonId: "a", authToken: "t" });
    expect(res.status).toBe(401);
    expect(store.getInstallation("ws-x")).toBeUndefined();
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
  it("erases the workspace's data and tombstones the token on a valid uninstall", async () => {
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
    const inst = store.getInstallation("ws-erase");
    expect(inst?.status).toBe("deleted");
    expect(inst?.addonToken).toBe(""); // token wiped on uninstall
    expect(store.getRecentMessages(session.id, 10)).toHaveLength(0); // data erased
  });

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
