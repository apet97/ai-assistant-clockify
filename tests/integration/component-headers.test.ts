import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { testing } from "@apet97/clockify-addon-sdk";
import { testKeys } from "../helpers/test-keys.js";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { makeTestConfig } from "../helpers/config.js";
import type { ModelClient } from "../../src/assistant/model-client.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { Express } from "express";

const ADDON_KEY = "ai-assistant";

let keys: { privateKey: unknown; pem: string };
let store: Store;
let app: Express;
let fake: FakeWorkspace;

const modelClient: ModelClient = {
  async complete() {
    return JSON.stringify({ kind: "answer", text: "Hello, admin." });
  },
};

beforeAll(async () => {
  keys = await testKeys();
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
  const parser = createSignatureParser(ADDON_KEY, keys.pem);
  fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Acme" }] });
  app = createApp({
    config,
    store,
    parser,
    modelClient,
    clockifyForWorkspace: () => fake.client,
  });
});

afterAll(() => store.close());

describe("component HTML security headers (injection/clickjacking backstop)", () => {
  // The embedded chat renders attacker-influenced workspace data (project/client
  // names, time-entry descriptions, model reply text). The HTML response must
  // carry a strict CSP + clickjacking control as defense-in-depth beyond the
  // textContent render convention. The frame-ancestors allow-list MUST include
  // the Clockify/CAKE embedding origins or the cross-site iframe breaks.
  it("serves the admin chat shell with a strict Content-Security-Policy and header backstops", async () => {
    const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: "ws-1",
      user: "admin-1",
      workspaceRole: "ADMIN",
    });
    const res = await request(app).get("/component/assistant").query({ auth_token: token });
    expect(res.status).toBe(200);

    const csp = res.headers["content-security-policy"];
    expect(csp).toBeTruthy();
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    // The embedding origins (cross-site iframe) must be explicitly allowed.
    expect(csp).toContain("frame-ancestors");
    expect(csp).toContain("clockify.me");
    expect(csp).toContain("cake.com");
    // No 'unsafe-inline' — the built shell uses external script/style only.
    expect(csp).not.toContain("unsafe-inline");

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBeTruthy();
    expect(res.headers["cache-control"]).toContain("private");
    expect(res.headers["cache-control"]).toContain("no-store");
  });

  it("sets the session cookie Max-Age to sessionTtlMs/1000 (T50: 7200 for the 2h default, not 28800)", async () => {
    const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: "ws-1",
      user: "admin-1",
      workspaceRole: "ADMIN",
    });
    const res = await request(app).get("/component/assistant").query({ auth_token: token });
    expect(res.status).toBe(200);
    const setCookie = res.headers["set-cookie"];
    const cookie = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
    expect(cookie).toContain("Max-Age=7200");
    expect(cookie).not.toContain("Max-Age=28800");
  });

  it("also sets the headers on the non-admin rejection page (no render surface left bare)", async () => {
    const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: "ws-1",
      user: "member-1",
      workspaceRole: "USER",
    });
    const res = await request(app).get("/component/assistant").query({ auth_token: token });
    expect(res.status).toBe(403);
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("rejects a stale admin JWT after live demotion, invalidates prior sessions, and mints no cookie", async () => {
    const userId = "demoted-admin";
    const priorSession = store.createSession({ workspaceId: "ws-1", adminUserId: userId });
    fake.state.memberRoles[userId] = "USER";
    const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: "ws-1",
      user: userId,
      workspaceRole: "ADMIN",
    });

    const response = await request(app).get("/component/assistant").query({ auth_token: token });

    expect(response.status).toBe(403);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(store.getSession(priorSession.id)).toBeUndefined();
  });

  it("fails closed before session creation when the current-role lookup is unavailable", async () => {
    const original = fake.client.getWorkspaceMemberRole;
    (fake.client as { getWorkspaceMemberRole: typeof original }).getWorkspaceMemberRole = async () => {
      throw new Error("role lookup unavailable");
    };
    try {
      const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
        workspaceId: "ws-1",
        user: "lookup-failure-admin",
        workspaceRole: "ADMIN",
      });
      const response = await request(app).get("/component/assistant").query({ auth_token: token });

      expect(response.status).toBe(503);
      expect(response.headers["set-cookie"]).toBeUndefined();
    } finally {
      (fake.client as { getWorkspaceMemberRole: typeof original }).getWorkspaceMemberRole = original;
    }
  });

  it("rechecks installation authority synchronously before creating a session after role I/O", async () => {
    const workspaceId = "ws-component-uninstall-race";
    store.saveInstallation({
      workspaceId,
      addonId: "addon-1",
      addonUserId: "addon-user-1",
      addonToken: "race-token",
    });
    const originalGetInstallation = store.getInstallation.bind(store);
    const originalCreateSession = store.createSession.bind(store);
    let workspaceReads = 0;
    let createCalls = 0;
    store.getInstallation = (id) => {
      if (id === workspaceId) {
        workspaceReads += 1;
        // Initial gate, post-env reload, authority load, authority final reload,
        // then the component's session-boundary reload.
        if (workspaceReads === 5) {
          const tombstone = store.tombstoneInstallation(workspaceId);
          if (tombstone) store.eraseWorkspaceForDeletion(workspaceId, tombstone.generation);
        }
      }
      return originalGetInstallation(id);
    };
    store.createSession = (input) => {
      createCalls += 1;
      return originalCreateSession(input);
    };
    try {
      const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
        workspaceId,
        user: "admin-race",
        workspaceRole: "ADMIN",
      });
      const response = await request(app).get("/component/assistant").query({ auth_token: token });

      expect(response.status).toBe(409);
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(createCalls).toBe(0);
      expect(originalGetInstallation(workspaceId)).toBeUndefined();
    } finally {
      store.getInstallation = originalGetInstallation;
      store.createSession = originalCreateSession;
    }
  });

  it("rejects a malicious signed service claim before it can be persisted", async () => {
    const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: "ws-1",
      user: "admin-1",
      workspaceRole: "ADMIN",
      backendUrl: "https://api.clockify.me.evil.example/api",
    });
    const res = await request(app).get("/component/assistant").query({ auth_token: token });
    expect(res.status).toBe(400);
    expect(res.text).not.toContain("api.clockify.me.evil.example");
  });
});
