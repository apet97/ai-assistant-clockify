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
  isV2AssistantBatchConfirmation,
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
import type { ConfirmationBatchStatus } from "../db/store/context.js";
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

export interface ConfirmBatchItemInput {
  confirmationId: string;
  nonce?: string;
}

export interface ConfirmBatchInput {
  claims: ConfirmationServiceClaims;
  batchId: string;
  items: ConfirmBatchItemInput[];
  signal?: AbortSignal;
  onItem?: (item: ConfirmBatchItemOutcome) => void;
}

export type ConfirmBatchItemOutcome = {
  confirmationId: string;
  operationId: string;
  status: "succeeded" | "partial" | "definitive_failed" | "outcome_unknown";
  receipt: SuccessReceipt | ErrorReceipt;
  partialResult?: Extract<ActionResult, { kind: "partial" }>;
  undoId?: string;
  replayed?: true;
};

export type ConfirmBatchOutcome =
  | { ok: false; status: number; body: { ok: false; code: string; message: string } }
  | {
      ok: true;
      batchId: string;
      status: ConfirmationBatchStatus;
      items: ConfirmBatchItemOutcome[];
      installation: Installation;
      persistenceDegraded?: true;
    };

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

function rejectBatch(status: number, code: string, message: string): ConfirmBatchOutcome {
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

  async function dispatchConfirmedPreview(input: {
    claims: ConfirmationServiceClaims;
    record: PendingConfirmationRecord;
    installation: Installation;
    mutationLease: WorkspaceMutationLease;
  }): Promise<{
    receipt: SuccessReceipt | ErrorReceipt;
    partialResult?: Extract<ActionResult, { kind: "partial" }>;
    terminalStatus: "succeeded" | "partial" | "definitive_failed" | "outcome_unknown";
    undoId?: string;
    persistenceDegraded?: true;
  }> {
    const { claims, record, installation, mutationLease } = input;
    const operation = record.operation as ConfirmableOperation;
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
      operation as ConfirmableOperation & { mutationPlan: ExternalMutationPlan },
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
      receipt,
      ...(partialResult ? { partialResult } : {}),
      terminalStatus,
      ...(undoId ? { undoId } : {}),
      ...(!resultRef ? { persistenceDegraded: true as const } : {}),
    };
  }

  function terminalItemOutcome(
    item: { confirmationId: string; operationId: string; actionResultId?: string; status: string },
    record: PendingConfirmationRecord,
  ): ConfirmBatchItemOutcome | undefined {
    if (!item.actionResultId || record.status === "pending" || record.status === "executing") return undefined;
    const stored = deps.store.getActionResult(item.actionResultId);
    if (!stored) return undefined;
    let receipt: SuccessReceipt | ErrorReceipt;
    let partialResult: Extract<ActionResult, { kind: "partial" }> | undefined;
    if (stored && typeof stored === "object" && (stored as { kind?: unknown }).kind === "partial") {
      partialResult = stored as Extract<ActionResult, { kind: "partial" }>;
      receipt = partialResult.receipt;
    } else if (stored && typeof stored === "object" && (stored as { kind?: unknown }).kind === "receipt") {
      receipt = (stored as { receipt: SuccessReceipt | ErrorReceipt }).receipt;
    } else {
      receipt = stored as SuccessReceipt | ErrorReceipt;
    }
    const status = record.status === "partial"
      ? "partial"
      : record.status === "succeeded"
        ? "succeeded"
        : record.status === "outcome_unknown"
          ? "outcome_unknown"
          : "definitive_failed";
    return {
      confirmationId: item.confirmationId,
      operationId: item.operationId,
      status,
      receipt,
      ...(partialResult ? { partialResult } : {}),
      replayed: true,
    };
  }

  function summarizeBatchStatus(
    items: ConfirmBatchItemOutcome[],
  ): ConfirmationBatchStatus {
    if (items.some((item) => item.status === "outcome_unknown")) return "outcome_unknown";
    if (items.some((item) => item.status === "partial")) return "partial";
    const failures = items.filter((item) => item.status === "definitive_failed").length;
    const successes = items.filter((item) => item.status === "succeeded").length;
    if (failures > 0 && successes > 0) return "partial";
    if (failures === items.length) return "definitive_failed";
    return "succeeded";
  }

  async function confirmBatch(input: ConfirmBatchInput): Promise<ConfirmBatchOutcome> {
    const { claims, batchId, items: bodyItems, signal, onItem } = input;
    const nowIso = deps.now().toISOString();

    let batch = deps.store.getScopedConfirmationBatch(
      batchId,
      claims.workspaceId,
      claims.adminUserId,
      claims.sessionId,
    );
    if (!batch) {
      return rejectBatch(404, "not_found", "No such confirmation batch.");
    }

    deps.store.recoverConfirmationBatch(batchId, nowIso);
    batch = deps.store.getConfirmationBatch(batchId)!;
    const storedItems = deps.store.listConfirmationBatchItems(batchId);

    if (bodyItems.length !== storedItems.length) {
      return rejectBatch(400, "batch_items_mismatch", "The confirmation batch members do not match the stored preview.");
    }
    for (let index = 0; index < storedItems.length; index += 1) {
      const stored = storedItems[index]!;
      const body = bodyItems[index];
      if (!body || body.confirmationId !== stored.confirmationId) {
        return rejectBatch(400, "batch_items_mismatch", "The confirmation batch members do not match the stored preview order.");
      }
    }

    const tupleHash = deps.store.computeOrderedTupleHash(storedItems.map((item) => ({
      confirmationId: item.confirmationId,
      operationId: item.operationId,
    })));
    if (tupleHash !== batch.orderedTupleHash) {
      return rejectBatch(409, "batch_integrity_failed", "The stored batch no longer matches its membership hash.");
    }

    const expiresAtMs = new Date(batch.expiresAt).getTime();
    if (Number.isNaN(expiresAtMs) || deps.now().getTime() >= expiresAtMs) {
      deps.store.updateConfirmationBatchStatus(batchId, "expired", { completedAt: nowIso });
      return rejectBatch(400, "expired", "This confirmation batch has expired. Ask me to run a fresh preview.");
    }

    if (batch.status === "outcome_unknown" || batch.status === "succeeded" ||
        batch.status === "partial" || batch.status === "definitive_failed" ||
        batch.status === "cancelled" || batch.status === "expired") {
      const replayed: ConfirmBatchItemOutcome[] = [];
      for (const item of storedItems) {
        const record = deps.store.getPendingConfirmation(item.confirmationId);
        if (!record) {
          return rejectBatch(409, "batch_integrity_failed", "A batch member is no longer available.");
        }
        const outcome = terminalItemOutcome(item, record);
        if (!outcome) {
          return rejectBatch(409, "batch_incomplete", "The stored batch is not fully settled for replay.");
        }
        replayed.push(outcome);
        onItem?.(outcome);
      }
      return {
        ok: true,
        batchId,
        status: batch.status === "cancelled" ? "cancelled" : batch.status,
        items: replayed,
        installation: deps.store.getInstallation(claims.workspaceId)!,
      };
    }

    for (let index = batch.currentIndex; index < storedItems.length; index += 1) {
      const item = storedItems[index]!;
      const body = bodyItems[index]!;
      const record = deps.store.getPendingConfirmation(item.confirmationId);
      if (!record || record.batchId !== batchId) {
        return rejectBatch(409, "batch_integrity_failed", "A batch member is no longer available.");
      }
      if (item.status !== "pending") {
        const replay = terminalItemOutcome(item, record);
        if (!replay) {
          return rejectBatch(409, "batch_incomplete", "The stored batch is not fully settled for replay.");
        }
        onItem?.(replay);
        continue;
      }
      if (!body.nonce) {
        return rejectBatch(400, "invalid_confirmation", "A live batch member requires its confirmation nonce.");
      }
    }

    const installation = deps.store.getInstallation(claims.workspaceId);
    if (!installation || installation.status !== "active") {
      return rejectBatch(503, "role_verification_unavailable", "The add-on is not active for this workspace. No change was made.");
    }

    const authority = await deps.verifyWriteAuthority(claims, installation, signal);
    if (!authority.ok) {
      return rejectBatch(authority.status, authority.code, authority.message);
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
      return rejectBatch(409, "installation_changed", error.message);
    }
    if (mutationLease.signal.aborted) {
      mutationLease.release();
      return rejectBatch(409, "request_cancelled", "The confirmation was cancelled before dispatch. No change was made.");
    }

    if (batch.status === "pending" && !deps.store.markConfirmationBatchExecuting(batchId)) {
      mutationLease.release();
      return rejectBatch(409, "already_used", "This batch was already used.");
    }

    const outcomes: ConfirmBatchItemOutcome[] = [];
    let persistenceDegraded = false;
    let stopRemaining = false;

    try {
      for (let index = batch.currentIndex; index < storedItems.length; index += 1) {
        if (stopRemaining) break;
        const item = storedItems[index]!;
        const body = bodyItems[index]!;
        let record = deps.store.getPendingConfirmation(item.confirmationId)!;

        if (item.status !== "pending") {
          const replay = terminalItemOutcome(item, record);
          if (replay) outcomes.push(replay);
          onItem?.(replay!);
          continue;
        }

        if (!isV2AssistantBatchConfirmation(record)) {
          mutationLease.release();
          return rejectBatch(400, "incompatible_confirmation", "This preview is not a v2 assistant batch confirmation.");
        }

        const validation = confirmPending({
          record,
          sessionId: claims.sessionId,
          workspaceId: claims.workspaceId,
          adminUserId: claims.adminUserId,
          nonce: body.nonce!,
          sessionSecret: deps.sessionSecret,
          now: deps.now(),
          expectedActionFingerprint: actionFingerprint(deps.registry, (record.operation as ConfirmableOperation).actionName),
          expectedCatalogHash: deps.catalogHash(),
        });
        if (!validation.ok) {
          if (validation.code === "expired") deps.store.expireConfirmation(record.id);
          mutationLease.release();
          return rejectBatch(400, validation.code, validation.message);
        }

        const operation = record.operation as ConfirmableOperation;
        if (!storedPlannedOperation(operation)) {
          mutationLease.release();
          return rejectBatch(400, "invalid_mutation_plan", "The stored preview is missing its host plan.");
        }
        if (!Number.isSafeInteger(record.installationGeneration) ||
            operation.installationGeneration !== record.installationGeneration ||
            record.installationGeneration !== installation.generation ||
            operation.installationGeneration !== installation.generation) {
          mutationLease.release();
          return rejectBatch(409, "installation_changed", "The Clockify installation changed after this preview was created. Create a fresh preview.");
        }

        const operationRun = deps.store.getOperationRun(record.operationId);
        if (!operationRun || operationRun.status !== "prepared") {
          mutationLease.release();
          return rejectBatch(409, "operation_not_prepared", "The stored operation is no longer prepared.");
        }
        if (!deps.store.preparedAssistantPreviewMatchesConfirmation(record.operationId, record)) {
          mutationLease.release();
          return rejectBatch(409, "operation_mismatch", "The stored operation no longer matches this preview.");
        }

        if (!operation.risks.includes("permission_change")) {
          const policy = deps.loadPolicy(claims.workspaceId, claims.adminUserId);
          if (!canWrite(policy, operation.featureGroup)) {
            mutationLease.release();
            return rejectBatch(400, "policy_denied", accessDeniedMessage(operation.featureGroup, "write"));
          }
        }

        if (!deps.store.markConfirmationExecuting(record.id)) {
          mutationLease.release();
          return rejectBatch(409, "already_used", "This preview was already used.");
        }

        deps.store.updateConfirmationBatchItemStatus(batchId, index, "executing", { startedAt: nowIso });

        const dispatched = await dispatchConfirmedPreview({
          claims,
          record,
          installation,
          mutationLease,
        });

        if (dispatched.persistenceDegraded) persistenceDegraded = true;

        const itemStatus = dispatched.terminalStatus;
        const storedItemStatus = itemStatus === "partial" ? "succeeded" : itemStatus;
        deps.store.updateConfirmationBatchItemStatus(batchId, index, storedItemStatus, {
          actionResultId: deps.store.getPendingConfirmation(record.id)?.actionResultId,
          completedAt: nowIso,
        });
        deps.store.advanceConfirmationBatchProgress(batchId, index + 1, nowIso);

        const outcome: ConfirmBatchItemOutcome = {
          confirmationId: record.id,
          operationId: record.operationId,
          status: itemStatus === "partial" ? "partial" : itemStatus,
          receipt: dispatched.receipt,
          ...(dispatched.partialResult ? { partialResult: dispatched.partialResult } : {}),
          ...(dispatched.undoId ? { undoId: dispatched.undoId } : {}),
        };
        outcomes.push(outcome);
        onItem?.(outcome);

        if (itemStatus === "outcome_unknown") {
          stopRemaining = true;
          deps.store.cancelUndispatchedBatchItems(batchId, index + 1, nowIso);
          deps.store.updateConfirmationBatchStatus(batchId, "outcome_unknown", { completedAt: nowIso });
        }
      }
    } finally {
      mutationLease.release();
    }

    if (!stopRemaining) {
      const prior = storedItems.slice(0, batch.currentIndex).flatMap((item) => {
        const replay = terminalItemOutcome(item, deps.store.getPendingConfirmation(item.confirmationId)!);
        return replay ? [replay] : [];
      });
      const allOutcomes = [...prior, ...outcomes];
      const finalStatus = summarizeBatchStatus(allOutcomes);
      deps.store.updateConfirmationBatchStatus(batchId, finalStatus, { completedAt: nowIso });
      batch = { ...batch, status: finalStatus };
    } else {
      batch = deps.store.getConfirmationBatch(batchId)!;
    }

    const finalItems: ConfirmBatchItemOutcome[] = [];
    for (const item of deps.store.listConfirmationBatchItems(batchId)) {
      const record = deps.store.getPendingConfirmation(item.confirmationId)!;
      const outcome = terminalItemOutcome(item, record) ??
        outcomes.find((entry) => entry.confirmationId === item.confirmationId);
      if (outcome) finalItems.push(outcome);
    }

    return {
      ok: true,
      batchId,
      status: batch.status,
      items: finalItems,
      installation,
      ...(persistenceDegraded ? { persistenceDegraded: true as const } : {}),
    };
  }

  return {
    confirmSingle,
    confirmBatch,
    executeTrustedDirectSafeWrite,
    executeUndoCommit,
  };
}

export type ConfirmationService = ReturnType<typeof createConfirmationService>;
