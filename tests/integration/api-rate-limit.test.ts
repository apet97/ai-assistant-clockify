import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createStore, type Store } from "../../src/db/store.js";
import { signSessionCookie } from "../../src/auth/sessions.js";
import { buildSessionCookie } from "../../src/routes/deps.js";
import { makeTestConfig } from "../helpers/config.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { scriptedToolModel } from "../helpers/scripted-model.js";

const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function setup(max: number): { app: Express; store: Store; secret: string } {
  const store = createStore(":memory:", { encryptionKey: "test-key" });
  stores.push(store);
  store.saveInstallation({
    workspaceId: "ws-1",
    addonId: "addon-1",
    addonUserId: "addon-user-1",
    addonToken: "addon-token",
  });
  const config = makeTestConfig({
    apiRateLimitMax: max,
    apiRateLimitWindowMs: 60_000,
  });
  const fake = createFakeWorkspace({
    memberRoles: { "admin-1": "ADMIN", "admin-2": "ADMIN" },
  });
  const app = createApp({
    config,
    store,
    parser: {} as never,
    modelClient: scriptedToolModel([{ text: "Hello, admin.", toolCalls: [] }]),
    clockifyForWorkspace: () => fake.client,
  });
  return { app, store, secret: config.sessionSecret };
}

function ownedSession(store: Store, secret: string, adminUserId: string): string {
  const session = store.createSession({ workspaceId: "ws-1", adminUserId });
  return buildSessionCookie(signSessionCookie({
    sessionId: session.id,
    workspaceId: "ws-1",
    adminUserId,
    workspaceRole: "ADMIN",
    expiresAt: session.expiresAt,
  }, secret), false).split(";")[0];
}

describe("authenticated API rate limit", () => {
  it("bounds requests per workspace/admin, survives session rotation, and leaves another admin independent", async () => {
    const { app, store, secret } = setup(2);
    const firstSession = ownedSession(store, secret, "admin-1");

    expect((await request(app).get("/api/me").set("Cookie", firstSession)).status).toBe(200);
    expect((await request(app).get("/api/permissions").set("Cookie", firstSession)).status).toBe(200);

    // A fresh session must not reset the broader authenticated API budget.
    const rotatedSession = ownedSession(store, secret, "admin-1");
    const limited = await request(app).get("/api/chat/history").set("Cookie", rotatedSession);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      ok: false,
      code: "rate_limited",
      message: "Too many API requests. Please wait a moment and try again.",
    });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(String(limited.headers.ratelimit)).toContain("remaining=0");
    expect(String(limited.headers["ratelimit-policy"])).not.toContain("pk=");

    // The key includes the admin, so one admin cannot exhaust another's budget.
    const otherAdmin = ownedSession(store, secret, "admin-2");
    expect((await request(app).get("/api/me").set("Cookie", otherAdmin)).status).toBe(200);

    // Requests with no valid session retain the ordinary authentication result;
    // they cannot fill the authenticated workspace/admin key space.
    const anonymous = await request(app).get("/api/me");
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.code).toBe("unauthorized");
  });

  it("counts an NDJSON stream and an artifact download as one request each", async () => {
    const { app, store, secret } = setup(3);
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const cookie = buildSessionCookie(signSessionCookie({
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      workspaceRole: "ADMIN",
      expiresAt: session.expiresAt,
    }, secret), false).split(";")[0];
    const artifact = store.createArtifact({
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      sessionId: session.id,
      contentType: "application/pdf",
      filename: "invoice.pdf",
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    });

    const stream = await request(app)
      .post("/api/chat/stream")
      .set("Cookie", cookie)
      .send({ message: "Hello" });
    expect(stream.status).toBe(200);
    expect(stream.headers["content-type"]).toContain("application/x-ndjson");

    const download = await request(app).get(`/api/artifacts/${artifact.id}`).set("Cookie", cookie);
    expect(download.status).toBe(200);
    expect(download.headers["content-type"]).toContain("application/pdf");

    expect((await request(app).get("/api/me").set("Cookie", cookie)).status).toBe(200);
    expect((await request(app).get("/api/me").set("Cookie", cookie)).status).toBe(429);
  });
});
