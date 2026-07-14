import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/server.js";
import { createStore, type Store } from "../../src/db/store.js";
import { signSessionCookie } from "../../src/auth/sessions.js";
import { buildSessionCookie } from "../../src/routes/deps.js";
import { makeTestConfig } from "../helpers/config.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";

const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function setup() {
  const store = createStore(":memory:", { encryptionKey: "test-key" });
  stores.push(store);
  const config = makeTestConfig();
  const fake = createFakeWorkspace();
  const app = createApp({
    config,
    store,
    parser: {} as never,
    modelClient: { complete: async () => "ok" },
    clockifyForWorkspace: () => fake.client,
  });
  return { app, config, store };
}

function ownedSession(store: Store, secret: string, workspaceId = "ws-1", adminUserId = "admin-1") {
  const session = store.createSession({ workspaceId, adminUserId });
  const cookie = buildSessionCookie(signSessionCookie({
    sessionId: session.id,
    workspaceId,
    adminUserId,
    workspaceRole: "ADMIN",
    expiresAt: session.expiresAt,
  }, secret), false).split(";")[0];
  return { session, cookie };
}

describe("GET /api/artifacts/:id", () => {
  it("downloads only for the owning scope with hardened attachment headers", async () => {
    const { app, config, store } = setup();
    const owner = ownedSession(store, config.sessionSecret);
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x0a]);
    const artifact = store.createArtifact({
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      sessionId: owner.session.id,
      contentType: "application/pdf",
      filename: "invoice unsafe.pdf",
      bytes,
    });

    const response = await request(app).get(`/api/artifacts/${artifact.id}`).set("Cookie", owner.cookie);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/pdf");
    expect(response.headers["content-disposition"]).toBe('attachment; filename="invoice_unsafe.pdf"');
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-checksum-sha256"]).toMatch(/^[a-f0-9]{64}$/);
    expect(response.body).toEqual(Buffer.from(bytes));
  });

  it("returns the same scoped 404 for another workspace, admin, or session", async () => {
    const { app, config, store } = setup();
    const owner = ownedSession(store, config.sessionSecret);
    const artifact = store.createArtifact({
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      sessionId: owner.session.id,
      contentType: "application/pdf",
      filename: "private.pdf",
      bytes: new Uint8Array([1, 2, 3]),
    });

    for (const outsider of [
      ownedSession(store, config.sessionSecret, "ws-2", "admin-1"),
      ownedSession(store, config.sessionSecret, "ws-1", "admin-2"),
      ownedSession(store, config.sessionSecret, "ws-1", "admin-1"),
    ]) {
      const response = await request(app).get(`/api/artifacts/${artifact.id}`).set("Cookie", outsider.cookie);
      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        ok: false,
        code: "not_found",
        message: "Artifact not found or expired.",
      });
    }
  });
});
