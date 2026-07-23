import { afterEach, describe, expect, it } from "vitest";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { rotatePendingNonce } from "../../src/harness/confirmations.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createOperationPreparationService } from "../../src/services/operation-preparation-service.js";
import { createConfirmationService } from "../../src/services/confirmation-service.js";
import { createWorkspaceMutationCoordinator } from "../../src/clockify/workspace-mutation-coordinator.js";
import { computeRequestHash } from "../../src/assistant-v2/state.js";
import { createFakeWorkspace } from "./fake-clockify.js";
import {
  SESSION_SECRET,
  WRITE_PARITY_NOW,
  assertFullWriteCatalogNotExposed,
  assertTypedConsentNeverExecutes,
  assertUnknownFieldRejected,
  assertWriteDiscoveryReturnsAction,
  assertWriteDomainFixturesComplete,
  assertWriteLoadedSchemaStrict,
  assertWriteUnavailableHiddenFromDiscovery,
  catalogWritesForDomain,
  createWriteParityStore,
  discoveryQueriesForWrite,
  fixtureForWrite,
  isAddonUnavailableWrite,
  mergeWriteSeed,
  mutationCallTotal,
  policyWithGroupOff,
  seedInvoicePaymentExtras,
  unicodeWriteArgs,
  writeActionNames,
  type WriteParityDomain,
} from "./v2-write-parity.js";

const stores: ReturnType<typeof createWriteParityStore>[] = [];

function trackedStore() {
  const store = createWriteParityStore();
  stores.push(store);
  return store;
}

function receiptCode(store: ReturnType<typeof createWriteParityStore>, actionResultId: string): string {
  const stored = store.getActionResult(actionResultId);
  if (!stored || typeof stored !== "object" || (stored as { kind?: string }).kind !== "receipt") {
    throw new Error("expected receipt");
  }
  const receipt = (stored as { receipt: { ok: boolean; code?: string } }).receipt;
  if (receipt.ok) throw new Error("expected error receipt");
  return receipt.code ?? "missing";
}

async function prepareOnce(input: {
  actionName: string;
  args: Record<string, unknown>;
  policyOff?: boolean;
  authClass?: "addon" | "api_key";
}) {
  const action = MODEL_API_ACTION_CATALOG.get(input.actionName)!;
  const fixture = fixtureForWrite(input.actionName);
  const fake = createFakeWorkspace(mergeWriteSeed(fixture));
  seedInvoicePaymentExtras(input.actionName, fake);
  const store = trackedStore();
  store.saveInstallation({
    workspaceId: "ws-1",
    addonId: "addon-1",
    addonUserId: "u1",
    addonToken: "token",
  });
  const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
  const runId = `run-${input.actionName}-${Math.random().toString(16).slice(2, 8)}`;
  const scope = {
    sessionId: session.id,
    runId,
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    installationGeneration: 1,
    authClass: (input.authClass ?? "addon") as "addon" | "api_key",
  };
  store.startRunWithTurn({
    scope,
    originalRequest: `write ${input.actionName}`,
    requestHash: computeRequestHash(`write ${input.actionName}`),
    catalogHash: MODEL_API_ACTION_CATALOG.hash(),
    loadedToolNames: [input.actionName],
    intentHash: runId,
  });

  const policy = input.policyOff ? policyWithGroupOff(action.featureGroup) : defaultAdminPolicy();
  const preparation = createOperationPreparationService({
    store,
    registry: MODEL_API_ACTION_CATALOG,
    sessionSecret: SESSION_SECRET,
    clockifyForScope: () => fake.client,
    now: () => WRITE_PARITY_NOW,
    loadCalendarContext: async () => ({ timeZone: "UTC", weekStartsOn: 1 }),
    getAdminPolicy: () => policy,
  });

  const mutationsBefore = mutationCallTotal(fake.counts);
  const prepared = await preparation.prepare([{
    id: "tool-1",
    name: input.actionName,
    arguments: input.args,
  }], scope);

  return {
    action,
    fake,
    store,
    session,
    scope,
    prepared,
    mutationsBefore,
    mutationsAfterPrepare: mutationCallTotal(fake.counts),
    policy,
  };
}

function confirmationServiceFor(
  store: ReturnType<typeof createWriteParityStore>,
  fake: ReturnType<typeof createFakeWorkspace>,
  options: {
    policy?: ReturnType<typeof defaultAdminPolicy>;
    verifyOk?: boolean;
  } = {},
) {
  const policy = options.policy ?? defaultAdminPolicy();
  return createConfirmationService({
    store,
    registry: MODEL_API_ACTION_CATALOG,
    sessionSecret: SESSION_SECRET,
    catalogHash: () => MODEL_API_ACTION_CATALOG.hash(),
    now: () => WRITE_PARITY_NOW,
    loadPolicy: () => policy,
    verifyWriteAuthority: async () => options.verifyOk === false
      ? {
          ok: false as const,
          status: 403 as const,
          code: "admin_required" as const,
          message: "Admin role required.",
        }
      : { ok: true as const, installationGeneration: 1 },
    actionContext: () => ({
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      policy,
      clockify: fake.client,
      now: () => WRITE_PARITY_NOW,
    }),
    mutationCoordinator: createWorkspaceMutationCoordinator(),
    recordUndoIfReversible: () => undefined,
  });
}

async function rotateAndConfirm(input: {
  store: ReturnType<typeof createWriteParityStore>;
  fake: ReturnType<typeof createFakeWorkspace>;
  sessionId: string;
  confirmationId: string;
  nonce: string;
  verifyOk?: boolean;
}) {
  const pending = input.store.getPendingConfirmation(input.confirmationId)!;
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
  input.store.updateConfirmationNonceHash(input.confirmationId, rotated.record.nonceHash);
  const service = confirmationServiceFor(input.store, input.fake, { verifyOk: input.verifyOk });
  return service.confirmSingle({
    claims: { sessionId: input.sessionId, workspaceId: "ws-1", adminUserId: "admin-1" },
    record: input.store.getPendingConfirmation(input.confirmationId)!,
    nonce: rotated.nonce,
  });
}

export function registerWriteParityDomainSuite(domain: WriteParityDomain): void {
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  describe(`v2 ${domain} write parity matrix`, () => {
    assertWriteDomainFixturesComplete(domain);
    const writes = catalogWritesForDomain(domain);

    it(`covers every catalog ${domain} write row`, () => {
      expect(writes.map((action) => action.name).sort()).toEqual(writeActionNames(domain));
    });

    it("never exposes the full model catalog through initial load", () => {
      assertFullWriteCatalogNotExposed();
    });

    it("rejects typed consent as execution authority", () => {
      assertTypedConsentNeverExecutes();
    });

    for (const action of writes) {
      describe(action.name, () => {
        const fixture = fixtureForWrite(action.name);
        const queries = discoveryQueriesForWrite(action);
        const addonUnavailable = isAddonUnavailableWrite(action);
        const expectPreview = fixture.expectPreview !== false;

        if (addonUnavailable) {
          it("is absent from addon discovery", () => {
            assertWriteUnavailableHiddenFromDiscovery(action.name);
          });
        } else {
          it("discovers via canonical, paraphrase, and one-character typo queries", () => {
            assertWriteDiscoveryReturnsAction(action.name, queries.canonical);
            assertWriteDiscoveryReturnsAction(action.name, queries.paraphrase);
            assertWriteDiscoveryReturnsAction(action.name, queries.typo);
          });
        }

        it("exposes only a strict loaded schema", () => {
          if (addonUnavailable) return;
          assertWriteLoadedSchemaStrict(action.name);
        });

        it("rejects unknown fields before preparation", () => {
          assertUnknownFieldRejected(action, fixture.args);
        });

        it("denies policy-off preparation without host mutation", async () => {
          if (addonUnavailable) {
            const result = await prepareOnce({
              actionName: action.name,
              args: fixture.args,
              authClass: "addon",
            });
            expect(result.prepared.kind).toBe("denied");
            if (result.prepared.kind !== "denied") return;
            expect(receiptCode(result.store, result.prepared.actionResultId)).toBe("unavailable_for_auth_class");
            expect(result.mutationsAfterPrepare - result.mutationsBefore).toBe(0);
            return;
          }

          const result = await prepareOnce({
            actionName: action.name,
            args: fixture.args,
            policyOff: true,
          });
          expect(result.prepared.kind).toBe("denied");
          if (result.prepared.kind !== "denied") return;
          expect(receiptCode(result.store, result.prepared.actionResultId)).toBe("policy_denied");
          expect(result.mutationsAfterPrepare - result.mutationsBefore).toBe(0);
        });

        if (!expectPreview || addonUnavailable) {
          it("does not prepare a preview under the current fixture/auth constraints", async () => {
            if (addonUnavailable) return;
            const result = await prepareOnce({
              actionName: action.name,
              args: fixture.args,
            });
            expect(result.prepared.kind).not.toBe("prepared");
            expect(result.mutationsAfterPrepare - result.mutationsBefore).toBe(0);
          });
          return;
        }

        it("prepares exact preview material with zero host mutations", async () => {
          const result = await prepareOnce({
            actionName: action.name,
            args: fixture.args,
          });
          expect(result.prepared.kind).toBe("prepared");
          if (result.prepared.kind !== "prepared") return;
          expect(result.mutationsAfterPrepare - result.mutationsBefore).toBe(0);

          const operationId = result.prepared.operationIds[0]!;
          const confirmationId = result.prepared.confirmationIds[0]!;
          const operation = result.store.getOperationRun(operationId);
          const confirmation = result.store.getPendingConfirmation(confirmationId);

          expect(operation?.status).toBe("prepared");
          expect(operation?.origin).toBe("assistant");
          expect(operation?.registryId).toBe("v2-api");
          expect(operation?.authorityModel).toBe("preview_confirmation_v2");
          expect(operation?.capabilityId).toBeUndefined();
          expect(operation?.mutationPlan?.steps.filter((step) => step.kind === "primary")).toHaveLength(1);
          expect(operation?.fieldProvenanceHash).toMatch(/^[a-f0-9]{64}$/u);

          expect(confirmation?.status).toBe("pending");
          expect(confirmation?.origin).toBe("assistant");
          expect(confirmation?.registryId).toBe("v2-api");
          expect(confirmation?.authorityModel).toBe("preview_confirmation_v2");
          expect(confirmation?.capabilityId).toBeUndefined();
          expect(confirmation?.preview).toBeTruthy();
        });

        it("confirms with button nonce for exactly one primary mutation", async () => {
          const result = await prepareOnce({
            actionName: action.name,
            args: fixture.args,
          });
          expect(result.prepared.kind).toBe("prepared");
          if (result.prepared.kind !== "prepared") return;

          const confirmationId = result.prepared.confirmationIds[0]!;
          const beforeConfirm = mutationCallTotal(result.fake.counts);
          const outcome = await rotateAndConfirm({
            store: result.store,
            fake: result.fake,
            sessionId: result.session.id,
            confirmationId,
            nonce: `nonce-${action.name}`,
          });
          expect(outcome.ok).toBe(true);
          if (!outcome.ok) return;
          expect(outcome.receipt.ok).toBe(true);
          expect(mutationCallTotal(result.fake.counts) - beforeConfirm).toBe(1);
          expect(result.store.getPendingConfirmation(confirmationId)?.status).toBe("succeeded");
        });

        it("rejects fresh role failure at confirmation time", async () => {
          const result = await prepareOnce({
            actionName: action.name,
            args: fixture.args,
          });
          expect(result.prepared.kind).toBe("prepared");
          if (result.prepared.kind !== "prepared") return;

          const confirmationId = result.prepared.confirmationIds[0]!;
          const beforeConfirm = mutationCallTotal(result.fake.counts);
          const outcome = await rotateAndConfirm({
            store: result.store,
            fake: result.fake,
            sessionId: result.session.id,
            confirmationId,
            nonce: `role-${action.name}`,
            verifyOk: false,
          });
          expect(outcome.ok).toBe(false);
          if (outcome.ok) return;
          expect(outcome.body.code).toBe("admin_required");
          expect(mutationCallTotal(result.fake.counts) - beforeConfirm).toBe(0);
        });

        it("rejects typed consent and duplicate confirmation replay", async () => {
          const result = await prepareOnce({
            actionName: action.name,
            args: fixture.args,
          });
          expect(result.prepared.kind).toBe("prepared");
          if (result.prepared.kind !== "prepared") return;

          const confirmationId = result.prepared.confirmationIds[0]!;
          const service = confirmationServiceFor(result.store, result.fake);
          const pending = result.store.getPendingConfirmation(confirmationId)!;
          const typed = await service.confirmSingle({
            claims: { sessionId: result.session.id, workspaceId: "ws-1", adminUserId: "admin-1" },
            record: pending,
            nonce: "yes",
          });
          expect(typed.ok).toBe(false);

          const first = await rotateAndConfirm({
            store: result.store,
            fake: result.fake,
            sessionId: result.session.id,
            confirmationId,
            nonce: `once-${action.name}`,
          });
          expect(first.ok).toBe(true);

          const second = await service.confirmSingle({
            claims: { sessionId: result.session.id, workspaceId: "ws-1", adminUserId: "admin-1" },
            record: result.store.getPendingConfirmation(confirmationId)!,
            nonce: `once-${action.name}`,
          });
          expect(second.ok).toBe(false);
        });

        it("keeps concurrent confirmation single-flight", async () => {
          const result = await prepareOnce({
            actionName: action.name,
            args: fixture.args,
          });
          expect(result.prepared.kind).toBe("prepared");
          if (result.prepared.kind !== "prepared") return;

          const confirmationId = result.prepared.confirmationIds[0]!;
          const pending = result.store.getPendingConfirmation(confirmationId)!;
          const rotated = rotatePendingNonce({
            record: pending,
            sessionId: result.session.id,
            workspaceId: "ws-1",
            adminUserId: "admin-1",
            sessionSecret: SESSION_SECRET,
            nonce: `concurrent-${action.name}`,
            now: WRITE_PARITY_NOW,
          });
          expect(rotated.ok).toBe(true);
          if (!rotated.ok) return;
          result.store.updateConfirmationNonceHash(confirmationId, rotated.record.nonceHash);

          const service = confirmationServiceFor(result.store, result.fake);
          const claims = { sessionId: result.session.id, workspaceId: "ws-1", adminUserId: "admin-1" };
          const record = result.store.getPendingConfirmation(confirmationId)!;
          const [left, right] = await Promise.all([
            service.confirmSingle({ claims, record, nonce: rotated.nonce }),
            service.confirmSingle({ claims, record, nonce: rotated.nonce }),
          ]);
          const wins = [left, right].filter((outcome) => outcome.ok);
          const losses = [left, right].filter((outcome) => !outcome.ok);
          expect(wins).toHaveLength(1);
          expect(losses).toHaveLength(1);
          expect(mutationCallTotal(result.fake.counts) - result.mutationsAfterPrepare).toBe(1);
        });

        if ("name" in fixture.args || "description" in fixture.args || "notes" in fixture.args) {
          it("preserves Unicode write arguments through prepare and confirm", async () => {
            const args = unicodeWriteArgs(action.name, fixture.args);
            const result = await prepareOnce({
              actionName: action.name,
              args,
            });
            expect(result.prepared.kind).toBe("prepared");
            if (result.prepared.kind !== "prepared") return;
            const confirmationId = result.prepared.confirmationIds[0]!;
            const outcome = await rotateAndConfirm({
              store: result.store,
              fake: result.fake,
              sessionId: result.session.id,
              confirmationId,
              nonce: `unicode-${action.name}`,
            });
            expect(outcome.ok).toBe(true);
            if (!outcome.ok) return;
            expect(outcome.receipt.ok).toBe(true);
            const serialized = JSON.stringify(outcome.receipt);
            expect(serialized).toContain("東京");
          });
        }
      });
    }
  });
}
