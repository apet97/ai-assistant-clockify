import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeRequestHash } from "../../src/assistant-v2/state.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { createStore } from "../../src/db/store.js";
import { createOperationPreparationService } from "../../src/services/operation-preparation-service.js";
import { createConfirmationService } from "../../src/services/confirmation-service.js";
import { createWorkspaceMutationCoordinator } from "../../src/clockify/workspace-mutation-coordinator.js";
import { defaultAdminPolicy, type AdminPolicy } from "../../src/harness/permissions.js";
import { rotatePendingNonce } from "../../src/harness/confirmations.js";
import type { PendingConfirmationRecord } from "../../src/harness/confirmations.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { mutationCallTotal, SESSION_SECRET, WRITE_PARITY_NOW } from "../helpers/v2-write-parity.js";

const directories: string[] = [];
const stores: ReturnType<typeof createStore>[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "v2-confirmation-authority-"));
  directories.push(directory);
  return join(directory, "db.sqlite");
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface HarnessOptions {
  policy?: AdminPolicy;
  verifyWriteAuthority?: ReturnType<typeof createConfirmationService> extends never ? never : Parameters<typeof createConfirmationService>[0]["verifyWriteAuthority"];
}

function harness(options: HarnessOptions = {}) {
  const fake = createFakeWorkspace({ clients: [{ id: "c1", name: "Original Client Name" }] });
  const store = createStore(databasePath(), { encryptionKey: "k", now: () => WRITE_PARITY_NOW });
  stores.push(store);
  store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "u1", addonToken: "token-1" });
  const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
  const scope = {
    sessionId: session.id,
    runId: "run-1",
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    installationGeneration: 1,
    authClass: "addon" as const,
  };
  store.startRunWithTurn({
    scope,
    originalRequest: "archive the client Original Client Name",
    requestHash: computeRequestHash("archive the client Original Client Name"),
    catalogHash: MODEL_API_ACTION_CATALOG.hash(),
    loadedToolNames: ["clockify_clients_archive", "clockify_tags_create"],
    intentHash: scope.runId,
  });
  const preparation = createOperationPreparationService({
    store,
    registry: MODEL_API_ACTION_CATALOG,
    sessionSecret: SESSION_SECRET,
    clockifyForScope: () => fake.client,
    now: () => WRITE_PARITY_NOW,
    loadCalendarContext: async () => ({ timeZone: "UTC", weekStartsOn: 1 }),
  });
  const confirmation = createConfirmationService({
    store,
    registry: MODEL_API_ACTION_CATALOG,
    sessionSecret: SESSION_SECRET,
    catalogHash: () => MODEL_API_ACTION_CATALOG.hash(),
    now: () => WRITE_PARITY_NOW,
    loadPolicy: () => options.policy ?? defaultAdminPolicy(),
    verifyWriteAuthority: options.verifyWriteAuthority ?? (async () => ({ ok: true as const, installationGeneration: 1 })),
    actionContext: () => ({
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      policy: options.policy ?? defaultAdminPolicy(),
      clockify: fake.client,
      now: () => WRITE_PARITY_NOW,
    }),
    mutationCoordinator: createWorkspaceMutationCoordinator(),
    recordUndoIfReversible: () => undefined,
  });
  return { fake, store, session, scope, preparation, confirmation };
}

async function prepareTagCreate(input: ReturnType<typeof harness>) {
  const prepared = await input.preparation.prepare(
    [{ id: "tool-tag", name: "clockify_tags_create", arguments: { name: "Preview Tag" } }],
    input.scope,
  );
  expect(prepared.kind).toBe("prepared");
  if (prepared.kind !== "prepared") throw new Error("prepare failed");
  return {
    confirmationId: prepared.confirmationIds[0]!,
    operationId: prepared.operationIds[0]!,
  };
}

async function rotatedNonce(input: ReturnType<typeof harness>, confirmationId: string, seed: string) {
  const pending = input.store.getPendingConfirmation(confirmationId)!;
  const rotated = rotatePendingNonce({
    record: pending,
    sessionId: input.session.id,
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    sessionSecret: SESSION_SECRET,
    nonce: seed,
    now: WRITE_PARITY_NOW,
  });
  expect(rotated.ok).toBe(true);
  if (!rotated.ok) throw new Error("rotate failed");
  input.store.updateConfirmationNonceHash(confirmationId, rotated.record.nonceHash);
  return rotated.nonce;
}

describe("v2 confirmation authority matrix", () => {
  it("rejects a wrong role (verifyWriteAuthority denies)", async () => {
    const h = harness({
      verifyWriteAuthority: async () => ({ ok: false as const, status: 403 as const, code: "admin_required" as const, message: "Admin required." }),
    });
    const before = mutationCallTotal(h.fake.counts);
    const { confirmationId } = await prepareTagCreate(h);
    const nonce = await rotatedNonce(h, confirmationId, "role");
    const outcome = await h.confirmation.confirmSingle({
      claims: { sessionId: h.session.id, workspaceId: "ws-1", adminUserId: "admin-1" },
      record: h.store.getPendingConfirmation(confirmationId)!,
      nonce,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("must reject");
    expect(outcome.body.code).toBe("admin_required");
    expect(mutationCallTotal(h.fake.counts) - before).toBe(0);
  });

  it("rejects a denied policy", async () => {
    const deniedPolicy: AdminPolicy = { ...defaultAdminPolicy(), groups: { ...defaultAdminPolicy().groups, work_structure: "off" } };
    const h = harness({ policy: deniedPolicy });
    const before = mutationCallTotal(h.fake.counts);
    const { confirmationId } = await prepareTagCreate(h);
    const nonce = await rotatedNonce(h, confirmationId, "policy");
    const outcome = await h.confirmation.confirmSingle({
      claims: { sessionId: h.session.id, workspaceId: "ws-1", adminUserId: "admin-1" },
      record: h.store.getPendingConfirmation(confirmationId)!,
      nonce,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("must reject");
    expect(outcome.body.code).toBe("policy_denied");
    expect(mutationCallTotal(h.fake.counts) - before).toBe(0);
  });

  it("rejects a stale installation generation", async () => {
    const h = harness();
    const before = mutationCallTotal(h.fake.counts);
    const { confirmationId } = await prepareTagCreate(h);
    const nonce = await rotatedNonce(h, confirmationId, "gen");
    // A different token bumps the installation generation after the preview was created.
    h.store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "u1", addonToken: "token-2" });
    const outcome = await h.confirmation.confirmSingle({
      claims: { sessionId: h.session.id, workspaceId: "ws-1", adminUserId: "admin-1" },
      record: h.store.getPendingConfirmation(confirmationId)!,
      nonce,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("must reject");
    expect(outcome.body.code).toBe("installation_changed");
    expect(mutationCallTotal(h.fake.counts) - before).toBe(0);
  });

  it("rejects a stale target snapshot", async () => {
    const h = harness();
    const before = mutationCallTotal(h.fake.counts);
    const prepared = await h.preparation.prepare(
      [{ id: "tool-archive", name: "clockify_clients_archive", arguments: { id: "c1" } }],
      h.scope,
    );
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") throw new Error("prepare failed");
    const confirmationId = prepared.confirmationIds[0]!;
    // Mutate the client after the preview captured its snapshot.
    h.fake.state.clients = h.fake.state.clients.map((client) =>
      client.id === "c1" ? { ...client, name: "Renamed Behind The Assistant's Back" } : client);
    const nonce = await rotatedNonce(h, confirmationId, "target");
    const outcome = await h.confirmation.confirmSingle({
      claims: { sessionId: h.session.id, workspaceId: "ws-1", adminUserId: "admin-1" },
      record: h.store.getPendingConfirmation(confirmationId)!,
      nonce,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected a synthesized error receipt, not a rejected outcome");
    expect(outcome.receipt.ok).toBe(false);
    if (outcome.receipt.ok) throw new Error("must fail closed on drift");
    expect(outcome.receipt.code).toBe("stale_target");
    expect(mutationCallTotal(h.fake.counts) - before).toBe(0);
  });

  it("rejects a wrong nonce", async () => {
    const h = harness();
    const before = mutationCallTotal(h.fake.counts);
    const { confirmationId } = await prepareTagCreate(h);
    await rotatedNonce(h, confirmationId, "correct-nonce");
    const outcome = await h.confirmation.confirmSingle({
      claims: { sessionId: h.session.id, workspaceId: "ws-1", adminUserId: "admin-1" },
      record: h.store.getPendingConfirmation(confirmationId)!,
      nonce: "totally-wrong-nonce",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("must reject");
    expect(outcome.body.code).toBe("invalid_confirmation");
    expect(mutationCallTotal(h.fake.counts) - before).toBe(0);
  });

  it("rejects a tampered action fingerprint", async () => {
    const h = harness();
    const before = mutationCallTotal(h.fake.counts);
    const { confirmationId } = await prepareTagCreate(h);
    const nonce = await rotatedNonce(h, confirmationId, "action-hash");
    const tampered: PendingConfirmationRecord = {
      ...h.store.getPendingConfirmation(confirmationId)!,
      actionFingerprint: "tampered-fingerprint",
    };
    const outcome = await h.confirmation.confirmSingle({
      claims: { sessionId: h.session.id, workspaceId: "ws-1", adminUserId: "admin-1" },
      record: tampered,
      nonce,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("must reject");
    expect(outcome.body.code).toBe("incompatible_confirmation");
    expect(mutationCallTotal(h.fake.counts) - before).toBe(0);
  });

  it("rejects a wrong registry ID", async () => {
    const h = harness();
    const before = mutationCallTotal(h.fake.counts);
    const { confirmationId } = await prepareTagCreate(h);
    const nonce = await rotatedNonce(h, confirmationId, "registry-id");
    const tampered: PendingConfirmationRecord = {
      ...h.store.getPendingConfirmation(confirmationId)!,
      registryId: "some-other-registry" as never,
    };
    const outcome = await h.confirmation.confirmSingle({
      claims: { sessionId: h.session.id, workspaceId: "ws-1", adminUserId: "admin-1" },
      record: tampered,
      nonce,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("must reject");
    expect(outcome.body.code).toBe("incompatible_confirmation");
    expect(mutationCallTotal(h.fake.counts) - before).toBe(0);
  });

  it("rejects a wrong catalog hash", async () => {
    const h = harness();
    const before = mutationCallTotal(h.fake.counts);
    const { confirmationId } = await prepareTagCreate(h);
    const nonce = await rotatedNonce(h, confirmationId, "catalog-hash");
    const tampered: PendingConfirmationRecord = {
      ...h.store.getPendingConfirmation(confirmationId)!,
      catalogHash: "stale-catalog-hash",
    };
    const outcome = await h.confirmation.confirmSingle({
      claims: { sessionId: h.session.id, workspaceId: "ws-1", adminUserId: "admin-1" },
      record: tampered,
      nonce,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("must reject");
    expect(outcome.body.code).toBe("incompatible_confirmation");
    expect(mutationCallTotal(h.fake.counts) - before).toBe(0);
  });

  it("rejects a tampered operation payload (wrong operation hash)", async () => {
    const h = harness();
    const before = mutationCallTotal(h.fake.counts);
    const { confirmationId } = await prepareTagCreate(h);
    const nonce = await rotatedNonce(h, confirmationId, "op-hash");
    const original = h.store.getPendingConfirmation(confirmationId)!;
    const originalOperation = original.operation as { payload?: Record<string, unknown> };
    const tampered: PendingConfirmationRecord = {
      ...original,
      operation: { ...originalOperation, payload: { ...originalOperation.payload, name: "Tampered Tag Name" } },
    };
    const outcome = await h.confirmation.confirmSingle({
      claims: { sessionId: h.session.id, workspaceId: "ws-1", adminUserId: "admin-1" },
      record: tampered,
      nonce,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("must reject");
    expect(outcome.body.code).toBe("operation_mismatch");
    expect(mutationCallTotal(h.fake.counts) - before).toBe(0);
  });

  it("rejects when the operation journal is not in the prepared state", async () => {
    const h = harness();
    const before = mutationCallTotal(h.fake.counts);
    const { confirmationId, operationId } = await prepareTagCreate(h);
    const nonce = await rotatedNonce(h, confirmationId, "journal");
    // Advance the durable journal without touching the pending_confirmations row.
    expect(h.store.markOperationExecuting(operationId)).toBe(true);
    const outcome = await h.confirmation.confirmSingle({
      claims: { sessionId: h.session.id, workspaceId: "ws-1", adminUserId: "admin-1" },
      record: h.store.getPendingConfirmation(confirmationId)!,
      nonce,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("must reject");
    expect(outcome.body.code).toBe("operation_not_prepared");
    expect(mutationCallTotal(h.fake.counts) - before).toBe(0);
  });

  it("rejects a replay of an already-used confirmation", async () => {
    const h = harness();
    const before = mutationCallTotal(h.fake.counts);
    const { confirmationId } = await prepareTagCreate(h);
    const nonce = await rotatedNonce(h, confirmationId, "replay");
    const first = await h.confirmation.confirmSingle({
      claims: { sessionId: h.session.id, workspaceId: "ws-1", adminUserId: "admin-1" },
      record: h.store.getPendingConfirmation(confirmationId)!,
      nonce,
    });
    expect(first.ok).toBe(true);
    const afterFirst = mutationCallTotal(h.fake.counts);
    expect(afterFirst - before).toBe(1);

    // Same nonce, same confirmation id, replayed — must never dispatch again.
    const second = await h.confirmation.confirmSingle({
      claims: { sessionId: h.session.id, workspaceId: "ws-1", adminUserId: "admin-1" },
      record: h.store.getPendingConfirmation(confirmationId)!,
      nonce,
    });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("must reject replay");
    expect(["not_pending", "already_used"]).toContain(second.body.code);
    expect(mutationCallTotal(h.fake.counts) - afterFirst).toBe(0);
  });

  it("never auto-retries an ambiguous (outcome_unknown) confirmation", async () => {
    const h = harness();
    const before = mutationCallTotal(h.fake.counts);
    const { confirmationId, operationId } = await prepareTagCreate(h);
    const nonce = await rotatedNonce(h, confirmationId, "ambiguous");
    // Simulate a dispatch that started but whose settlement is unknown, without
    // ever calling confirmSingle (which would perform the real dispatch).
    expect(h.store.markConfirmationExecuting(confirmationId)).toBe(true);
    h.store.markOperationExecuting(operationId);
    h.store.settleConfirmedOperation(
      confirmationId,
      "outcome_unknown",
      "clockify_tags_create",
      { ok: false, code: "commit_outcome_unknown", message: "Verify in Clockify before retrying." } as never,
    );
    const outcome = await h.confirmation.confirmSingle({
      claims: { sessionId: h.session.id, workspaceId: "ws-1", adminUserId: "admin-1" },
      record: h.store.getPendingConfirmation(confirmationId)!,
      nonce,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("must never re-dispatch an ambiguous outcome");
    expect(mutationCallTotal(h.fake.counts) - before).toBe(0);
  });
});
