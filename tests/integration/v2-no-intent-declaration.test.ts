import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeRequestHash } from "../../src/assistant-v2/state.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { createStore } from "../../src/db/store.js";
import { createOperationPreparationService } from "../../src/services/operation-preparation-service.js";
import { createConfirmationService } from "../../src/services/confirmation-service.js";
import { createWorkspaceMutationCoordinator } from "../../src/clockify/workspace-mutation-coordinator.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { rotatePendingNonce } from "../../src/harness/confirmations.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import * as intentDeclaration from "../../src/assistant/intent-declaration.js";

const directories: string[] = [];
const stores: ReturnType<typeof createStore>[] = [];
const SESSION_SECRET = "test-session-secret";
const NOW = new Date("2026-06-06T12:00:00.000Z");

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "v2-no-declaration-"));
  directories.push(directory);
  return join(directory, "db.sqlite");
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function harness() {
  const fake = createFakeWorkspace({});
  const store = createStore(databasePath(), { encryptionKey: "k", now: () => NOW });
  stores.push(store);
  store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "u1", addonToken: "token" });
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
    originalRequest: "create a tag named Preview Tag",
    requestHash: computeRequestHash("create a tag named Preview Tag"),
    catalogHash: MODEL_API_ACTION_CATALOG.hash(),
    loadedToolNames: ["clockify_tags_create"],
    intentHash: scope.runId,
  });
  const preparation = createOperationPreparationService({
    store,
    registry: MODEL_API_ACTION_CATALOG,
    sessionSecret: SESSION_SECRET,
    clockifyForScope: () => fake.client,
    now: () => NOW,
    loadCalendarContext: async () => ({ timeZone: "UTC", weekStartsOn: 1 }),
  });
  const confirmation = createConfirmationService({
    store,
    registry: MODEL_API_ACTION_CATALOG,
    sessionSecret: SESSION_SECRET,
    catalogHash: () => MODEL_API_ACTION_CATALOG.hash(),
    now: () => NOW,
    loadPolicy: () => defaultAdminPolicy(),
    verifyWriteAuthority: async () => ({ ok: true as const, installationGeneration: 1 }),
    actionContext: () => ({
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      policy: defaultAdminPolicy(),
      clockify: fake.client,
      now: () => NOW,
    }),
    mutationCoordinator: createWorkspaceMutationCoordinator(),
    recordUndoIfReversible: () => undefined,
  });
  return { fake, store, session, scope, preparation, confirmation };
}

describe("v2 bypasses intent declaration and capabilities", () => {
  it("prepares and confirms a v2 write with zero declaration calls and zero capability rows/claims", async () => {
    const declareSpy = vi.spyOn(intentDeclaration, "declareIntentCapability");
    const { store, session, scope, preparation, confirmation } = harness();
    const createSpy = vi.spyOn(store, "createIntentCapability");
    const bindSpy = vi.spyOn(store, "bindIntentCapabilityOperation");
    const consumeExecSpy = vi.spyOn(store, "consumeIntentCapabilityExecution");
    const consumeOpSpy = vi.spyOn(store, "consumeIntentCapabilityForOperation");
    const getForOpSpy = vi.spyOn(store, "getIntentCapabilityForOperation");

    const prepared = await preparation.prepare(
      [{ id: "tool-1", name: "clockify_tags_create", arguments: { name: "Preview Tag" } }],
      scope,
    );
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") throw new Error("prepare failed");
    const confirmationId = prepared.confirmationIds[0]!;
    const operationId = prepared.operationIds[0]!;

    const operationRun = store.getOperationRun(operationId);
    expect(operationRun?.authorityModel).toBe("preview_confirmation_v2");

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
    if (!rotated.ok) throw new Error("rotate failed");
    store.updateConfirmationNonceHash(confirmationId, rotated.record.nonceHash);

    const outcome = await confirmation.confirmSingle({
      claims: { sessionId: session.id, workspaceId: "ws-1", adminUserId: "admin-1" },
      record: store.getPendingConfirmation(confirmationId)!,
      nonce: rotated.nonce,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("confirm failed");
    expect(outcome.receipt.ok).toBe(true);

    expect(declareSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(bindSpy).not.toHaveBeenCalled();
    expect(consumeExecSpy).not.toHaveBeenCalled();
    expect(consumeOpSpy).not.toHaveBeenCalled();
    expect(getForOpSpy).not.toHaveBeenCalled();

    const finalRun = store.getOperationRun(operationId);
    expect(finalRun?.authorityModel).toBe("preview_confirmation_v2");
    expect(finalRun?.capabilityId).toBeUndefined();
    expect(finalRun?.capabilityHash).toBeUndefined();
  });
});
