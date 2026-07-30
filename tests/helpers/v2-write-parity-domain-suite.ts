import { afterEach, describe, expect, it } from "vitest";
import { rotatePendingNonce } from "../../src/harness/confirmations.js";
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
  mutationCallTotal,
  unicodeWriteArgs,
  writeActionNames,
  type WriteParityDomain,
} from "./v2-write-parity.js";
import {
  confirmationServiceFor,
  prepareWriteOnce,
  storedReceiptCode as receiptCode,
} from "./v2-write-flows.js";

const stores: ReturnType<typeof createWriteParityStore>[] = [];

/** The shared expect-free flow (`v2-write-flows.ts`), with this suite's
 * store-lifecycle tracking layered on top. */
async function prepareOnce(input: {
  actionName: string;
  args: Record<string, unknown>;
  policyOff?: boolean;
  authClass?: "addon" | "api_key";
}) {
  const result = await prepareWriteOnce(input);
  stores.push(result.store);
  return result;
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

        if (addonUnavailable) {
          it("denies addon preparation and confirms via api_key auth class", async () => {
            const denied = await prepareOnce({
              actionName: action.name,
              args: fixture.args,
              authClass: "addon",
            });
            expect(denied.prepared.kind).toBe("denied");
            if (denied.prepared.kind === "denied") {
              expect(denied.prepared.actionResultId).toBeDefined();
              expect(receiptCode(denied.store, denied.prepared.actionResultId!)).toBe("unavailable_for_auth_class");
              expect(denied.mutationsAfterPrepare - denied.mutationsBefore).toBe(0);
            }

            if (!expectPreview) return;

            const result = await prepareOnce({
              actionName: action.name,
              args: fixture.args,
              authClass: "api_key",
            });
            expect(result.prepared.kind).toBe("prepared");
            if (result.prepared.kind !== "prepared") return;
            expect(result.mutationsAfterPrepare - result.mutationsBefore).toBe(0);
            const confirmationId = result.prepared.confirmationIds[0]!;
            const beforeConfirm = mutationCallTotal(result.fake.counts);
            const outcome = await rotateAndConfirm({
              store: result.store,
              fake: result.fake,
              sessionId: result.session.id,
              confirmationId,
              nonce: `api-key-${action.name}`,
            });
            expect(outcome.ok).toBe(true);
            if (!outcome.ok) return;
            expect(outcome.receipt.ok).toBe(true);
            expect(mutationCallTotal(result.fake.counts) - beforeConfirm).toBe(1);
          });
        } else {
          it("denies policy-off preparation without host mutation", async () => {
            const result = await prepareOnce({
              actionName: action.name,
              args: fixture.args,
              policyOff: true,
            });
            expect(result.prepared.kind).toBe("denied");
            if (result.prepared.kind !== "denied") return;
            expect(result.prepared.actionResultId).toBeDefined();
            expect(receiptCode(result.store, result.prepared.actionResultId!)).toBe("policy_denied");
            expect(result.mutationsAfterPrepare - result.mutationsBefore).toBe(0);
          });
        }

        if (!expectPreview) {
          it("does not prepare a preview under the current fixture constraints", async () => {
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

        if (addonUnavailable) {
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
            const confirmation = result.store.getPendingConfirmation(confirmationId);
            const operation = result.store.getOperationRun(result.prepared.operationIds[0]!);
            const preparedSurface = JSON.stringify({
              preview: confirmation?.preview,
              operation: operation?.operation,
            });
            expect(preparedSurface).toContain("東京");
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
          });
        }
      });
    }
  });
}
