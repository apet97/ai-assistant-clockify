import type { ActionContext, ActionResult, AtomicIdempotencyLedger, CommitResult, ConfirmableOperation, ExternalMutationPlan } from "../harness/action.js";
import { isPartialCommitResult } from "../harness/action.js";
import type { ActionOrigin, RegistryId } from "../harness/action-discriminators.js";
import {
  accessDeniedMessage,
  executeStoredV2Write,
  executeTrustedDirectV2SafeWrite,
} from "../harness/actions.js";
import { actionFingerprintForDefinition } from "../harness/catalog.js";
import type { ActionRegistry } from "../harness/api-catalog.js";
import {
  confirmPending,
  hashOperation,
  isBatchOwnedConfirmation,
  isTrustedDirectOrigin,
  isV2AssistantPreviewConfirmation,
  type PendingConfirmationRecord,
} from "../harness/confirmations.js";
import { canWrite } from "../harness/permissions.js";
import type { AdminPolicy } from "../harness/permissions.js";
import { errorReceipt, type ErrorReceipt, type SuccessReceipt } from "../harness/receipts.js";
import type { EntityRef } from "../harness/receipts.js";
import { reverseCreationDurably, undoMutationPlan } from "../harness/undo.js";
import type { Store } from "../db/store.js";
import type { ActionResultRef } from "../db/store.js";
import type { Installation } from "../db/store/context.js";
import { CLAIM_TTL_MS } from "../db/store.js";
import type { WorkspaceMutationCoordinator, WorkspaceMutationLease } from "../clockify/workspace-mutation-coordinator.js";
import { WorkspaceMutationRevokedError } from "../clockify/workspace-mutation-coordinator.js";
import { IDEMPOTENCY_WINDOW_MS } from "../routes/chat-constants.js";
import type { WriteAuthorityOutcome } from "../routes/route-authority.js";

export type ConfirmSingleOutcome =
  | { ok: false; status: number; body: { ok: false; code: string; message: string } }
  | {
      ok: true;
      receipt: SuccessReceipt | ErrorReceipt;
      partialResult?: Extract<ActionResult, { kind: "partial" }>;
      undoId: string | undefined;
      agentState: undefined;
      installation: Installation;
      persistenceDegraded?: true;
    };

export interface ConfirmationServiceClaims {
  sessionId: string;
  workspaceId: string;
  adminUserId: string;
}

export interface ConfirmSingleInput {
  claims: ConfirmationServiceClaims;
  record: PendingConfirmationRecord;
  nonce: string;
  signal?: AbortSignal;
}

export interface TrustedDirectSafeWriteInput {
  origin: ActionOrigin;
  registryId: RegistryId;
  actionName: string;
  args: unknown;
  context: ActionContext;
  installationGeneration?: number;
}

export interface UndoCommitInput {
  claims: ConfirmationServiceClaims;
  undoId: string;
  record: {
    id: string;
    sessionId: string;
    workspaceId: string;
    adminUserId: string;
    installationGeneration?: number;
    reversal: EntityRef[];
  };
  context: ActionContext;
  signal?: AbortSignal;
}

export interface UndoCommitOutcome {
  receipt: SuccessReceipt | ErrorReceipt;
  remaining: EntityRef[];
  status: "partially_undone" | "undone" | "failed" | "outcome_unknown";
  operationId: string;
  resultRef?: ActionResultRef;
  persistenceDegraded?: true;
}

export interface ConfirmationServiceDeps {
  store: Store;
  registry: ActionRegistry;
  sessionSecret: string;
  catalogHash: () => string;
  now: () => Date;
  loadPolicy: (workspaceId: string, adminUserId: string) => AdminPolicy;
  verifyWriteAuthority: (
    claims: ConfirmationServiceClaims,
    installation?: Installation,
    signal?: AbortSignal,
  ) => Promise<WriteAuthorityOutcome>;
  actionContext: (
    workspaceId: string,
    adminUserId: string,
    installation: Installation,
    sessionId?: string,
    signal?: AbortSignal,
  ) => ActionContext;
  mutationCoordinator: WorkspaceMutationCoordinator;
  recordUndoIfReversible: (
    claims: ConfirmationServiceClaims,
    installationGeneration: number,
    receipt: SuccessReceipt | ErrorReceipt,
  ) => string | undefined;
}

function storedPlannedOperation(
  operation: ConfirmableOperation,
): operation is ConfirmableOperation & { mutationPlan: ExternalMutationPlan } {
  return !!operation.mutationPlan;
}

function reject(status: number, code: string, message: string): ConfirmSingleOutcome {
  return { ok: false, status, body: { ok: false, code, message } };
}

function actionFingerprint(registry: ActionRegistry, actionName: string): string {
  const action = registry.get(actionName);
  return action ? actionFingerprintForDefinition(action) : hashOperation({ actionName, version: 1 });
}

export function createConfirmationService(deps: ConfirmationServiceDeps) {
  function atomicLedger(
    claims: ConfirmationServiceClaims,
    confirmationId: string,
  ): AtomicIdempotencyLedger {
    const t = () => deps.now().getTime();
    return {
      lookup: (key) => deps.store.lookupIdempotency(
        key,
        claims.workspaceId,
        claims.adminUserId,
        t() - IDEMPOTENCY_WINDOW_MS,
      ),
      record: () => undefined,
      claim: (key) => {
        const state = deps.store.claimIdempotency(
          key,
          claims.workspaceId,
          claims.adminUserId,
          t(),
          t() - IDEMPOTENCY_WINDOW_MS,
          t() - CLAIM_TTL_MS,
        );
        if (state === "won") {
          try {
            deps.store.bindConfirmationIdempotencyKey(confirmationId, key);
          } catch (error) {
            deps.store.releaseIdempotency(key, claims.workspaceId, claims.adminUserId);
            throw error;
          }
        }
        return state;
      },
      lookupCompleted: (key) => deps.store.claimIdempotencyReceipt(key, claims.workspaceId, claims.adminUserId),
      fill: () => undefined,
      release: (key) => deps.store.releaseConfirmationIdempotencyKey(confirmationId, key),
      touch: (key) => deps.store.touchIdempotencyClaim(key, claims.workspaceId, claims.adminUserId, t()),
    };
  }

  async function confirmSingle(input: ConfirmSingleInput): Promise<ConfirmSingleOutcome> {
    const { claims, record, nonce, signal } = input;

    if (isBatchOwnedConfirmation(record)) {
      return reject(
        400,
        "batch_confirmation_required",
        "This preview belongs to a Confirm all batch. Use the batch confirmation route.",
      );
    }
    if (!isV2AssistantPreviewConfirmation(record)) {
      return reject(
        400,
        "incompatible_confirmation",
        "This preview is not a v2 assistant confirmation.",
      );
    }

    const validation = confirmPending({
      record,
      sessionId: claims.sessionId,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      nonce,
      sessionSecret: deps.sessionSecret,
      now: deps.now(),
      expectedActionFingerprint: actionFingerprint(deps.registry, (record.operation as ConfirmableOperation).actionName),
      expectedCatalogHash: deps.catalogHash(),
    });
    if (!validation.ok) {
      if (validation.code === "expired") deps.store.expireConfirmation(record.id);
      return reject(400, validation.code, validation.message);
    }

    const operation = record.operation as ConfirmableOperation;
    if (!storedPlannedOperation(operation)) {
      return reject(400, "invalid_mutation_plan", "The stored preview is missing its host plan.");
    }
    if (!Number.isSafeInteger(record.installationGeneration) ||
        operation.installationGeneration !== record.installationGeneration) {
      return reject(
        409,
        "installation_changed",
        "The Clockify installation changed after this preview was created. Create a fresh preview.",
      );
    }

    const operationRun = deps.store.getOperationRun(record.operationId);
    if (!operationRun || operationRun.status !== "prepared") {
      return reject(409, "operation_not_prepared", "The stored operation is no longer prepared.");
    }
    if (!deps.store.preparedAssistantPreviewMatchesConfirmation(record.operationId, record)) {
      return reject(409, "operation_mismatch", "The stored operation no longer matches this preview.");
    }

    const installation = deps.store.getInstallation(claims.workspaceId);
    if (!installation || installation.status !== "active") {
      return reject(503, "role_verification_unavailable", "The add-on is not active for this workspace. No change was made.");
    }
    if (record.installationGeneration !== installation.generation ||
        operation.installationGeneration !== installation.generation) {
      return reject(
        409,
        "installation_changed",
        "The Clockify installation changed after this preview was created. Create a fresh preview.",
      );
    }

    if (!operation.risks.includes("permission_change")) {
      const policy = deps.loadPolicy(claims.workspaceId, claims.adminUserId);
      if (!canWrite(policy, operation.featureGroup)) {
        return reject(400, "policy_denied", accessDeniedMessage(operation.featureGroup, "write"));
      }
    }

    const authority = await deps.verifyWriteAuthority(claims, installation, signal);
    if (!authority.ok) {
      return reject(authority.status, authority.code, authority.message);
    }

    let mutationLease: WorkspaceMutationLease;
    try {
      mutationLease = deps.mutationCoordinator.acquire(
        claims.workspaceId,
        installation.generation,
        signal,
      );
    } catch (error) {
      if (!(error instanceof WorkspaceMutationRevokedError)) throw error;
      return reject(409, "installation_changed", error.message);
    }
    if (mutationLease.signal.aborted) {
      mutationLease.release();
      return reject(409, "request_cancelled", "The confirmation was cancelled before dispatch. No change was made.");
    }

    if (!deps.store.markConfirmationExecuting(record.id)) {
      mutationLease.release();
      return reject(409, "already_used", "This preview was already used.");
    }

    try {
      const executorKind = record.executorKind!;
      const authorizedContext = {
        ...deps.actionContext(
          claims.workspaceId,
          claims.adminUserId,
          installation,
          claims.sessionId,
          mutationLease.signal,
        ),
        mutationJournal: deps.store.mutationStepJournal(record.operationId),
        idempotency: atomicLedger(claims, record.id),
      };

      const commitResult = await executeStoredV2Write(
        authorizedContext,
        operation,
        executorKind === "prepared_safe_write" ? "prepared_safe_write" : "risky_commit",
      );

      let partialResult: Extract<ActionResult, { kind: "partial" }> | undefined;
      let receipt: SuccessReceipt | ErrorReceipt;
      if (isPartialCommitResult(commitResult)) {
        partialResult = commitResult;
        receipt = commitResult.receipt;
      } else {
        receipt = commitResult;
      }

      const terminalStatus = partialResult
        ? "partial"
        : receipt.ok
          ? "succeeded"
          : receipt.code === "commit_outcome_unknown"
            ? "outcome_unknown"
            : "definitive_failed";

      let resultRef: ActionResultRef | undefined;
      let settlementError: unknown;
      for (let attempt = 0; attempt < 2 && !resultRef; attempt += 1) {
        try {
          resultRef = deps.store.settleConfirmedOperation(
            record.id,
            terminalStatus,
            operation.actionName,
            partialResult ?? receipt,
          );
        } catch (error) {
          settlementError = error;
        }
      }
      if (!resultRef) {
        console.error(
          "canonical action-result persistence degraded (change already applied; receipt preserved):",
          settlementError instanceof Error ? settlementError.message : String(settlementError),
        );
      }

      const undoId = resultRef
        ? deps.recordUndoIfReversible(claims, installation.generation, receipt)
        : undefined;

      return {
        ok: true,
        receipt,
        ...(partialResult ? { partialResult } : {}),
        undoId,
        agentState: undefined,
        installation,
        ...(!resultRef ? { persistenceDegraded: true as const } : {}),
      };
    } finally {
      mutationLease.release();
    }
  }

  async function executeTrustedDirectSafeWrite(
    input: TrustedDirectSafeWriteInput,
  ): Promise<ActionResult> {
    if (!isTrustedDirectOrigin(input.origin)) {
      return {
        kind: "receipt",
        receipt: errorReceipt({
          action: input.actionName,
          code: "invalid_origin",
          message: "Trusted direct execution requires an explicit trusted origin.",
          recovery: { hint: "Pass direct_ui, system, or live_test explicitly.", retryable: false },
        }),
      };
    }
    return executeTrustedDirectV2SafeWrite(input);
  }

  async function executeUndoCommit(input: UndoCommitInput): Promise<UndoCommitOutcome> {
    const { claims, record, context, signal } = input;
    const sourceUndoHash = hashOperation(record.reversal);
    const mutationPlan = undoMutationPlan(record.reversal);
    const operationPayload = {
      undoId: record.id,
      installationGeneration: record.installationGeneration,
      reversal: record.reversal,
    };
    const operationId = deps.store.startUndoOperation(record.id, {
      sessionId: claims.sessionId,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      actionName: "undo",
      actionFingerprint: hashOperation({ actionName: "undo", version: 1 }),
      catalogHash: deps.catalogHash(),
      operationHash: hashOperation({ actionName: "undo", operation: operationPayload, mutationPlan }),
      operation: operationPayload,
      mutationPlan,
      discriminator: {
        origin: "direct_ui",
        registryId: "v2-local",
        authorityModel: "undo_v2",
        executorKind: "undo_commit",
        sourceUndoId: record.id,
        sourceUndoHash,
      },
    });
    if (!operationId) {
      return {
        receipt: errorReceipt({
          action: "undo",
          code: "undo_not_available",
          message: "This undo is no longer available.",
        }),
        remaining: record.reversal,
        status: "failed",
        operationId: "",
      };
    }

    const undoContext = {
      ...context,
      mutationJournal: deps.store.mutationStepJournal(operationId),
    };
    const undo = await reverseCreationDurably(
      undoContext,
      record.reversal,
      operationId,
      mutationPlan,
    );
    const { receipt, remaining, status: undoStatus } = undo;

    let resultRef: ActionResultRef | undefined;
    let settlementError: unknown;
    for (let attempt = 0; attempt < 2 && !resultRef; attempt += 1) {
      try {
        resultRef = deps.store.settleUndoOperation(record.id, operationId, undoStatus, remaining, receipt);
      } catch (error) {
        settlementError = error;
      }
    }
    if (!resultRef) {
      console.error(
        "undo settlement persistence degraded (reversal already dispatched; receipt preserved):",
        settlementError instanceof Error ? settlementError.message : String(settlementError),
      );
    }

    return {
      receipt,
      remaining,
      status: undoStatus,
      operationId,
      ...(resultRef ? { resultRef } : { persistenceDegraded: true as const }),
    };
  }

  return {
    confirmSingle,
    executeTrustedDirectSafeWrite,
    executeUndoCommit,
  };
}

export type ConfirmationService = ReturnType<typeof createConfirmationService>;
