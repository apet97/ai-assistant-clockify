import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { rotatePendingNonce } from "../../src/harness/confirmations.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createOperationPreparationService } from "../../src/services/operation-preparation-service.js";
import { createConfirmationService } from "../../src/services/confirmation-service.js";
import { createWorkspaceMutationCoordinator } from "../../src/clockify/workspace-mutation-coordinator.js";
import { computeRequestHash } from "../../src/assistant-v2/state.js";
import type { WorkspaceClient } from "../../src/clockify/client.js";
import {
  createFakeWorkspace,
  FAKE_MUTATION_METHOD_PATTERN,
  type FakeWorkspaceSeed,
} from "./fake-clockify.js";
import {
  SESSION_SECRET,
  WRITE_PARITY_NOW,
  createWriteParityStore,
  fixtureForWrite,
  mergeWriteSeed,
  mutationCallTotal,
  policyWithGroupOff,
  seedInvoicePaymentExtras,
} from "./v2-write-parity.js";

/**
 * The ONE expect-free prepare/confirm flow composition behind both the seven
 * `v2-write-parity-*` domain suites and the write-safety observation producer
 * (`v2-write-safety-observer.ts`). It composes the REAL production services —
 * `createOperationPreparationService`, `createConfirmationService`, a real
 * SQLite store — over the fake Clockify host, exactly as the parity suites
 * exercise every catalog write. Assertions stay in the callers: this module
 * only runs flows and reports what actually happened, so the observer can turn
 * a misbehaving write into an UNSATISFIED observation instead of a thrown
 * assertion.
 */

export async function prepareWriteOnce(input: {
  actionName: string;
  args: Record<string, unknown>;
  policyOff?: boolean;
  authClass?: "addon" | "api_key";
  /** Optional seed adjustment (e.g. hostile-data injection) applied before the fake is built. */
  mutateSeed?: (seed: FakeWorkspaceSeed) => void;
}) {
  const action = MODEL_API_ACTION_CATALOG.get(input.actionName)!;
  const fixture = fixtureForWrite(input.actionName);
  const seed = mergeWriteSeed(fixture);
  input.mutateSeed?.(seed);
  const fake = createFakeWorkspace(seed);
  seedInvoicePaymentExtras(input.actionName, fake);
  const store = createWriteParityStore();
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

export function confirmationServiceFor(
  store: ReturnType<typeof createWriteParityStore>,
  fake: ReturnType<typeof createFakeWorkspace>,
  options: {
    policy?: ReturnType<typeof defaultAdminPolicy>;
    verifyOk?: boolean;
    /** Substitute host client for the COMMIT path only (e.g. an ambiguity-injecting wrapper). */
    clientOverride?: WorkspaceClient;
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
      clockify: options.clientOverride ?? fake.client,
      now: () => WRITE_PARITY_NOW,
    }),
    mutationCoordinator: createWorkspaceMutationCoordinator(),
    recordUndoIfReversible: () => undefined,
  });
}

/** Wrap the fake host so every mutation-pattern port call fails AFTER dispatch
 * begins — the transport-ambiguity case. Reads pass through untouched. */
export function ambiguousDispatchClient(client: WorkspaceClient, onAttempt: () => void): WorkspaceClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (
        typeof property === "string" &&
        typeof value === "function" &&
        FAKE_MUTATION_METHOD_PATTERN.test(property)
      ) {
        return async () => {
          onAttempt();
          throw new Error("injected ambiguous transport failure");
        };
      }
      return value;
    },
  }) as WorkspaceClient;
}

/** Non-asserting nonce rotation mirroring the session-restore re-arm path. */
export function rotateConfirmationNonce(input: {
  store: ReturnType<typeof createWriteParityStore>;
  sessionId: string;
  confirmationId: string;
  nonce: string;
}): { ok: true; nonce: string } | { ok: false; reason: string } {
  const pending = input.store.getPendingConfirmation(input.confirmationId);
  if (!pending) return { ok: false, reason: "confirmation_missing" };
  const rotated = rotatePendingNonce({
    record: pending,
    sessionId: input.sessionId,
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    sessionSecret: SESSION_SECRET,
    nonce: input.nonce,
    now: WRITE_PARITY_NOW,
  });
  if (!rotated.ok) return { ok: false, reason: rotated.code ?? "rotation_rejected" };
  input.store.updateConfirmationNonceHash(input.confirmationId, rotated.record.nonceHash);
  return { ok: true, nonce: rotated.nonce };
}

/** Read the stored error receipt's code for a denied preparation. Throws when the
 * stored result is not an error receipt — callers treat that as flow failure. */
export function storedReceiptCode(
  store: ReturnType<typeof createWriteParityStore>,
  actionResultId: string,
): string {
  const stored = store.getActionResult(actionResultId);
  if (!stored || typeof stored !== "object" || (stored as { kind?: string }).kind !== "receipt") {
    throw new Error("expected receipt");
  }
  const receipt = (stored as { receipt: { ok: boolean; code?: string } }).receipt;
  if (receipt.ok) throw new Error("expected error receipt");
  return receipt.code ?? "missing";
}
