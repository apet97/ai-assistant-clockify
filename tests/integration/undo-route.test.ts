import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { testKeys } from "../helpers/test-keys.js";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { makeTestConfig } from "../helpers/config.js";
import type { ModelClient } from "../../src/assistant/model-client.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import { mintAdminCookie } from "../helpers/session.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createRestWorkspaceClient } from "../../src/clockify/rest-workspace.js";
import { signSessionCookie } from "../../src/auth/sessions.js";
import { buildSessionCookie } from "../../src/routes/deps.js";

const ADDON_KEY = "ai-assistant";

let keys: { privateKey: unknown; pem: string };
let store: Store;
let app: Express;
let fake: FakeWorkspace;

// JSON-mode model that proposes a safe create (a tag — a reversible creation).
const modelClient: ModelClient = {
  async complete() {
    return JSON.stringify({
      kind: "actions",
      text: "Creating the tag.",
      actions: [{ name: "clockify_create_work_package", arguments: { tag: { name: "Deep Work" } } }],
    });
  },
};

// Mint the admin session cookie IN-PROCESS (no flaky HTTP /component/assistant
// round-trip). Under full-suite parallel load that round-trip intermittently
// failed to yield a capturable Set-Cookie — a cross-process supertest/ephemeral-
// server contention flake, NOT a product bug — and the old
// `Array.isArray(setCookie) ? … : ""` fallback then silently produced an EMPTY
// cookie, so the next request 401'd (the intermittent "expected 401 to be 200").
// mintAdminCookie builds the SAME signed cookie the component route issues,
// deterministically. The component route's own gating stays covered by its tests.
function adminCookieFor(targetStore: Store, user = "admin-1"): string {
  return mintAdminCookie(targetStore, "test-session-secret", { adminUserId: user });
}

function adminCookie(): string {
  return adminCookieFor(store);
}

function sessionAndCookie(targetStore: Store): { sessionId: string; cookie: string } {
  const session = targetStore.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
  const value = signSessionCookie({
    sessionId: session.id,
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    workspaceRole: "ADMIN",
    expiresAt: session.expiresAt,
  }, "test-session-secret");
  return { sessionId: session.id, cookie: buildSessionCookie(value, false).split(";")[0] };
}

beforeAll(async () => {
  keys = await testKeys();
  const config = makeTestConfig({
    clockifyAddonPublicKeyPem: keys.pem,
    clockifyAddonKey: ADDON_KEY,
  });
  store = createStore(":memory:", { encryptionKey: "test-key" });
  store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
  fake = createFakeWorkspace();
  const parser = createSignatureParser(ADDON_KEY, keys.pem);
  app = createApp({ config, store, parser, modelClient, clockifyForWorkspace: () => fake.client });
});

afterAll(() => store.close());

describe("undo route", () => {
  it("journals a production-scoped undo and atomically links its canonical result", async () => {
    const isoStore = createStore(":memory:", { encryptionKey: "test-key" });
    isoStore.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
    const { cookie, sessionId } = sessionAndCookie(isoStore);
    const undoId = isoStore.recordUndoable({
      sessionId,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "clockify_tags_create",
      installationGeneration: isoStore.getInstallation("ws-1")!.generation,
      reversal: [{ type: "tag", id: "tag-live", name: "Live tag" }],
    });
    const mutationPaths: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/v1/workspaces/ws-1/users") {
        return new Response(JSON.stringify([{ id: "admin-1", role: "ADMIN" }]), { status: 200 });
      }
      if (method === "DELETE" && url.pathname === "/api/v1/workspaces/ws-1/tags/tag-live") {
        mutationPaths.push(url.pathname);
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    };
    const rest = createRestWorkspaceClient({
      baseUrl: "https://api.clockify.me/api/v1",
      workspaceId: "ws-1",
      auth: { addonToken: "addon-token" },
      fetchImpl,
      testOnlyEnforceMutationScope: true,
    });
    const isoApp = createApp({
      config: makeTestConfig({ clockifyAddonPublicKeyPem: keys.pem, clockifyAddonKey: ADDON_KEY }),
      store: isoStore,
      parser: createSignatureParser(ADDON_KEY, keys.pem),
      modelClient,
      clockifyForWorkspace: () => rest,
    });

    const response = await request(isoApp).post(`/api/undo/${undoId}`).set("Cookie", cookie).send({});

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, receipt: { ok: true } });
    expect(mutationPaths).toEqual(["/api/v1/workspaces/ws-1/tags/tag-live"]);
    const run = isoStore.listScopedOperationRuns("ws-1", "admin-1", sessionId, 10)
      .find((candidate) => candidate.actionName === "undo");
    expect(run).toMatchObject({
      status: "succeeded",
      steps: [{
        planStepId: "undo-0-tag-delete",
        index: 0,
        status: "succeeded",
        queuedAt: expect.any(String),
        dispatchedAt: expect.any(String),
      }],
      result: { id: expect.any(String), kind: "succeeded" },
    });
    expect(isoStore.getUndoRecord(undoId)).toMatchObject({
      status: "undone",
      remaining: [],
      actionResultId: run!.result!.id,
    });
    expect(isoStore.getActionResult(run!.result!.id)).toMatchObject({
      kind: "receipt",
      receipt: { ok: true, action: "undo" },
    });
    isoStore.close();
  });

  it("rechecks authority for each undo step and stops later dispatch after demotion", async () => {
    const isoStore = createStore(":memory:", { encryptionKey: "test-key" });
    isoStore.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
    const { cookie, sessionId } = sessionAndCookie(isoStore);
    const undoId = isoStore.recordUndoable({
      sessionId,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "seed",
      installationGeneration: isoStore.getInstallation("ws-1")!.generation,
      // Reverse execution order is tag -> invoice -> webhook.
      reversal: [
        { type: "webhook", id: "hook-later" },
        { type: "invoice", id: "invoice-denied" },
        { type: "tag", id: "tag-first" },
      ],
    });
    let roleReads = 0;
    const mutationPaths: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/v1/workspaces/ws-1/users") {
        roleReads += 1;
        // Authenticated surfaces now perform a fail-closed role check before the
        // mutation-specific preflight and each dispatch. Keep the caller admin
        // for surface + preflight + first step, then demote before step two.
        const role = roleReads <= 3 ? "ADMIN" : "USER";
        return new Response(JSON.stringify([{ id: "admin-1", role }]), { status: 200 });
      }
      if (method === "DELETE") {
        mutationPaths.push(url.pathname);
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    };
    const rest = createRestWorkspaceClient({
      baseUrl: "https://api.clockify.me/api/v1",
      workspaceId: "ws-1",
      auth: { addonToken: "addon-token" },
      fetchImpl,
      testOnlyEnforceMutationScope: true,
    });
    const isoApp = createApp({
      config: makeTestConfig({ clockifyAddonPublicKeyPem: keys.pem, clockifyAddonKey: ADDON_KEY }),
      store: isoStore,
      parser: createSignatureParser(ADDON_KEY, keys.pem),
      modelClient,
      clockifyForWorkspace: () => rest,
    });

    const response = await request(isoApp).post(`/api/undo/${undoId}`).set("Cookie", cookie).send({});

    expect(response.status).toBe(200);
    expect(response.body.receipt).toMatchObject({ ok: true, action: "undo" });
    expect(response.body.receipt.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "undo_failed" }),
    ]));
    expect(mutationPaths).toEqual(["/api/v1/workspaces/ws-1/tags/tag-first"]);
    const run = isoStore.listScopedOperationRuns("ws-1", "admin-1", sessionId, 10)
      .find((candidate) => candidate.actionName === "undo");
    expect(run).toMatchObject({
      status: "partial",
      steps: [
        { planStepId: "undo-0-tag-delete", status: "succeeded" },
        { planStepId: "undo-1-invoice-delete", status: "definitive_failed" },
      ],
    });
    expect(isoStore.getUndoRecord(undoId)).toMatchObject({
      status: "partially_undone",
      remaining: [
        { type: "webhook", id: "hook-later" },
        { type: "invoice", id: "invoice-denied" },
      ],
      actionResultId: run!.result!.id,
    });
    isoStore.close();
  });

  it("attaches an undo handle to a create receipt and reverses it on POST /undo/:id", async () => {
    const cookie = adminCookie();
    const chat = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "create a tag" });
    expect(chat.status).toBe(200);
    const receiptResult = (chat.body.results as Array<{ kind: string; receipt?: { ok: boolean }; undo?: { id: string } }>).find(
      (r) => r.kind === "receipt",
    );
    expect(receiptResult?.receipt?.ok).toBe(true);
    const undoId = receiptResult?.undo?.id;
    expect(typeof undoId).toBe("string");
    expect(fake.counts.createTag).toBe(1);

    const undo = await request(app).post(`/api/undo/${undoId}`).set("Cookie", cookie).send({});
    expect(undo.status).toBe(200);
    expect(undo.body.ok).toBe(true);
    expect(fake.state.deleted.some((d) => d.entityType === "tag")).toBe(true);

    // one-use: a second undo is rejected
    const again = await request(app).post(`/api/undo/${undoId}`).set("Cookie", cookie).send({});
    expect(again.status).toBe(409);
  });

  // Mirrors routes.test.ts "a confirm denied by lowered policy does not consume the
  // preview" for the undo route: the policy re-check must run BEFORE markUndone, so a
  // lowered policy denies cleanly without burning the one-use record. Uses its own
  // store/fake so the shared-suite tag (and its idempotency window) can't suppress the
  // fresh undo handle this assertion depends on.
  it("an undo denied by lowered policy does not burn the one-use record", async () => {
    const isoStore = createStore(":memory:", { encryptionKey: "test-key" });
    isoStore.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
    const isoFake = createFakeWorkspace();
    const isoApp = createApp({
      config: makeTestConfig({
        clockifyAddonPublicKeyPem: keys.pem,
        clockifyAddonKey: ADDON_KEY,
      }),
      store: isoStore,
      parser: createSignatureParser(ADDON_KEY, keys.pem),
      modelClient,
      clockifyForWorkspace: () => isoFake.client,
    });

    const cookie = mintAdminCookie(isoStore, "test-session-secret", { adminUserId: "admin-1" });

    const chat = await request(isoApp).post("/api/chat/messages").set("Cookie", cookie).send({ message: "create a tag" });
    expect(chat.status).toBe(200);
    const receiptResult = (chat.body.results as Array<{ kind: string; undo?: { id: string } }>).find(
      (r) => r.kind === "receipt",
    );
    const undoId = receiptResult?.undo?.id;
    expect(typeof undoId).toBe("string");
    expect(isoFake.state.deleted.length).toBe(0);

    // Lower the policy to read-only for the tag's group AFTER the undo handle was issued.
    const lowered = defaultAdminPolicy();
    lowered.groups.work_structure = "read";
    isoStore.upsertAdminPolicy("ws-1", "admin-1", lowered);

    // Deny-before-burn: the policy re-check rejects (400) WITHOUT consuming the record
    // and WITHOUT deleting the entity.
    const denied = await request(isoApp).post(`/api/undo/${undoId}`).set("Cookie", cookie).send({});
    expect(denied.status).toBe(400);
    expect(denied.body.code).toBe("policy_denied");
    expect(isoFake.state.deleted.length).toBe(0);

    // Re-enable write access and undo the SAME record — it was never burned, so it reverses now.
    isoStore.upsertAdminPolicy("ws-1", "admin-1", defaultAdminPolicy());
    const ok = await request(isoApp).post(`/api/undo/${undoId}`).set("Cookie", cookie).send({});
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(isoFake.state.deleted.some((d) => d.entityType === "tag")).toBe(true);

    isoStore.close();
  });

  // Ownership arm: an undo handle is bound to the creating admin. A SECOND admin with a
  // valid session in the SAME workspace must NOT be able to undo admin-1's creation —
  // undo performs destructive deletes, so a cross-admin attempt 404s with no deletion and
  // does NOT consume the record (admin-1 can still undo it afterward). Uses its own
  // store/fake so the shared-suite tag's idempotency window can't suppress the fresh undo
  // handle this assertion depends on.
  it("404s a cross-admin undo without deleting or consuming the record", async () => {
    const isoStore = createStore(":memory:", { encryptionKey: "test-key" });
    isoStore.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
    const isoFake = createFakeWorkspace();
    const isoApp = createApp({
      config: makeTestConfig({
        clockifyAddonPublicKeyPem: keys.pem,
        clockifyAddonKey: ADDON_KEY,
      }),
      store: isoStore,
      parser: createSignatureParser(ADDON_KEY, keys.pem),
      modelClient,
      clockifyForWorkspace: () => isoFake.client,
    });

    // admin-1 creates a tag -> gets an undo handle bound to admin-1.
    const adminOne = adminCookieFor(isoStore, "admin-1");
    const chat = await request(isoApp).post("/api/chat/messages").set("Cookie", adminOne).send({ message: "create a tag" });
    expect(chat.status).toBe(200);
    const receiptResult = (chat.body.results as Array<{ kind: string; undo?: { id: string } }>).find(
      (r) => r.kind === "receipt",
    );
    const undoId = receiptResult?.undo?.id;
    expect(typeof undoId).toBe("string");
    expect(isoFake.state.deleted.length).toBe(0);

    // admin-2 (valid session, same workspace, ADMIN) tries to undo admin-1's record.
    const adminTwo = adminCookieFor(isoStore, "admin-2");
    const foreign = await request(isoApp).post(`/api/undo/${undoId}`).set("Cookie", adminTwo).send({});
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe("not_found");
    // No deletion happened, and the record was NOT consumed by the foreign attempt.
    expect(isoFake.state.deleted.length).toBe(0);

    // The owning admin can still undo the SAME record — it was never burned.
    const owned = await request(isoApp).post(`/api/undo/${undoId}`).set("Cookie", adminOne).send({});
    expect(owned.status).toBe(200);
    expect(owned.body.ok).toBe(true);
    expect(isoFake.state.deleted.some((d) => d.entityType === "tag")).toBe(true);

    isoStore.close();
  });

  it("404s an unknown undo id", async () => {
    const cookie = adminCookie();
    const res = await request(app).post("/api/undo/does-not-exist").set("Cookie", cookie).send({});
    expect(res.status).toBe(404);
  });

  it("rejects an unauthenticated undo", async () => {
    const res = await request(app).post("/api/undo/whatever").send({});
    expect(res.status).toBe(401);
  });

  it("independent identical invoice operations mint distinct undo records", async () => {
    // Invoice identity is the stored operation id, not a semantic time window.
    // Two new previews are two intentional operations even when their visible
    // fields match, and each created invoice needs its own undo handle.
    const isoStore = createStore(":memory:", { encryptionKey: "test-key" });
    isoStore.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
    const isoFake = createFakeWorkspace({ clients: [{ id: "c1", name: "Acme" }] });
    const invoiceModel: ModelClient = {
      async complete() {
        return JSON.stringify({
          kind: "actions",
          text: "Creating the invoice.",
          actions: [{ name: "clockify_invoices_create", arguments: { clientName: "Acme" } }],
        });
      },
    };
    const isoApp = createApp({
      config: makeTestConfig({
        clockifyAddonPublicKeyPem: keys.pem,
        clockifyAddonKey: ADDON_KEY,
      }),
      store: isoStore,
      parser: createSignatureParser(ADDON_KEY, keys.pem),
      modelClient: invoiceModel,
      clockifyForWorkspace: () => isoFake.client,
    });
    const cookie = adminCookieFor(isoStore, "admin-1");

    const confirmInvoice = async () => {
      const chat = await request(isoApp).post("/api/chat/messages").set("Cookie", cookie).send({ message: "create an invoice for Acme" });
      const preview = (chat.body.results as Array<{ kind: string; previewId?: string; nonce?: string }>).find((r) => r.kind === "preview");
      if (!preview?.previewId || !preview.nonce) throw new Error(`expected an invoice preview, got ${JSON.stringify(chat.body.results)}`);
      return request(isoApp).post(`/api/confirmations/${preview.previewId}/confirm`).set("Cookie", cookie).send({ nonce: preview.nonce });
    };

    const first = await confirmInvoice();
    expect(first.status).toBe(200);
    expect(first.body.undo?.id).toBeTruthy();

    const second = await confirmInvoice();
    expect(second.status).toBe(200);
    expect(second.body.undo?.id).toBeTruthy();
    expect(second.body.undo.id).not.toBe(first.body.undo.id);
    expect(isoFake.counts.createInvoiceBase).toBe(2);

    isoStore.close();
  });
});
