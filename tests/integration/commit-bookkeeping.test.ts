import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { testing } from "@apet97/clockify-addon-sdk";
import { testKeys } from "../helpers/test-keys.js";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { makeTestConfig } from "../helpers/config.js";
import type { ToolCompletion } from "../../src/assistant/model-client.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import { scriptedToolModel } from "../helpers/scripted-model.js";

/**
 * Post-host bookkeeping must preserve the truthful receipt. Canonical
 * confirmation settlement is retried synchronously and owns idempotency
 * completion; audit and undo enrichment remain best-effort after that durable
 * safety transition.
 *
 * To inject the throw without a test-only hook in `src/`, we wrap the real store
 * passed into `createApp`'s deps and override the one bookkeeping method
 * (`createStore` returns an object literal of closures, so spreading keeps every
 * other method's binding intact). A pure risky-write preview (no read executed
 * before the interrupt) never audits during the chat turn, so the wrapped method
 * throws ONLY at confirm time.
 */
const ADDON_KEY = "ai-assistant";

let stores: Store[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores = [];
});

interface TestApp {
  app: Express;
  cookie: string;
  store: Store;
}

async function makeApp(
  script: ToolCompletion[],
  fake: FakeWorkspace,
  wrapStore: (store: Store) => Store = (s) => s,
): Promise<TestApp> {
  const keys = await testKeys();
  const config = makeTestConfig({
    clockifyAddonPublicKeyPem: keys.pem,
    clockifyAddonKey: ADDON_KEY,
  });
  const store = createStore(":memory:", { encryptionKey: "test-key" });
  stores.push(store);
  store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
  const parser = createSignatureParser(ADDON_KEY, keys.pem);
  const app = createApp({
    config,
    store: wrapStore(store),
    parser,
    modelClient: scriptedToolModel(script),
    clockifyForWorkspace: () => fake.client,
  });
  const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
    workspaceId: "ws-1",
    user: "admin-1",
    workspaceRole: "ADMIN",
    addonId: "addon-1",
  });
  const res = await request(app).get("/component/assistant").query({ auth_token: token });
  const setCookie = res.headers["set-cookie"];
  const cookie = Array.isArray(setCookie) ? setCookie[0].split(";")[0] : "";
  return { app, cookie, store };
}

type ResultItem = { kind: string; previewId?: string; nonce?: string };

function previewsOf(results: ResultItem[]): ResultItem[] {
  return results.filter((r) => r.kind === "preview");
}

const DELETE_TAG: ToolCompletion = {
  text: "Deleting the tag now.",
  toolCalls: [{ id: "r1", name: "clockify_tags_delete", arguments: { name: "urgent" } }],
};

// A reversible RISKY create (an invoice — `invoice` is a REVERSIBLE_ENTITY_GROUP
// type). Unlike a delete, a successful invoice commit reaches the THIRD post-commit
// write, `recordUndoIfReversible` -> `store.recordUndoable`, to mint an undo handle.
const CREATE_INVOICE: ToolCompletion = {
  text: "Creating the invoice now.",
  toolCalls: [{ id: "r1", name: "clockify_invoices_create", arguments: { clientName: "Acme" } }],
};

describe("post-commit bookkeeping is best-effort (a DB hiccup can't drop a committed receipt)", () => {
  it("addAuditEvent throwing at confirm does NOT 500: the receipt returns and the commit ran exactly once", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const { app, cookie } = await makeApp([DELETE_TAG], fake, (store) => ({
      ...store,
      addAuditEvent: () => {
        throw new Error("db busy");
      },
    }));

    const chat = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the urgent tag" });
    expect(chat.status).toBe(200);
    const preview = previewsOf(chat.body.results as ResultItem[])[0];
    expect(preview).toBeDefined();
    expect(fake.counts.deleteTag ?? 0).toBe(0);

    const confirm = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });

    // The bookkeeping write threw AFTER the commit. The confirm must still be a
    // 200 carrying the committed receipt — not a 500 that swallows it.
    expect(confirm.status).toBe(200);
    expect(confirm.body.receipt.ok).toBe(true);
    expect(confirm.body.receipt.action).toBe("clockify_tags_delete");
    // The commit happened exactly once on the underlying host.
    expect(fake.counts.deleteTag).toBe(1);
    expect(fake.state.tags.find((t) => t.id === "t1")).toBeUndefined();
  });

  it("retries a transient canonical confirmation settlement and scrubs the consumed operation", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    let settlementAttempts = 0;
    const { app, cookie, store } = await makeApp([DELETE_TAG], fake, (underlying) => ({
      ...underlying,
      settleConfirmation: (...args: Parameters<Store["settleConfirmation"]>) => {
        settlementAttempts += 1;
        if (settlementAttempts === 1) throw new Error("db busy");
        return underlying.settleConfirmation(...args);
      },
    }));

    const chat = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the urgent tag" });
    expect(chat.status).toBe(200);
    const preview = previewsOf(chat.body.results as ResultItem[])[0];
    expect(preview).toBeDefined();

    const confirm = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });

    expect(confirm.status).toBe(200);
    expect(confirm.body.receipt.ok).toBe(true);
    expect(fake.counts.deleteTag).toBe(1);
    expect(settlementAttempts).toBe(2);
    expect(store.getPendingConfirmation(preview.previewId!)).toMatchObject({
      status: "succeeded",
      nonceHash: "",
      operation: {},
      agentState: undefined,
      actionResultId: expect.any(String),
    });
  });

  it("surfaces persistent settlement degradation with the host receipt, then orphan recovery scrubs it", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    let settlementAttempts = 0;
    const { app, cookie, store } = await makeApp([DELETE_TAG], fake, (underlying) => ({
      ...underlying,
      settleConfirmation: () => {
        settlementAttempts += 1;
        throw new Error("db unavailable");
      },
    }));
    const chat = await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "delete the urgent tag" });
    const preview = previewsOf(chat.body.results as ResultItem[])[0];

    const confirm = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });

    expect(confirm.status).toBe(200);
    expect(confirm.body).toMatchObject({
      ok: true,
      persistenceDegraded: true,
      receipt: { ok: true, action: "clockify_tags_delete" },
    });
    expect(settlementAttempts).toBe(2);
    expect(fake.counts.deleteTag).toBe(1);
    expect(store.getPendingConfirmation(preview.previewId!)).toMatchObject({ status: "executing" });

    store.recoverOrphanedRuns();
    expect(store.getPendingConfirmation(preview.previewId!)).toMatchObject({
      status: "outcome_unknown",
      nonceHash: "",
      operation: {},
      agentState: undefined,
      actionResultId: expect.any(String),
    });
  });

  it("recordUndoIfReversible (the 3rd write) throwing at confirm does NOT 500: the committed receipt returns and the commit ran exactly once", async () => {
    // The first two writes are covered above; this pins the THIRD post-commit
    // bookkeeping write. `recordUndoIfReversible` calls `store.recordUndoable`,
    // which is reached ONLY by a successful REVERSIBLE create — so we drive a
    // risky invoice create (not a delete) through preview -> confirm and wrap
    // the store so `recordUndoable` throws once at confirm time. The invoice has
    // ALREADY committed by then, so the throw must NOT 500 / drop the receipt.
    const fake = createFakeWorkspace({ clients: [{ id: "c1", name: "Acme" }] });
    let undoableThrows = 0;
    const { app, cookie } = await makeApp([CREATE_INVOICE], fake, (store) => ({
      ...store,
      recordUndoable: () => {
        undoableThrows += 1;
        throw new Error("db busy");
      },
    }));

    const chat = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "create an invoice for Acme" });
    expect(chat.status).toBe(200);
    const preview = previewsOf(chat.body.results as ResultItem[])[0];
    expect(preview).toBeDefined();
    // Nothing committed at preview time.
    expect(fake.counts.createInvoice ?? 0).toBe(0);

    const confirm = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });

    // The undo-bookkeeping write threw AFTER the commit. The confirm must still
    // be a 200 carrying the committed receipt — not a 500 that swallows it.
    expect(confirm.status).toBe(200);
    expect(confirm.body.receipt.ok).toBe(true);
    expect(confirm.body.receipt.action).toBe("clockify_invoices_create");
    // The throwing path WAS exercised (sanity: the 3rd write actually ran), and
    // the commit happened exactly once on the underlying host.
    expect(undoableThrows).toBe(1);
    expect(fake.counts.createInvoice).toBe(1);
  });

  it("binds the idempotency claim during canonical confirmation settlement without a separate fill write", async () => {
    // A risky idempotent create claims before host dispatch. The confirmation
    // settlement must fill that claim in the same transaction as its canonical
    // result; the legacy standalone fill seam must not run afterward.
    const fake = createFakeWorkspace({ clients: [{ id: "c1", name: "Acme" }] });
    let fillThrows = 0;
    let claimedKey: string | undefined;
    const { app, cookie, store } = await makeApp([CREATE_INVOICE], fake, (underlying) => ({
      ...underlying,
      claimIdempotency: (...args: Parameters<Store["claimIdempotency"]>) => {
        claimedKey = args[0];
        return underlying.claimIdempotency(...args);
      },
      fillIdempotency: () => {
        fillThrows += 1;
        throw new Error("db busy");
      },
    }));

    const chat = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "create an invoice for Acme" });
    expect(chat.status).toBe(200);
    const preview = previewsOf(chat.body.results as ResultItem[])[0];
    expect(preview).toBeDefined();
    expect(fake.counts.createInvoice ?? 0).toBe(0);

    const confirm = await request(app)
      .post(`/api/confirmations/${preview.previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });

    expect(confirm.status).toBe(200);
    expect(confirm.body.receipt.ok).toBe(true);
    expect(confirm.body.receipt.action).toBe("clockify_invoices_create");
    // Settlement owns the ledger binding in its transaction; the old, separate
    // post-commit fill seam is never called and cannot strand a live claim.
    expect(fillThrows).toBe(0);
    expect(claimedKey).toBeDefined();
    expect(store.claimIdempotency(claimedKey!, "ws-1", "admin-1", Date.now(), 0, 0)).toBe("replay");
    expect(store.claimIdempotencyReceipt(claimedKey!, "ws-1", "admin-1")).toMatchObject({
      ok: true,
      action: "clockify_invoices_create",
    });
    expect(fake.counts.createInvoice).toBe(1);
  });
});
