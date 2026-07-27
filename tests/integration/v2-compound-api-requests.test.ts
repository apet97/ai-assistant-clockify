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
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { rotatePendingNonce } from "../../src/harness/confirmations.js";
import type { SuccessReceipt } from "../../src/harness/receipts.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import { WRITE_PREVIEW_BASE_SEED } from "../helpers/v2-write-preview-fixtures.js";
import { mutationCallTotal, SESSION_SECRET, WRITE_PARITY_NOW } from "../helpers/v2-write-parity.js";

const directories: string[] = [];
const stores: ReturnType<typeof createStore>[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "v2-compound-"));
  directories.push(directory);
  return join(directory, "db.sqlite");
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function harness(seed: Parameters<typeof createFakeWorkspace>[0] = WRITE_PREVIEW_BASE_SEED) {
  const fake = createFakeWorkspace(structuredClone({ ...WRITE_PREVIEW_BASE_SEED, ...seed }));
  const store = createStore(databasePath(), { encryptionKey: "k", now: () => WRITE_PARITY_NOW });
  stores.push(store);
  store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "u1", addonToken: "token" });
  const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
  return { fake, store, session };
}

function startRun(
  store: ReturnType<typeof createStore>,
  sessionId: string,
  runId: string,
  tools: string[],
) {
  const scope = {
    sessionId,
    runId,
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    installationGeneration: 1,
    authClass: "addon" as const,
  };
  store.startRunWithTurn({
    scope,
    originalRequest: `compound ${runId}`,
    requestHash: computeRequestHash(`compound ${runId}`),
    catalogHash: MODEL_API_ACTION_CATALOG.hash(),
    loadedToolNames: tools,
    intentHash: runId,
  });
  return scope;
}

function services(store: ReturnType<typeof createStore>, fake: FakeWorkspace) {
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
    loadPolicy: () => defaultAdminPolicy(),
    verifyWriteAuthority: async () => ({ ok: true as const, installationGeneration: 1 }),
    actionContext: () => ({
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      policy: defaultAdminPolicy(),
      clockify: fake.client,
      now: () => WRITE_PARITY_NOW,
    }),
    mutationCoordinator: createWorkspaceMutationCoordinator(),
    recordUndoIfReversible: () => undefined,
  });
  return { preparation, confirmation };
}

async function prepareConfirmOne(input: {
  store: ReturnType<typeof createStore>;
  fake: FakeWorkspace;
  sessionId: string;
  scope: ReturnType<typeof startRun>;
  actionName: string;
  args: Record<string, unknown>;
  nonce: string;
}): Promise<{ receipt: SuccessReceipt; confirmationId: string; operationId: string }> {
  const { preparation, confirmation } = services(input.store, input.fake);
  const before = mutationCallTotal(input.fake.counts);
  const prepared = await preparation.prepare([{
    id: `tool-${input.nonce}`,
    name: input.actionName,
    arguments: input.args,
  }], input.scope);
  expect(prepared.kind).toBe("prepared");
  if (prepared.kind !== "prepared") throw new Error("prepare failed");
  expect(mutationCallTotal(input.fake.counts) - before).toBe(0);
  expect(prepared.confirmationIds).toHaveLength(1);

  const confirmationId = prepared.confirmationIds[0]!;
  const operationId = prepared.operationIds[0]!;
  const pending = input.store.getPendingConfirmation(confirmationId)!;
  const rotated = rotatePendingNonce({
    record: pending,
    sessionId: input.sessionId,
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    sessionSecret: SESSION_SECRET,
    nonce: input.nonce,
    now: WRITE_PARITY_NOW,
  });
  expect(rotated.ok).toBe(true);
  if (!rotated.ok) throw new Error("rotate failed");
  input.store.updateConfirmationNonceHash(confirmationId, rotated.record.nonceHash);

  const outcome = await confirmation.confirmSingle({
    claims: { sessionId: input.sessionId, workspaceId: "ws-1", adminUserId: "admin-1" },
    record: input.store.getPendingConfirmation(confirmationId)!,
    nonce: rotated.nonce,
  });
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error("confirm failed");
  expect(outcome.receipt.ok).toBe(true);
  if (!outcome.receipt.ok) throw new Error("receipt failed");
  expect(mutationCallTotal(input.fake.counts) - before).toBe(1);
  return { receipt: outcome.receipt, confirmationId, operationId };
}

function createdId(receipt: SuccessReceipt, type: string): string {
  const changed = receipt.changed as { created?: Array<{ type: string; id: string }> } | undefined;
  const hit = changed?.created?.find((row) => row.type === type);
  if (!hit) throw new Error(`missing created ${type} in ${JSON.stringify(receipt)}`);
  return hit.id;
}

describe("v2 compound atomic API journeys", () => {
  it("runs project create → membership replace → member rate as separate confirmations", async () => {
    const { fake, store, session } = harness();
    const scope = startRun(store, session.id, "run-project-chain", [
      "clockify_projects_create",
      "clockify_projects_memberships_replace",
      "clockify_projects_member_hourly_rate_update",
    ]);

    const created = await prepareConfirmOne({
      store, fake, sessionId: session.id, scope,
      actionName: "clockify_projects_create",
      args: { name: "Compound Project" },
      nonce: "project-create",
    });
    const projectId = createdId(created.receipt, "project");

    // Dependent membership cannot prepare against a missing project id before create settles.
    const { preparation } = services(store, fake);
    const premature = await preparation.prepare([{
      id: "tool-premature",
      name: "clockify_projects_memberships_replace",
      arguments: { id: "missing-project", memberships: [{ userId: "admin-1" }] },
    }], scope);
    expect(premature.kind).not.toBe("prepared");

    await prepareConfirmOne({
      store, fake, sessionId: session.id, scope,
      actionName: "clockify_projects_memberships_replace",
      args: { id: projectId, memberships: [{ userId: "admin-1" }] },
      nonce: "project-members",
    });
    await prepareConfirmOne({
      store, fake, sessionId: session.id, scope,
      actionName: "clockify_projects_member_hourly_rate_update",
      args: { projectId, userId: "admin-1", amount: 80 },
      nonce: "project-rate",
    });
  });

  it("runs client base-create then optional-field update as separate confirmations", async () => {
    const { fake, store, session } = harness();
    const scope = startRun(store, session.id, "run-client-chain", [
      "clockify_clients_create_base",
      "clockify_clients_update",
    ]);
    const created = await prepareConfirmOne({
      store, fake, sessionId: session.id, scope,
      actionName: "clockify_clients_create_base",
      args: { name: "Compound Client" },
      nonce: "client-create",
    });
    const clientId = createdId(created.receipt, "client");
    await prepareConfirmOne({
      store, fake, sessionId: session.id, scope,
      actionName: "clockify_clients_update",
      args: { id: clientId, name: "Compound Client Renamed" },
      nonce: "client-update",
    });
  });

  it("runs invoice base → fields update → item add as separate confirmations", async () => {
    const { fake, store, session } = harness();
    const scope = startRun(store, session.id, "run-invoice-chain", [
      "clockify_invoices_create_base",
      "clockify_invoices_fields_update",
      "clockify_invoices_items_add",
    ]);
    const created = await prepareConfirmOne({
      store, fake, sessionId: session.id, scope,
      actionName: "clockify_invoices_create_base",
      args: { clientId: "c1", number: "INV-COMPOUND", currency: "GBP" },
      nonce: "invoice-create",
    });
    const invoiceId = createdId(created.receipt, "invoice");
    await prepareConfirmOne({
      store, fake, sessionId: session.id, scope,
      actionName: "clockify_invoices_fields_update",
      args: { id: invoiceId, note: "Compound note" },
      nonce: "invoice-fields",
    });
    await prepareConfirmOne({
      store, fake, sessionId: session.id, scope,
      actionName: "clockify_invoices_items_add",
      args: { invoiceId, description: "Line", quantity: 1, unitPrice: 50 },
      nonce: "invoice-item",
    });
  });

  it("runs invite then group membership as separate confirmations", async () => {
    const { fake, store, session } = harness();
    const scope = startRun(store, session.id, "run-invite-chain", [
      "clockify_users_invite",
      "clockify_groups_add_member",
    ]);
    const invited = await prepareConfirmOne({
      store, fake, sessionId: session.id, scope,
      actionName: "clockify_users_invite",
      args: { email: "compound@example.com" },
      nonce: "invite",
    });
    const userId = createdId(invited.receipt, "user");
    await prepareConfirmOne({
      store, fake, sessionId: session.id, scope,
      actionName: "clockify_groups_add_member",
      args: { groupId: "g1", userId },
      nonce: "group-add",
    });
  });

  it("creates DAYS and HOURS time-off requests as separate unit-specific writes", async () => {
    const { fake, store, session } = harness();
    const scope = startRun(store, session.id, "run-timeoff", [
      "clockify_time_off_requests_create_days",
      "clockify_time_off_requests_create_hours",
    ]);
    await prepareConfirmOne({
      store, fake, sessionId: session.id, scope,
      actionName: "clockify_time_off_requests_create_days",
      args: { policyId: "pol1", start: "2026-07-01", end: "2026-07-01", days: 1 },
      nonce: "to-days",
    });
    await prepareConfirmOne({
      store, fake, sessionId: session.id, scope,
      actionName: "clockify_time_off_requests_create_hours",
      args: { policyId: "polh", start: "2026-07-01T09:00:00Z", end: "2026-07-01T11:00:00Z" },
      nonce: "to-hours",
    });
  });

  it("confirms two independent existing-target writes in one exact batch", async () => {
    const { fake, store, session } = harness();
    const scope = startRun(store, session.id, "run-independent-batch", [
      "clockify_tags_update",
      "clockify_clients_update",
    ]);
    const { preparation, confirmation } = services(store, fake);
    const before = mutationCallTotal(fake.counts);
    const prepared = await preparation.prepare([
      { id: "tool-a", name: "clockify_tags_update", arguments: { id: "tag1", name: "Renamed Tag" } },
      { id: "tool-b", name: "clockify_clients_update", arguments: { id: "c1", name: "Renamed Acme" } },
    ], scope);
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") return;
    expect(prepared.batchId).toBeTruthy();
    expect(mutationCallTotal(fake.counts) - before).toBe(0);

    const batchId = prepared.batchId!;
    const nonces: string[] = [];
    for (const [index, confirmationId] of prepared.confirmationIds.entries()) {
      const pending = store.getPendingConfirmation(confirmationId)!;
      const rotated = rotatePendingNonce({
        record: pending,
        sessionId: session.id,
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        sessionSecret: SESSION_SECRET,
        nonce: `batch-${index}`,
        now: WRITE_PARITY_NOW,
      });
      expect(rotated.ok).toBe(true);
      if (!rotated.ok) return;
      store.updateConfirmationNonceHash(confirmationId, rotated.record.nonceHash);
      nonces.push(rotated.nonce);
    }

    const outcome = await confirmation.confirmBatch({
      claims: { sessionId: session.id, workspaceId: "ws-1", adminUserId: "admin-1" },
      batchId,
      items: prepared.confirmationIds.map((confirmationId, index) => ({
        confirmationId,
        nonce: nonces[index]!,
      })),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.items).toHaveLength(2);
    expect(outcome.items.every((item) => item.status === "succeeded" && item.receipt.ok)).toBe(true);
    expect(mutationCallTotal(fake.counts) - before).toBe(2);
  });

  it("keeps definitive failure and ambiguity truthful without hiding unfinished work", async () => {
    const { fake, store, session } = harness();
    const scope = startRun(store, session.id, "run-truthful-failure", [
      "clockify_tags_update",
      "clockify_clients_update",
    ]);
    const { preparation, confirmation } = services(store, fake);
    const prepared = await preparation.prepare([
      { id: "tool-ok", name: "clockify_tags_update", arguments: { id: "tag1", name: "Keep Tag" } },
      { id: "tool-bad", name: "clockify_clients_update", arguments: { id: "missing-client", name: "Ghost" } },
    ], scope);
    // Missing client should fail closed at prepare (clarify/deny), never become a confirmable dependent.
    expect(prepared.kind).not.toBe("prepared");

    const alone = await preparation.prepare([{
      id: "tool-alone",
      name: "clockify_tags_update",
      arguments: { id: "tag1", name: "Solo Tag" },
    }], scope);
    expect(alone.kind).toBe("prepared");
    if (alone.kind !== "prepared") return;
    const confirmationId = alone.confirmationIds[0]!;
    const pending = store.getPendingConfirmation(confirmationId)!;
    const rotated = rotatePendingNonce({
      record: pending,
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      sessionSecret: SESSION_SECRET,
      nonce: "solo",
      now: WRITE_PARITY_NOW,
    });
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    store.updateConfirmationNonceHash(confirmationId, rotated.record.nonceHash);

    const previousAtomic = fake.client.updateTagAtomic.bind(fake.client);
    fake.client.updateTagAtomic = async () => {
      throw Object.assign(new Error("host_timeout"), { code: "ETIMEDOUT" });
    };
    const outcome = await confirmation.confirmSingle({
      claims: { sessionId: session.id, workspaceId: "ws-1", adminUserId: "admin-1" },
      record: store.getPendingConfirmation(confirmationId)!,
      nonce: rotated.nonce,
    });
    fake.client.updateTagAtomic = previousAtomic;

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.receipt.ok).toBe(false);
    const operation = store.getOperationRun(alone.operationIds[0]!);
    expect(operation?.status).toMatch(/unknown|failed|partial|outcome_unknown/u);
    expect(store.getPendingConfirmation(confirmationId)?.status).not.toBe("pending");
  });
});
