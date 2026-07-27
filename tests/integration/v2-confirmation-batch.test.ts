import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { computeRequestHash } from "../../src/assistant-v2/state.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { createStore } from "../../src/db/store.js";
import { createOperationPreparationService } from "../../src/services/operation-preparation-service.js";
import { createConfirmationService } from "../../src/services/confirmation-service.js";
import { createWorkspaceMutationCoordinator } from "../../src/clockify/workspace-mutation-coordinator.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { computeOrderedTupleHash } from "../../src/db/store/confirmation-batches.js";
import { createPendingConfirmation, rotatePendingNonce } from "../../src/harness/confirmations.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { WRITE_PREVIEW_BASE_SEED, WRITE_PREVIEW_FIXTURES } from "../helpers/v2-write-preview-fixtures.js";
import { createApp } from "../../src/server.js";
import { makeTestConfig } from "../helpers/config.js";
import { testKeys } from "../helpers/test-keys.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { signSessionCookie } from "../../src/auth/sessions.js";
import { buildSessionCookie } from "../../src/routes/deps.js";
import { selectModelClient } from "../../src/assistant/select-model-client.js";

const SESSION_SECRET = "test-session-secret";
const NOW = new Date("2026-06-06T12:00:00.000Z");
const directories: string[] = [];
const stores: ReturnType<typeof createStore>[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "v2-confirmation-batch-"));
  directories.push(directory);
  return join(directory, "db.sqlite");
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function mutationCallTotal(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

function cookieForSession(
  session: { id: string; expiresAt: string },
  scope: { workspaceId: string; adminUserId: string },
): string {
  const value = signSessionCookie(
    {
      sessionId: session.id,
      workspaceId: scope.workspaceId,
      adminUserId: scope.adminUserId,
      workspaceRole: "ADMIN",
      expiresAt: session.expiresAt,
    },
    SESSION_SECRET,
  );
  return buildSessionCookie(value, false).split(";")[0]!;
}

/** Independent creates (tag + client) — same-entity create baselines are not batch-safe. */
async function prepareIndependentCreates(
  scope: {
    sessionId: string;
    runId: string;
    workspaceId: string;
    adminUserId: string;
    installationGeneration: number;
    authClass: "addon";
  },
  options: { now?: () => Date } = {},
) {
  const clock = options.now ?? (() => NOW);
  const fake = createFakeWorkspace(WRITE_PREVIEW_BASE_SEED);
  const store = createStore(databasePath(), { encryptionKey: "k", now: clock });
  stores.push(store);
  store.saveInstallation({ workspaceId: scope.workspaceId, addonId: "addon-1", addonUserId: "u1", addonToken: "token" });
  const session = store.createSession({ workspaceId: scope.workspaceId, adminUserId: scope.adminUserId });
  store.startRunWithTurn({
    scope: { ...scope, sessionId: session.id },
    originalRequest: "batch independent creates",
    requestHash: computeRequestHash("batch independent creates"),
    catalogHash: MODEL_API_ACTION_CATALOG.hash(),
    loadedToolNames: ["clockify_tags_create", "clockify_clients_create_base"],
    intentHash: scope.runId,
  });
  const runScope = { ...scope, sessionId: session.id };
  const preparation = createOperationPreparationService({
    store,
    registry: MODEL_API_ACTION_CATALOG,
    sessionSecret: SESSION_SECRET,
    clockifyForScope: () => fake.client,
    now: clock,
    loadCalendarContext: async () => ({ timeZone: "UTC", weekStartsOn: 1 }),
  });
  const prepared = await preparation.prepare([
    { id: "tool-1", name: "clockify_tags_create", arguments: WRITE_PREVIEW_FIXTURES.clockify_tags_create.args },
    { id: "tool-2", name: "clockify_clients_create_base", arguments: WRITE_PREVIEW_FIXTURES.clockify_clients_create_base.args },
  ], runScope);
  return { fake, store, session, runScope, prepared, clock };
}

function confirmationService(
  store: ReturnType<typeof createStore>,
  fake: ReturnType<typeof createFakeWorkspace>,
  now: () => Date = () => NOW,
) {
  return createConfirmationService({
    store,
    registry: MODEL_API_ACTION_CATALOG,
    sessionSecret: SESSION_SECRET,
    catalogHash: () => MODEL_API_ACTION_CATALOG.hash(),
    now,
    loadPolicy: () => defaultAdminPolicy(),
    verifyWriteAuthority: async () => ({ ok: true as const, installationGeneration: 1 }),
    actionContext: () => ({
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      policy: defaultAdminPolicy(),
      clockify: fake.client,
      now,
    }),
    mutationCoordinator: createWorkspaceMutationCoordinator(),
    recordUndoIfReversible: () => undefined,
  });
}

describe("v2 confirmation batches", () => {
  it("creates batch membership atomically with ordered tuple hash and earliest expiry", async () => {
    const later = new Date(NOW.getTime() + 240_000);
    const fake = createFakeWorkspace(WRITE_PREVIEW_BASE_SEED);
    const store = createStore(databasePath(), { encryptionKey: "k", now: () => NOW });
    stores.push(store);
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    store.startRunWithTurn({
      scope: {
        sessionId: session.id,
        runId: "run-batch",
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        installationGeneration: 1,
        authClass: "addon",
      },
      originalRequest: "batch",
      requestHash: computeRequestHash("batch"),
      catalogHash: MODEL_API_ACTION_CATALOG.hash(),
      loadedToolNames: [],
      intentHash: "run-batch",
    });

    const writes = ["conf-a", "conf-b"].map((id, index) => {
      const operationId = `op-${index}`;
      const created = createPendingConfirmation({
        id,
        sessionId: session.id,
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        risk: ["safe_write"],
        preview: { summary: id },
        operation: {
          operationId,
          actionName: "clockify_tags_create",
          payload: WRITE_PREVIEW_FIXTURES.clockify_tags_create.args,
          mutationPlan: { mode: "single", maxHostCalls: 1, steps: [{ id: "create-tag", kind: "primary", reconciliationStrategy: "create" }] },
        },
        installationGeneration: 1,
        sessionSecret: SESSION_SECRET,
        now: index === 0 ? NOW : later,
        ttlMs: index === 0 ? 300_000 : 120_000,
        origin: "assistant",
        registryId: "v2-api",
        authorityModel: "preview_confirmation_v2",
        executorKind: "prepared_safe_write",
        runId: "run-batch",
      });
      return { created, operationId };
    });

    const earliestExpiry = writes
      .map((write) => write.created.expiresAt)
      .reduce((earliest, expiresAt) => (expiresAt < earliest ? expiresAt : earliest));

    const state = store.getRun({
      sessionId: session.id,
      runId: "run-batch",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      installationGeneration: 1,
      authClass: "addon",
    })!;

    const persisted = store.prepareAssistantWriteBatchWithEvents({
      scope: {
        sessionId: session.id,
        runId: "run-batch",
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        installationGeneration: 1,
        authClass: "addon",
      },
      state,
      writes: writes.map(({ created, operationId }) => ({
        hostCalls: 1,
        event: { operationId, confirmationId: created.record.id },
        operationRun: {
          id: operationId,
          confirmationId: created.record.id,
          sessionId: session.id,
          workspaceId: "ws-1",
          adminUserId: "admin-1",
          actionName: "clockify_tags_create",
          actionFingerprint: "fp",
          catalogHash: MODEL_API_ACTION_CATALOG.hash(),
          operationHash: created.record.operationHash,
          operation: WRITE_PREVIEW_FIXTURES.clockify_tags_create.args,
          mutationPlan: { mode: "single", maxHostCalls: 1, steps: [{ id: "create-tag", kind: "primary", reconciliationStrategy: "create" }] },
          discriminator: {
            origin: "assistant",
            registryId: "v2-api",
            authorityModel: "preview_confirmation_v2",
            executorKind: "prepared_safe_write",
            runId: "run-batch",
            fieldProvenanceJson: "{}",
            fieldProvenanceHash: "a".repeat(64),
          },
        },
        confirmation: created.record,
      })),
      batch: {
        sessionId: session.id,
        runId: "run-batch",
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        orderedTupleHash: computeOrderedTupleHash([
          { confirmationId: "conf-a", operationId: "op-0" },
          { confirmationId: "conf-b", operationId: "op-1" },
        ]),
        expiresAt: earliestExpiry,
      },
    });

    expect(persisted.batchId).toBeDefined();
    const batch = store.getConfirmationBatch(persisted.batchId!)!;
    expect(batch.expiresAt).toBe(earliestExpiry);
    expect(batch.orderedTupleHash).toBe(computeOrderedTupleHash([
      { confirmationId: "conf-a", operationId: "op-0" },
      { confirmationId: "conf-b", operationId: "op-1" },
    ]));
    expect(store.getPendingConfirmation("conf-a")?.batchId).toBe(batch.id);
    expect(store.getOperationRun("op-0")?.batchId).toBe(batch.id);
    expect(mutationCallTotal(fake.counts)).toBe(0);
  });

  it("confirms an exact batch in stored order and rejects single-confirm bypass", async () => {
    const scope = {
      sessionId: "",
      runId: "run-batch-confirm",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      installationGeneration: 1,
      authClass: "addon" as const,
    };
    const { fake, store, session, prepared } = await prepareIndependentCreates(scope);
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared" || !prepared.batchId) return;

    const nonces = prepared.confirmationIds.map((confirmationId) => {
      const pending = store.getPendingConfirmation(confirmationId)!;
      const rotated = rotatePendingNonce({
        record: pending,
        sessionId: session.id,
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        sessionSecret: SESSION_SECRET,
        nonce: `nonce-${confirmationId}`,
        now: NOW,
      });
      expect(rotated.ok).toBe(true);
      if (!rotated.ok) throw new Error("rotate failed");
      store.updateConfirmationNonceHash(confirmationId, rotated.record.nonceHash);
      return { confirmationId, nonce: rotated.nonce };
    });

    const service = confirmationService(store, fake);
    const single = await service.confirmSingle({
      claims: { sessionId: session.id, workspaceId: "ws-1", adminUserId: "admin-1" },
      record: store.getPendingConfirmation(prepared.confirmationIds[0]!)!,
      nonce: nonces[0]!.nonce,
    });
    expect(single.ok).toBe(false);
    if (single.ok) return;
    expect(single.body.code).toBe("batch_confirmation_required");

    const batchOutcome = await service.confirmBatch({
      claims: { sessionId: session.id, workspaceId: "ws-1", adminUserId: "admin-1" },
      batchId: prepared.batchId,
      items: nonces,
    });
    expect(batchOutcome.ok).toBe(true);
    if (!batchOutcome.ok) return;
    expect(batchOutcome.status).toBe("succeeded");
    expect(batchOutcome.items).toHaveLength(2);
    expect(fake.counts.createTag).toBe(1);
    expect(fake.counts.createClientBaseAtomic).toBe(1);
    expect(store.getConfirmationBatch(prepared.batchId)?.status).toBe("succeeded");
  });

  it("rejects reordered batch members and replays a settled batch without redispatch", async () => {
    const scope = {
      sessionId: "",
      runId: "run-batch-replay",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      installationGeneration: 1,
      authClass: "addon" as const,
    };
    const { fake, store, session, prepared } = await prepareIndependentCreates(scope);
    if (prepared.kind !== "prepared" || !prepared.batchId) return;

    const nonces = prepared.confirmationIds.map((confirmationId, index) => {
      const pending = store.getPendingConfirmation(confirmationId)!;
      const rotated = rotatePendingNonce({
        record: pending,
        sessionId: session.id,
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        sessionSecret: SESSION_SECRET,
        nonce: `nonce-${index}`,
        now: NOW,
      });
      if (!rotated.ok) throw new Error("rotate failed");
      store.updateConfirmationNonceHash(confirmationId, rotated.record.nonceHash);
      return { confirmationId, nonce: rotated.nonce };
    });

    const service = confirmationService(store, fake);
    const first = await service.confirmBatch({
      claims: { sessionId: session.id, workspaceId: "ws-1", adminUserId: "admin-1" },
      batchId: prepared.batchId,
      items: nonces,
    });
    expect(first.ok).toBe(true);
    const mutationsAfterFirst = mutationCallTotal(fake.counts);

    const reordered = await service.confirmBatch({
      claims: { sessionId: session.id, workspaceId: "ws-1", adminUserId: "admin-1" },
      batchId: prepared.batchId,
      items: [...nonces].reverse(),
    });
    expect(reordered.ok).toBe(false);
    if (reordered.ok) return;
    expect(reordered.body.code).toBe("batch_items_mismatch");

    const replay = await service.confirmBatch({
      claims: { sessionId: session.id, workspaceId: "ws-1", adminUserId: "admin-1" },
      batchId: prepared.batchId,
      items: nonces.map(({ confirmationId }) => ({ confirmationId })),
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.items.every((item) => item.replayed)).toBe(true);
    expect(mutationCallTotal(fake.counts)).toBe(mutationsAfterFirst);
  });

  it("recovers a never-dispatched executing batch back to pending before confirm", async () => {
    const scope = {
      sessionId: "",
      runId: "run-batch-recover",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      installationGeneration: 1,
      authClass: "addon" as const,
    };
    const { fake, store, session, prepared } = await prepareIndependentCreates(scope);
    if (prepared.kind !== "prepared" || !prepared.batchId) return;

    expect(store.markConfirmationBatchExecuting(prepared.batchId)).toBe(true);
    store.recoverConfirmationBatch(prepared.batchId, NOW.toISOString());
    expect(store.getConfirmationBatch(prepared.batchId)?.status).toBe("pending");

    const nonces = prepared.confirmationIds.map((confirmationId, index) => {
      const pending = store.getPendingConfirmation(confirmationId)!;
      const rotated = rotatePendingNonce({
        record: pending,
        sessionId: session.id,
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        sessionSecret: SESSION_SECRET,
        nonce: `recover-${index}`,
        now: NOW,
      });
      if (!rotated.ok) throw new Error("rotate failed");
      store.updateConfirmationNonceHash(confirmationId, rotated.record.nonceHash);
      return { confirmationId, nonce: rotated.nonce };
    });

    const outcome = await confirmationService(store, fake).confirmBatch({
      claims: { sessionId: session.id, workspaceId: "ws-1", adminUserId: "admin-1" },
      batchId: prepared.batchId,
      items: nonces,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.status).toBe("succeeded");
  });

  it("serves POST /api/confirmation-batches/:id/confirm for an exact batch", async () => {
    const scope = {
      sessionId: "",
      runId: "run-batch-route",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      installationGeneration: 1,
      authClass: "addon" as const,
    };
    // Live clock so the HTTP session gate does not see a frozen June 2026 expiry.
    const { fake, store, session, prepared, clock } = await prepareIndependentCreates(scope, {
      now: () => new Date(),
    });
    if (prepared.kind !== "prepared" || !prepared.batchId) return;

    const keys = await testKeys();
    const config = makeTestConfig({
      clockifyAddonPublicKeyPem: keys.pem,
      clockifyAddonKey: "ai-assistant",
      sessionSecret: SESSION_SECRET,
      assistantEngine: "v2",
    });
    const app = createApp({
      config,
      store,
      parser: createSignatureParser("ai-assistant", keys.pem),
      modelClient: selectModelClient(config),
      clockifyForWorkspace: () => fake.client,
    });
    const cookie = cookieForSession(session, scope);
    const items = prepared.confirmationIds.map((confirmationId, index) => {
      const pending = store.getPendingConfirmation(confirmationId)!;
      const rotated = rotatePendingNonce({
        record: pending,
        sessionId: session.id,
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        sessionSecret: SESSION_SECRET,
        nonce: `route-${index}`,
        now: clock(),
      });
      if (!rotated.ok) throw new Error("rotate failed");
      store.updateConfirmationNonceHash(confirmationId, rotated.record.nonceHash);
      return { confirmationId, nonce: rotated.nonce };
    });

    const res = await request(app)
      .post(`/api/confirmation-batches/${prepared.batchId}/confirm`)
      .set("Cookie", cookie)
      .send({ items });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe("succeeded");
    expect(res.body.items).toHaveLength(2);
  });
});
