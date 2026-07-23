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
import { executeTrustedDirectV2SafeWrite } from "../../src/harness/actions.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import {
  WRITE_PREVIEW_BASE_SEED,
  WRITE_PREVIEW_FIXTURES,
  catalogWriteActionNames,
  type WritePreviewFixture,
} from "../helpers/v2-write-preview-fixtures.js";
import { validateV2RawActionArguments } from "../../src/harness/actions.js";

const SESSION_SECRET = "test-session-secret";
const NOW = new Date("2026-06-06T12:00:00.000Z");
const directories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "v2-preview-matrix-"));
  directories.push(directory);
  return join(directory, "db.sqlite");
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const MUTATION_METHOD = /^(?:add|archive|create|deactivate|delete|import|invite|mark|publish|remove|resubmit|set|start|stop|submit|update)/;

function mutationCallTotal(counts: Record<string, number>): number {
  return Object.entries(counts).reduce((sum, [method, count]) =>
    (MUTATION_METHOD.test(method) ? sum + count : sum), 0);
}

function catalogWrites() {
  return MODEL_API_ACTION_CATALOG.actions.filter((action) => action.apiOperation?.access === "write");
}

function mergeSeed(fixture: WritePreviewFixture) {
  return structuredClone({ ...WRITE_PREVIEW_BASE_SEED, ...fixture.seed });
}

function seedExtras(actionName: string, fake: ReturnType<typeof createFakeWorkspace>): void {
  if (actionName === "clockify_invoices_payments_delete") {
    fake.state.invoicePayments.inv1 = [{
      id: "pay1",
      amount: 10000,
      paymentDate: "2026-06-06T00:00:00.000Z",
    }];
  }
}

describe("v2 preview-first write matrix", () => {
  it("covers every model-api write action with a fixture", () => {
    const writes = catalogWrites();
    const missing = writes.filter((action) => !WRITE_PREVIEW_FIXTURES[action.name]);
    expect(missing.map((action) => action.name), "missing write preview fixtures").toEqual([]);
    expect(catalogWriteActionNames().length).toBe(writes.length);
  });

  it.each(catalogWriteActionNames())("prepares %s without Clockify mutations", async (actionName) => {
    const fixture = WRITE_PREVIEW_FIXTURES[actionName]!;
    if (fixture.expectPreview === false) return;

    const action = MODEL_API_ACTION_CATALOG.get(actionName);
    expect(action).toBeDefined();

    expect(validateV2RawActionArguments(action!, { ...fixture.args, provenance: { "/x": "y" } })?.code)
      .toBe("invalid_args");

    const fake = createFakeWorkspace(mergeSeed(fixture));
    seedExtras(actionName, fake);
    const mutationsBefore = mutationCallTotal(fake.counts);

    const store = createStore(databasePath(), { encryptionKey: "k", now: () => NOW });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    store.startRunWithTurn({
      scope: {
        sessionId: session.id,
        runId: "run-preview",
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        installationGeneration: 1,
        authClass: "addon",
      },
      originalRequest: `prepare ${actionName}`,
      requestHash: computeRequestHash(`prepare ${actionName}`),
      catalogHash: MODEL_API_ACTION_CATALOG.hash(),
      loadedToolNames: [actionName],
      intentHash: "intent-preview",
    });

    const scope = {
      sessionId: session.id,
      runId: "run-preview",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      installationGeneration: 1,
      authClass: "addon" as const,
    };

    const preparation = createOperationPreparationService({
      store,
      registry: MODEL_API_ACTION_CATALOG,
      sessionSecret: SESSION_SECRET,
      clockifyForScope: () => fake.client,
      now: () => NOW,
      loadCalendarContext: async () => ({ timeZone: "UTC", weekStartsOn: 1 }),
    });

    const outcome = await preparation.prepare([{
      id: "tool-1",
      name: actionName,
      arguments: fixture.args,
    }], scope);

    expect(outcome.kind).toBe("prepared");
    if (outcome.kind !== "prepared") return;

    expect(mutationCallTotal(fake.counts) - mutationsBefore).toBe(0);

    const run = store.getRun(scope);
    expect(run?.budget.hostCallsReserved).toBeGreaterThan(0);

    const operationId = outcome.operationIds[0]!;
    const confirmationId = outcome.confirmationIds[0]!;
    const operation = store.getOperationRun(operationId);
    expect(operation?.status).toBe("prepared");
    expect(operation?.origin).toBe("assistant");
    expect(operation?.registryId).toBe("v2-api");
    expect(operation?.authorityModel).toBe("preview_confirmation_v2");
    expect(operation?.capabilityId).toBeUndefined();
    expect(operation?.mutationPlan?.steps.filter((step) => step.kind === "primary")).toHaveLength(1);

    const confirmation = store.getPendingConfirmation(confirmationId);
    expect(confirmation?.status).toBe("pending");
    expect(confirmation?.origin).toBe("assistant");
    expect(confirmation?.registryId).toBe("v2-api");
    expect(confirmation?.authorityModel).toBe("preview_confirmation_v2");
    expect(confirmation?.capabilityId).toBeUndefined();
    expect(operation?.fieldProvenanceHash).toMatch(/^[a-f0-9]{64}$/u);

    store.close();
  });

  it("confirms a prepared safe write through the stored executor without re-preparing", async () => {
    const actionName = "clockify_tags_create";
    const fixture = WRITE_PREVIEW_FIXTURES[actionName]!;
    const fake = createFakeWorkspace(mergeSeed(fixture));
    const mutationsBefore = mutationCallTotal(fake.counts);

    const store = createStore(databasePath(), { encryptionKey: "k", now: () => NOW });
    store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "u1", addonToken: "token" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    store.startRunWithTurn({
      scope: {
        sessionId: session.id,
        runId: "run-confirm",
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        installationGeneration: 1,
        authClass: "addon",
      },
      originalRequest: `confirm ${actionName}`,
      requestHash: computeRequestHash(`confirm ${actionName}`),
      catalogHash: MODEL_API_ACTION_CATALOG.hash(),
      loadedToolNames: [actionName],
      intentHash: "intent-confirm",
    });

    const scope = {
      sessionId: session.id,
      runId: "run-confirm",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      installationGeneration: 1,
      authClass: "addon" as const,
    };

    const preparation = createOperationPreparationService({
      store,
      registry: MODEL_API_ACTION_CATALOG,
      sessionSecret: SESSION_SECRET,
      clockifyForScope: () => fake.client,
      now: () => NOW,
      loadCalendarContext: async () => ({ timeZone: "UTC", weekStartsOn: 1 }),
    });

    const prepared = await preparation.prepare([{
      id: "tool-confirm",
      name: actionName,
      arguments: fixture.args,
    }], scope);
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") return;

    const confirmationId = prepared.confirmationIds[0]!;
    const pending = store.getPendingConfirmation(confirmationId)!;
    const rotated = rotatePendingNonce({
      record: pending,
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      sessionSecret: SESSION_SECRET,
      nonce: "confirm-nonce",
      now: NOW,
    });
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    store.updateConfirmationNonceHash(confirmationId, rotated.record.nonceHash);

    const confirmationService = createConfirmationService({
      store,
      registry: MODEL_API_ACTION_CATALOG,
      sessionSecret: SESSION_SECRET,
      catalogHash: () => MODEL_API_ACTION_CATALOG.hash(),
      now: () => NOW,
      loadPolicy: () => defaultAdminPolicy(),
      verifyWriteAuthority: async () => ({ ok: true as const, installationGeneration: 1 }),
      actionContext: (_workspaceId, _adminUserId) => ({
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        policy: defaultAdminPolicy(),
        clockify: fake.client,
        now: () => NOW,
      }),
      mutationCoordinator: createWorkspaceMutationCoordinator(),
      recordUndoIfReversible: () => undefined,
    });

    const outcome = await confirmationService.confirmSingle({
      claims: { sessionId: session.id, workspaceId: "ws-1", adminUserId: "admin-1" },
      record: store.getPendingConfirmation(confirmationId)!,
      nonce: rotated.nonce,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.receipt.ok).toBe(true);
    expect(mutationCallTotal(fake.counts) - mutationsBefore).toBe(1);
    expect(store.getPendingConfirmation(confirmationId)?.status).toBe("succeeded");
    store.close();
  });

  it("rejects trusted direct execution without an explicit origin", async () => {
    const fake = createFakeWorkspace();
    const result = await executeTrustedDirectV2SafeWrite({
      origin: "assistant",
      registryId: "v2-api",
      actionName: "clockify_tags_create",
      args: { name: "Direct Tag" },
      context: {
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        policy: defaultAdminPolicy(),
        clockify: fake.client,
        now: () => NOW,
      },
    });
    expect(result.kind).toBe("receipt");
    if (result.kind !== "receipt") return;
    expect(result.receipt.ok).toBe(false);
    if (result.receipt.ok) return;
    expect(result.receipt.code).toBe("invalid_origin");
  });
});
