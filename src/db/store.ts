import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { migrate } from "./schema.js";
import { decryptSecret, encryptSecret } from "./encryption.js";
import type {
  StoreContext,
  InstallationStatus,
  InstallationInput,
  Installation,
  InstallationEnv,
  InstallationSaveResult,
  InstallationStatusResult,
  LifecycleDeletionResult,
  ChatSession,
  NewSessionInput,
  SessionSummary,
  NewMessageInput,
  ChatMessage,
  AuditEventInput,
  UndoRecordInput,
  UndoRecord,
  EraseCounts,
  TurnRun,
  TurnRunClaimInput,
  TurnRunClaimResult,
  OperationRun,
  OperationRunStatus,
  PrepareOperationRunInput,
  OperationStep,
  SanitizedOperationRun,
  StartupReconciliationOperation,
  PrepareOperationStepInput,
  PrepareCompensationStepInput,
  ArtifactRecord,
  DurableResultLink,
  ConfirmationBatchRecord,
  ConfirmationBatchItemRecord,
  ConfirmationBatchStatus,
  ConfirmationBatchItemStatus,
  CreateConfirmationBatchInput,
} from "./store/context.js";
import {
  actionResultJson,
  buildActionResultSummary,
  type ActionResultRef,
} from "./action-results.js";
import { buildAdminPolicyStore } from "./store/admin-policies.js";
import { buildTelemetryStore } from "./store/telemetry.js";
import {
  actionOutcomesSql,
  boundedWorkspaceAdminParams,
  buildAuditMetricsStore,
} from "./store/audit-metrics.js";
import { buildMessageStore } from "./store/messages.js";
import { buildSessionStore } from "./store/sessions.js";
import { buildUndoStore } from "./store/undo.js";
import { buildInstallationStore } from "./store/installations.js";
import { buildConfirmationStore } from "./store/confirmations.js";
import { buildConfirmationBatchStore } from "./store/confirmation-batches.js";
import { buildIdempotencyStore } from "./store/idempotency.js";
import {
  buildRetentionStore,
  IDEMPOTENCY_RETENTION_MS,
  type PruneCounts,
  type RetentionRunMetric,
} from "./store/retention.js";
import { buildTurnRunStore } from "./store/turn-runs.js";
import { buildAssistantRunStore } from "./store/runs.js";
import { buildRunEventStore } from "./store/run-events.js";
import { buildOperationRunStore } from "./store/operation-runs.js";
import {
  buildAssistantWritePreparationStore,
  type PreparedAssistantWriteInput,
  type PreparedAssistantWriteResult,
} from "./store/assistant-write-preparation.js";
import { buildArtifactStore } from "./store/artifacts.js";
import {
  buildIntentCapabilityStore,
  type BindIntentCapabilityOperationInput,
  type BindIntentCapabilityOperationResult,
  type ConsumeIntentCapabilityExecutionResult,
  type CreateIntentCapabilityInput,
  type IntentCapabilityRecord,
  type IntentCapabilityOperationScope,
  type IntentCapabilityScope,
} from "./store/intent-capabilities.js";
import type { AdminPolicy } from "../harness/permissions.js";
import type { PendingConfirmationRecord } from "../harness/confirmations.js";
import type { SuccessReceipt } from "../harness/receipts.js";
import type { ClaimState, CommitResult } from "../harness/action.js";
import type { ActionOutcome, TurnTelemetry } from "../metrics/metrics.js";
import type { MutationStepJournal } from "../harness/mutation-contract.js";

/**
 * The single SQLite access module (backend rule: all DB access goes through
 * src/db/store.ts). Owns config/policy/installation, chat sessions and messages,
 * pending confirmations (with an ATOMIC one-use transition), and audit events.
 *
 * The shared data-shape types live in the leaf `./store/context.ts` (so the
 * per-concern builder modules can import them without a `store.ts ↔ concern`
 * cycle); they are re-exported here so every `../db/store.js` import is
 * byte-identical.
 */

export type {
  InstallationStatus,
  InstallationInput,
  Installation,
  InstallationEnv,
  InstallationSaveOutcome,
  InstallationSaveResult,
  InstallationStatusOutcome,
  InstallationStatusResult,
  LifecycleDeletionResult,
  ChatSession,
  NewSessionInput,
  SessionSummary,
  ChatRole,
  NewMessageInput,
  ChatMessage,
  AuditEventInput,
  UndoRecordInput,
  UndoRecord,
  EraseCounts,
  TurnRun,
  TurnRunClaimInput,
  TurnRunClaimResult,
  OperationRun,
  OperationRunStatus,
  PrepareOperationRunInput,
  OperationStep,
  SanitizedOperationRun,
  StartupReconciliationOperation,
  PrepareOperationStepInput,
  PrepareCompensationStepInput,
  ArtifactRecord,
  DurableResultLink,
  ConfirmationBatchRecord,
  ConfirmationBatchItemRecord,
  ConfirmationBatchStatus,
  ConfirmationBatchItemStatus,
  CreateConfirmationBatchInput,
  OperationDiscriminatorInput,
} from "./store/context.js";
export type { ActionResultKind, ActionResultRef } from "./action-results.js";
export type {
  BindIntentCapabilityOperationInput,
  BindIntentCapabilityOperationResult,
  ConsumeIntentCapabilityExecutionResult,
  CreateIntentCapabilityInput,
  IntentCapabilityRecord,
  IntentCapabilityOperationScope,
  IntentCapabilityScope,
} from "./store/intent-capabilities.js";
export { IntentCapabilityStoreError } from "./store/intent-capabilities.js";

export interface StoreOptions {
  encryptionKey?: string;
  /** One-release fallback used to re-encrypt installation tokens under encryptionKey. */
  previousEncryptionKey?: string;
  now?: () => Date;
  /** Retention (days) for chat_messages + audit_events; defaults to 90. */
  retentionDays?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Chat/audit retention (marketplace data-minimization). chat_messages and
 * audit_events used to be kept forever; they now age out on a configurable
 * window (default 90 days, env RETENTION_DAYS, floor 30). 90d is well above the
 * recap (24h default / 30d max) and metrics (30d default) read windows, so those
 * features keep their full data. The committed receipts also live in the audit
 * log within the window.
 */
const DEFAULT_RETENTION_DAYS = 90;

/**
 * Dead-claim TTL (r1-concurrency-races-01). The LIVE-vs-crashed threshold: an
 * atomic claim NOT heartbeated within this window is treated as crashed. Set
 * STRICTLY above the commit-latency ceiling (COMMIT_TIMEOUT_MS, 120s) so a LIVE
 * commit's claim is provably never mis-read as crashed, yet well below
 * IDEMPOTENCY_WINDOW_MS (10 min) and IDEMPOTENCY_RETENTION_MS (60 min).
 *
 * crash-before-fill residual: a crashed claim is NOT swept-and-re-won here (that
 * silently double-committed a money write whose commit died between the host
 * write and `fill`). Instead `claimIdempotency` returns `stale_unknown` for it
 * throughout the dedup window — the caller surfaces "verify in Clockify, don't
 * retry" — and it is only swept (by the next same-key claim AND by pruneExpired)
 * once past the dedup/retention window, after which a deliberate re-issue commits.
 */
export const CLAIM_TTL_MS = 5 * 60 * 1000;

// The retention windows + pruneExpired/explainPrunePlan live in the retention
// concern builder; re-exported so the public `../db/store.js` surface
// (IDEMPOTENCY_RETENTION_MS + the PruneCounts type) stays byte-identical.
export { IDEMPOTENCY_RETENTION_MS };
export type { PruneCounts };

export interface Store {
  getAdminPolicy(workspaceId: string, adminUserId: string): AdminPolicy | undefined;
  upsertAdminPolicy(workspaceId: string, adminUserId: string, policy: AdminPolicy): void;
  saveInstallation(input: InstallationInput): InstallationSaveResult;
  getInstallation(workspaceId: string): Installation | undefined;
  /** Return the server-mintable fresh-install binding only when the supplied
   * raw token matches the current active installation and exact generation. */
  getAuthenticatedInstallationAttestation(
    workspaceId: string,
    addonToken: string,
  ): import("../addon/install-attestation.js").InstallationAttestationRecord | undefined;
  /** Refresh environment URLs from the latest token; only provided fields change. */
  updateInstallationEnv(workspaceId: string, env: InstallationEnv): void;
  setInstallationStatus(
    workspaceId: string,
    status: InstallationStatus,
    lifecycleIssuedAt?: number,
  ): InstallationStatusResult;
  /** Atomically order a verified DELETED event and wipe the current token. */
  tombstoneInstallationForLifecycle(
    workspaceId: string,
    lifecycleIssuedAt: number,
  ): LifecycleDeletionResult;
  /** Wipe the token and persist a deletion tombstone before waiting on host settlement. */
  tombstoneInstallation(workspaceId: string): { generation: number } | undefined;
  /** Workspaces whose interrupted uninstall must be completed at startup. */
  listDeletionTombstones(): string[];
  /**
   * Erase ALL of a workspace's stored data (GDPR / uninstall): deletes every
   * workspace-scoped row and tombstones the installation with the token wiped.
   * Atomic; safe to call on an unknown workspace (no-op zero counts).
   */
  eraseWorkspace(workspaceId: string): EraseCounts;
  /** Erase only the exact still-current tokenless uninstall tombstone. */
  eraseWorkspaceForDeletion(workspaceId: string, generation: number): EraseCounts | undefined;

  createSession(input: NewSessionInput): ChatSession;
  getSession(id: string): ChatSession | undefined;
  /** Expire every live session after a definite role-revocation result. */
  invalidateAdminSessions(workspaceId: string, adminUserId: string): number;
  /**
   * This admin's live (non-expired), non-empty chat sessions in THIS workspace,
   * newest-first (by last message). Each summary carries the first user message
   * as a title + the message count. Scoped by workspace + admin (tenant
   * isolation): never enumerates another tenant's sessions.
   */
  listSessions(workspaceId: string, adminUserId: string, nowIso: string): SessionSummary[];

  addMessage(input: NewMessageInput): void;
  /**
   * Loads the most recent `limit` messages, oldest-first. `payload` is omitted
   * unless `includePayload` is true — the model-visible window only needs
   * role + content, so the stored payload blob is not fetched/parsed by default.
   */
  getRecentMessages(sessionId: string, limit: number, includePayload?: boolean): ChatMessage[];

  claimTurnRun(input: TurnRunClaimInput): TurnRunClaimResult;
  markTurnRunExecuting(sessionId: string, requestId: string): void;
  finishTurnRun(
    sessionId: string,
    requestId: string,
    status: "succeeded" | "failed" | "outcome_unknown",
    response: unknown,
    resultLinks?: DurableResultLink[],
  ): void;
  getTurnRun(sessionId: string, requestId: string): TurnRun | undefined;
  startRunWithTurn(input: import("./store/runs.js").StartAssistantRunInput): void;
  getRun(scope: import("./store/runs.js").AssistantRunScope): import("../assistant-v2/state.js").RunState | undefined;
  saveRun(state: import("../assistant-v2/state.js").RunState): void;
  findLatestEligibleRunForCache(
    sessionId: string,
    workspaceId: string,
    adminUserId: string,
    installationGeneration: number,
    authClass: import("../harness/api-operation.js").AuthClass,
    catalogHash: string,
  ): import("../assistant-v2/state.js").RunState | undefined;
  recoverOrphanedActiveRuns(scope: import("../assistant-v2/protocol.js").RunScope): number;
  failActiveRunsForSession(sessionId: string, workspaceId: string, adminUserId: string, code: string): number;
  startRunWithEvent(input: import("./store/runs.js").StartAssistantRunInput): import("../assistant-v2/events.js").SequencedRunEvent;
  listRunEvents(input: import("./store/run-events.js").ListRunEventsStoreInput): import("./store/run-events.js").RunEventPageStoreResult;
  getLastRunEventSequence(scope: import("./store/runs.js").AssistantRunScope): number;
  getActiveRunForSession(sessionId: string, workspaceId: string, adminUserId: string): {
    runId: string;
    phase: import("../assistant-v2/state.js").RunPhase;
    lastSequence: number;
    updatedAt: string;
  } | undefined;
  reserveModelCallWithEvent(
    scope: import("./store/runs.js").AssistantRunScope,
    state: import("../assistant-v2/state.js").RunState,
    payload: import("../assistant-v2/events.js").RunEventPayloadMap["model.started"],
  ): import("../assistant-v2/events.js").SequencedRunEvent;
  completeModelCallWithEvent(
    scope: import("./store/runs.js").AssistantRunScope,
    state: import("../assistant-v2/state.js").RunState,
    payload: import("../assistant-v2/events.js").RunEventPayloadMap["model.completed"],
  ): import("../assistant-v2/events.js").SequencedRunEvent;
  reserveDiscoveryCallWithEvent(
    scope: import("./store/runs.js").AssistantRunScope,
    state: import("../assistant-v2/state.js").RunState,
    payload: import("../assistant-v2/events.js").RunEventPayloadMap["api.search_started"],
  ): import("../assistant-v2/events.js").SequencedRunEvent;
  loadOperationsWithEvent(
    scope: import("./store/runs.js").AssistantRunScope,
    state: import("../assistant-v2/state.js").RunState,
    payload: import("../assistant-v2/events.js").RunEventPayloadMap["api.operations_loaded"],
  ): import("../assistant-v2/events.js").SequencedRunEvent;
  requestToolWithEvent(
    scope: import("./store/runs.js").AssistantRunScope,
    state: import("../assistant-v2/state.js").RunState,
    payload: import("../assistant-v2/events.js").RunEventPayloadMap["tool.requested"],
  ): import("../assistant-v2/events.js").SequencedRunEvent;
  denyToolWithEvent(
    scope: import("./store/runs.js").AssistantRunScope,
    state: import("../assistant-v2/state.js").RunState,
    payload: import("../assistant-v2/events.js").RunEventPayloadMap["tool.denied"],
  ): import("../assistant-v2/events.js").SequencedRunEvent;
  startToolWithEvent(
    scope: import("./store/runs.js").AssistantRunScope,
    state: import("../assistant-v2/state.js").RunState,
    payload: import("../assistant-v2/events.js").RunEventPayloadMap["tool.started"],
  ): import("../assistant-v2/events.js").SequencedRunEvent;
  completeToolWithEvent(
    scope: import("./store/runs.js").AssistantRunScope,
    state: import("../assistant-v2/state.js").RunState,
    payload: import("../assistant-v2/events.js").RunEventPayloadMap["tool.completed"],
  ): import("../assistant-v2/events.js").SequencedRunEvent;
  suspendRunWithEvent(
    scope: import("./store/runs.js").AssistantRunScope,
    state: import("../assistant-v2/state.js").RunState,
    payload: import("../assistant-v2/events.js").RunEventPayloadMap["run.suspended"],
  ): import("../assistant-v2/events.js").SequencedRunEvent;
  completeRunWithEvent(
    scope: import("./store/runs.js").AssistantRunScope,
    state: import("../assistant-v2/state.js").RunState,
    payload: import("../assistant-v2/events.js").RunEventPayloadMap["run.completed"],
  ): import("../assistant-v2/events.js").SequencedRunEvent;
  failRunWithEvent(
    scope: import("./store/runs.js").AssistantRunScope,
    state: import("../assistant-v2/state.js").RunState,
    payload: import("../assistant-v2/events.js").RunEventPayloadMap["run.failed"],
  ): import("../assistant-v2/events.js").SequencedRunEvent;
  getActiveRunForSession(sessionId: string, workspaceId: string, adminUserId: string): {
    runId: string;
    phase: import("../assistant-v2/state.js").RunPhase;
    lastSequence: number;
    updatedAt: string;
  } | undefined;
  createIntentCapability(input: CreateIntentCapabilityInput): IntentCapabilityRecord;
  getIntentCapability(id: string, scope: IntentCapabilityScope): IntentCapabilityRecord | undefined;
  getIntentCapabilityForOperation(input: IntentCapabilityOperationScope): IntentCapabilityRecord;
  bindIntentCapabilityOperation(input: BindIntentCapabilityOperationInput): BindIntentCapabilityOperationResult;
  consumeIntentCapabilityExecution(input: BindIntentCapabilityOperationInput): ConsumeIntentCapabilityExecutionResult;
  consumeIntentCapabilityForOperation(input: IntentCapabilityOperationScope): ConsumeIntentCapabilityExecutionResult;
  prepareOperationRun(input: PrepareOperationRunInput): string;
  prepareAssistantWriteWithEvent(input: {
    scope: import("./store/runs.js").AssistantRunScope;
    state: import("../assistant-v2/state.js").RunState;
    write: PreparedAssistantWriteInput;
  }): PreparedAssistantWriteResult;
  prepareAssistantWriteBatchWithEvents(input: {
    scope: import("./store/runs.js").AssistantRunScope;
    state: import("../assistant-v2/state.js").RunState;
    writes: readonly PreparedAssistantWriteInput[];
    batch?: Omit<CreateConfirmationBatchInput, "items">;
  }): {
    state: import("../assistant-v2/state.js").RunState;
    events: import("../assistant-v2/events.js").SequencedRunEvent[];
    items: Array<{ operationId: string; confirmationId: string }>;
    batchId?: string;
  };
  markOperationExecuting(id: string): boolean;
  settleOperationRun(
    id: string,
    status: Exclude<OperationRunStatus, "prepared" | "executing">,
    actionResultId?: string,
  ): void;
  settleOperationResult(
    id: string,
    status: Exclude<OperationRunStatus, "prepared" | "executing">,
    result: unknown,
  ): ActionResultRef;
  getOperationRun(id: string): OperationRun | undefined;
  preparedAssistantPreviewMatchesConfirmation(
    operationId: string,
    record: import("../harness/confirmations.js").PendingConfirmationRecord,
  ): boolean;
  getScopedOperationRun(id: string, workspaceId: string, adminUserId: string, sessionId: string): SanitizedOperationRun | undefined;
  listScopedOperationRuns(workspaceId: string, adminUserId: string, sessionId: string, limit?: number): SanitizedOperationRun[];
  listStartupReconciliationCandidates(): StartupReconciliationOperation[];
  recordOperationReconciliation(id: string, stepId: string, result: unknown, authoritative: boolean): void;
  settleStartupReconciliation(id: string, stepId: string, result: unknown): ActionResultRef;
  prepareOperationStep(input: PrepareOperationStepInput): string;
  markOperationStepExecuting(id: string, operationId?: string): boolean;
  markOperationStepDispatched(id: string, operationId?: string): boolean;
  cancelOperationStepBeforeDispatch(id: string, detail: unknown, operationId?: string): boolean;
  settleOperationStep(
    id: string,
    status: "succeeded" | "definitive_failed" | "outcome_unknown",
    detail?: { externalId?: string; effect?: unknown; detail?: unknown },
    operationId?: string,
  ): void;
  settleOperationStepDegraded(
    id: string,
    status: "succeeded" | "definitive_failed" | "outcome_unknown",
    detail: { externalId?: string; detail: unknown },
    operationId?: string,
  ): void;
  settleReconciledStep(
    id: string,
    status: "succeeded" | "definitive_failed",
    detail?: { externalId?: string; effect?: unknown; detail?: unknown },
    operationId?: string,
  ): void;
  prepareCompensationStep(input: PrepareCompensationStepInput): string;
  markOperationStepCompensating(id: string, operationId?: string): boolean;
  settleCompensationStep(
    id: string,
    status: "compensated" | "compensation_failed" | "outcome_unknown",
    detail?: { externalId?: string; effect?: unknown; detail?: unknown },
    operationId?: string,
  ): void;
  settleCompensationStepDegraded(
    id: string,
    status: "compensated" | "compensation_failed" | "outcome_unknown",
    detail: { externalId?: string; detail: unknown },
    operationId?: string,
  ): void;
  listOperationSteps(operationId: string): OperationStep[];
  /** Step capabilities scoped to exactly one durable operation id. */
  mutationStepJournal(operationId: string): MutationStepJournal;
  createArtifact(input: Omit<ArtifactRecord, "id" | "checksum" | "createdAt" | "expiresAt">): { id: string; expiresAt: string };
  getArtifact(id: string, workspaceId: string, adminUserId: string, sessionId: string): ArtifactRecord | undefined;
  recoverOrphanedRuns(): { turns: number; operations: number; confirmations: number; undos: number; assistantRuns: number };
  recordActionResult(input: {
    workspaceId: string;
    adminUserId: string;
    sessionId?: string;
    actionName: string;
    status: Exclude<OperationRunStatus, "prepared" | "executing">;
    result: unknown;
    operationId?: string;
  }): ActionResultRef;

  savePendingConfirmation(record: PendingConfirmationRecord): void;
  getPendingConfirmation(id: string): PendingConfirmationRecord | undefined;
  /** This session's still-live pending previews (status pending, not expired), oldest-first. */
  listPendingConfirmations(sessionId: string, nowIso: string): PendingConfirmationRecord[];
  /** Atomically swap the nonce hash; true only while still pending (a concurrent confirm/cancel wins). */
  updateConfirmationNonceHash(id: string, nonceHash: string): boolean;
  /** Atomically transition pending → executing, bind one durable unknown result,
   *  and scrub dispatch material. True only for the winning caller. */
  markConfirmationExecuting(id: string): boolean;
  /** Atomically transition pending → cancelled. */
  cancelConfirmation(id: string): boolean;
  expireConfirmation(id: string): boolean;
  /** Bind the pre-host idempotency claim to this executing confirmation. */
  bindConfirmationIdempotencyKey(id: string, key: string): void;
  /** Release a failed commit's bound claim and association atomically. */
  releaseConfirmationIdempotencyKey(id: string, key: string): void;
  settleConfirmation(
    id: string,
    status: "succeeded" | "partial" | "definitive_failed" | "outcome_unknown",
    actionName: string,
    result: unknown,
  ): ActionResultRef;
  /** Atomic operation + confirmation + canonical-result terminal transition. */
  settleConfirmedOperation(
    id: string,
    status: "succeeded" | "partial" | "definitive_failed" | "outcome_unknown",
    actionName: string,
    result: unknown,
  ): ActionResultRef;
  getActionResult(id: string): unknown | undefined;
  /** This session's still-live pending previews (status pending, not expired). */
  countPendingConfirmations(sessionId: string, nowIso: string): number;

  computeOrderedTupleHash(
    items: ReadonlyArray<{ confirmationId: string; operationId: string }>,
  ): string;
  createConfirmationBatch(input: CreateConfirmationBatchInput): ConfirmationBatchRecord;
  insertConfirmationBatch(input: CreateConfirmationBatchInput): ConfirmationBatchRecord;
  getConfirmationBatch(id: string): ConfirmationBatchRecord | undefined;
  getScopedConfirmationBatch(
    id: string,
    workspaceId: string,
    adminUserId: string,
    sessionId: string,
  ): ConfirmationBatchRecord | undefined;
  listConfirmationBatchItems(batchId: string): ConfirmationBatchItemRecord[];
  updateConfirmationBatchStatus(
    id: string,
    status: ConfirmationBatchStatus,
    patch?: {
      currentIndex?: number;
      actionResultId?: string;
      startedAt?: string;
      completedAt?: string;
    },
  ): boolean;
  updateConfirmationBatchItemStatus(
    batchId: string,
    itemIndex: number,
    status: ConfirmationBatchItemStatus,
    patch?: { actionResultId?: string; startedAt?: string; completedAt?: string },
  ): boolean;
  markConfirmationBatchExecuting(batchId: string): boolean;
  advanceConfirmationBatchProgress(batchId: string, nextIndex: number, timestamp: string): boolean;
  cancelUndispatchedBatchItems(batchId: string, fromIndex: number, timestamp: string): number;
  recoverConfirmationBatch(batchId: string, nowIsoArg: string): void;
  expireConfirmationBatches(nowIso: string): number;

  /** Idempotency ledger (Phase 5): a committed success keyed by intent hash. */
  recordIdempotency(key: string, workspaceId: string, adminUserId: string, ref: ActionResultRef, committedAtEpochMs: number): void;
  lookupIdempotency(key: string, workspaceId: string, adminUserId: string, notBeforeEpochMs: number): SuccessReceipt | undefined;

  /**
   * Atomic-claim ledger (r1-concurrency-races-01). One synchronous
   * better-sqlite3 transaction: sweep a stale COMPLETED row (committed_at <
   * completedNotBefore) or a dead CLAIM (claimed_at < claimNotBefore), then
   * INSERT...ON CONFLICT DO NOTHING. Returns `'won'` for the single winner,
   * `'replay'` when an in-window completed row already exists, `'in_flight'`
   * when a live claim is held by another request.
   */
  claimIdempotency(
    key: string,
    workspaceId: string,
    adminUserId: string,
    claimedAtEpochMs: number,
    completedNotBeforeEpochMs: number,
    claimNotBeforeEpochMs: number,
  ): ClaimState;
  /** The completed receipt for a key the claim reported as `replay`. */
  claimIdempotencyReceipt(key: string, workspaceId: string, adminUserId: string): CommitResult | undefined;
  /** Complete the OWN claim (guarded on action_result_id IS NULL — fills once). */
  fillIdempotency(key: string, workspaceId: string, adminUserId: string, ref: ActionResultRef, committedAtEpochMs: number): void;
  /** Release the OWN claim (guarded on action_result_id IS NULL — never drops a completed row). */
  releaseIdempotency(key: string, workspaceId: string, adminUserId: string): void;
  /**
   * Heartbeat a LIVE claim: refresh `claimed_at` so a long multi-call commit's
   * claim is never swept as dead while it is still in flight (a single
   * createInvoice commit issues POST+GET+PUT+tax+N items, whose summed latency
   * can exceed CLAIM_TTL_MS — only the per-call timeout bounds each one).
   * Guarded on action_result_id IS NULL — never touches a completed row, and a
   * missing key no-ops.
   */
  touchIdempotencyClaim(key: string, workspaceId: string, adminUserId: string, claimedAtEpochMs: number): void;

  /** Undo ledger (Phase 5b): a reversible action and its one-use status. */
  recordUndoable(input: UndoRecordInput): string;
  getUndoRecord(id: string): UndoRecord | undefined;
  /** Atomically transition available → executing. */
  markUndoExecuting(id: string): boolean;
  /** Atomically claim one undo and create its executing durable operation. */
  startUndoOperation(id: string, input: PrepareOperationRunInput): string | undefined;
  settleUndo(
    id: string,
    status: "partially_undone" | "undone" | "failed" | "outcome_unknown",
    remaining: import("../harness/receipts.js").EntityRef[],
    result: unknown,
  ): ActionResultRef;
  /** Atomic undo + operation + canonical-result terminal transition. */
  settleUndoOperation(
    id: string,
    operationId: string,
    status: "partially_undone" | "undone" | "failed" | "outcome_unknown",
    remaining: import("../harness/receipts.js").EntityRef[],
    result: unknown,
  ): ActionResultRef;

  addAuditEvent(input: AuditEventInput): void;

  /** Operational metrics (Phase 7): audited action outcomes + confirmation
   *  statuses, scoped to a workspace + admin, optionally since an ISO timestamp. */
  listActionOutcomes(workspaceId: string, adminUserId: string, sinceIso?: string): ActionOutcome[];
  listConfirmationOutcomes(workspaceId: string, adminUserId: string, sinceIso?: string): string[];

  /** Per-turn model telemetry (cost + latency; see metrics.ts TurnTelemetry). */
  recordTurnTelemetry(input: {
    sessionId: string;
    workspaceId: string;
    adminUserId: string;
    kind: "chat" | "resume";
    modelCalls: number;
    promptTokens?: number;
    completionTokens?: number;
    /** Prompt tokens served from the provider's cache; omit when the backend reported none. */
    cachedPromptTokens?: number;
    turnMs: number;
    modelMs: number;
  }): void;
  listTurnTelemetry(workspaceId: string, adminUserId: string, sinceIso?: string): TurnTelemetry[];

  /** Delete operational rows + chat_messages/audit_events past their retention windows. */
  pruneExpired(nowIso: string): Promise<PruneCounts>;

  /** Cheap liveness probe — runs a trivial query against the DB handle. THROWS if the
   *  handle is closed/locked/unusable, so a readiness endpoint can 503 a hung instance
   *  (the static /manifest healthcheck can't tell). Returns nothing on success. */
  healthCheck(): void;

  close(): void;
}

/**
 * Test-only extension of {@link Store}. The concrete object returned by
 * `createStore` implements these too, but they are intentionally absent from
 * the production-facing `Store` interface so that only tests reach for them.
 * Cast a `createStore(...)` result to `TestStore` when an assertion needs them.
 */
export interface TestStore extends Store {
  tables(): string[];
  rawAddonTokenForTest(workspaceId: string): string | undefined;
  /** EXPLAIN QUERY PLAN of the exact `listActionOutcomes` statement (for the
   *  index-seek regression test); `detail` lines only. */
  explainActionOutcomesPlan(workspaceId: string, adminUserId: string, sinceIso?: string): string[];
  /** EXPLAIN QUERY PLAN of each `pruneExpired` DELETE, keyed by table (for the
   *  retention index-seek regression test); joined `detail` lines per table. */
  explainPrunePlan(): Record<
    "pendingConfirmations" | "idempotencyKeys" | "undoRecords" | "turnTelemetry" | "chatMessages" | "auditEvents" | "artifacts" | "operationSteps" | "operationRuns" | "intentCapabilities" | "actionResults" | "turnRuns" | "chatSessions" | "retentionRuns",
    string
  >;
  retentionMetricsForTest(): RetentionRunMetric[];
}

export function createStore(databasePath: string, options: StoreOptions = {}): Store {
  const db = new Database(databasePath);
  migrate(db);

  const now = options.now ?? (() => new Date());
  const nowIso = (): string => now().toISOString();
  const encryptionKey = options.encryptionKey;
  const previousEncryptionKey = options.previousEncryptionKey;

  if (encryptionKey && previousEncryptionKey && encryptionKey !== previousEncryptionKey) {
    const rows = db.prepare(
      "SELECT workspace_id, addon_token_ciphertext FROM installations",
    ).all() as Array<{ workspace_id: string; addon_token_ciphertext: string }>;
    db.transaction(() => {
      const update = db.prepare(
        "UPDATE installations SET addon_token_ciphertext = ? WHERE workspace_id = ?",
      );
      for (const row of rows) {
        try {
          decryptSecret(row.addon_token_ciphertext, encryptionKey);
          continue;
        } catch {
          const plaintext = decryptSecret(row.addon_token_ciphertext, previousEncryptionKey);
          update.run(encryptSecret(plaintext, encryptionKey), row.workspace_id);
        }
      }
    })();
  }
  const chatAuditRetentionMs = (options.retentionDays ?? DEFAULT_RETENTION_DAYS) * DAY_MS;

  const sealToken = (token: string): string =>
    encryptionKey ? encryptSecret(token, encryptionKey) : token;
  const openToken = (value: string): string =>
    encryptionKey ? decryptSecret(value, encryptionKey) : value;

  // The shared primitives each concern builder needs (Step 1). Built once here,
  // exactly as the inline methods used them.
  const ctx: StoreContext = { db, now, nowIso, sealToken, openToken };
  const confirmationStore = buildConfirmationStore(ctx);
  const confirmationBatchStore = buildConfirmationBatchStore(ctx);
  const undoStore = buildUndoStore(ctx);
  const operationRunStore = buildOperationRunStore(ctx);
  const assistantWritePreparationStore = buildAssistantWritePreparationStore(ctx, {
    prepareOperationRun: (input) => operationRunStore.prepareOperationRun(input),
    savePendingConfirmation: (record) => confirmationStore.savePendingConfirmation(record),
    insertConfirmationBatch: (input) => confirmationBatchStore.insertConfirmationBatch(input),
  });
  const mutationStepJournal = (operationId: string): MutationStepJournal => ({
    operationId,
    getOperationStatus: () => operationRunStore.getOperationRun(operationId)?.status,
    prepareOperationStep: (input) => operationRunStore.prepareOperationStep({
      ...input,
      operationId,
    }),
    markOperationStepExecuting: (id) => operationRunStore.markOperationStepExecuting(id, operationId),
    markOperationStepDispatched: (id) => operationRunStore.markOperationStepDispatched(id, operationId),
    cancelOperationStepBeforeDispatch: (id, detail) =>
      operationRunStore.cancelOperationStepBeforeDispatch(id, detail, operationId),
    settleOperationStep: (id, status, detail) => operationRunStore.settleOperationStep(id, status, detail, operationId),
    settleOperationStepDegraded: (id, status, detail) =>
      operationRunStore.settleOperationStepDegraded(id, status, detail, operationId),
    settleReconciledStep: (id, status, detail) =>
      operationRunStore.settleReconciledStep(id, status, detail, operationId),
    prepareCompensationStep: (input) => operationRunStore.prepareCompensationStep({
      ...input,
      operationId,
    }),
    markOperationStepCompensating: (id) => operationRunStore.markOperationStepCompensating(id, operationId),
    settleCompensationStep: (id, status, detail) => operationRunStore.settleCompensationStep(id, status, detail, operationId),
    settleCompensationStepDegraded: (id, status, detail) =>
      operationRunStore.settleCompensationStepDegraded(id, status, detail, operationId),
    listOperationSteps: () => operationRunStore.listOperationSteps(operationId),
    recordReconciliation: (stepId, result, authoritative) =>
      operationRunStore.recordOperationReconciliation(operationId, stepId, result, authoritative),
  });

  // Built as TestStore (the concrete object implements the test-only methods),
  // returned as the narrower Store so production callers never see them.
  const store: TestStore = {
    ...buildAdminPolicyStore(ctx),
    ...buildTelemetryStore(ctx),
    ...buildAuditMetricsStore(ctx),
    ...buildMessageStore(ctx),
    ...buildSessionStore(ctx),
    ...undoStore,
    ...buildInstallationStore(ctx),
    ...confirmationStore,
    ...confirmationBatchStore,
    settleConfirmedOperation: (...args) => confirmationStore.settleConfirmation(...args),
    ...buildIdempotencyStore(ctx),
    ...buildRetentionStore(ctx, { chatAuditRetentionMs }),
    ...buildTurnRunStore(ctx),
    ...buildAssistantRunStore(ctx),
    ...(() => {
      const runEventStore = buildRunEventStore(ctx);
      return {
        ...runEventStore,
        listRunEvents(input: import("./store/run-events.js").ListRunEventsStoreInput) {
          return runEventStore.listEvents(input);
        },
      };
    })(),
    ...buildIntentCapabilityStore(ctx),
    ...operationRunStore,
    ...assistantWritePreparationStore,
    startUndoOperation(id, input) {
      return db.transaction(() => {
        if (!undoStore.markUndoExecuting(id)) return undefined;
        const operationId = operationRunStore.prepareOperationRun(input);
        if (!operationRunStore.markOperationExecuting(operationId)) {
          throw new Error("operation_not_prepared");
        }
        return operationId;
      })();
    },
    mutationStepJournal,
    ...buildArtifactStore(ctx),

    tables() {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      return rows.map((r) => r.name);
    },

    rawAddonTokenForTest(workspaceId) {
      const row = db
        .prepare("SELECT addon_token_ciphertext FROM installations WHERE workspace_id = ?")
        .get(workspaceId) as { addon_token_ciphertext: string } | undefined;
      return row?.addon_token_ciphertext;
    },

    explainActionOutcomesPlan(workspaceId, adminUserId, sinceIso) {
      const sql = actionOutcomesSql(sinceIso !== undefined);
      const params = boundedWorkspaceAdminParams(workspaceId, adminUserId, sinceIso);
      const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
        detail: string;
      }>;
      return rows.map((r) => r.detail);
    },

    healthCheck() {
      // A bounded COMMITTED write proves the mounted DB is writable (not merely
      // open). This detects read-only/full/locked volumes before serving traffic.
      const priorBusyTimeout = db.pragma("busy_timeout", { simple: true }) as number;
      db.pragma("busy_timeout = 250");
      try {
        db.prepare("UPDATE readiness_probe SET checked_at = ? WHERE id = 1").run(nowIso());
      } finally {
        db.pragma(`busy_timeout = ${priorBusyTimeout}`);
      }
    },

    recoverOrphanedRuns() {
      return db.transaction(() => {
        const timestamp = nowIso();
        const turns = db.prepare(
          "UPDATE turn_runs SET status = 'outcome_unknown', updated_at = ? WHERE status = 'executing'",
        ).run(timestamp).changes;
        // A dispatched step can have reached Clockify before the process died.
        // Preserve prepared steps as undispatched; executing-but-undispatched steps
        // fail definitively, while dispatched primary or compensation effects remain
        // unknown. Recovery remains read-only: it
        // never creates or dispatches a compensation step in the background.
        // `compensating` is the known-succeeded source marker paired atomically
        // with an executing compensation row. Preserve that known source truth;
        // only the dispatched compensation itself has an unknown outcome.
        db.prepare(
          `UPDATE operation_steps
              SET status = 'succeeded', updated_at = ?
            WHERE status = 'compensating'`,
        ).run(timestamp);
        db.prepare(
          `UPDATE operation_steps
              SET status = 'definitive_failed', settled_at = ?, updated_at = ?
            WHERE status = 'executing' AND dispatched_at IS NULL`,
        ).run(timestamp, timestamp);
        db.prepare(
          `UPDATE operation_steps
              SET status = 'outcome_unknown', settled_at = ?, updated_at = ?
            WHERE status = 'executing' AND dispatched_at IS NOT NULL`,
        ).run(timestamp, timestamp);

        const operationWasDispatched = (operationId: string): boolean =>
          (db.prepare(
            `SELECT 1 FROM operation_steps
              WHERE operation_id = ? AND dispatched_at IS NOT NULL LIMIT 1`,
          ).get(operationId) as { 1: number } | undefined) !== undefined;
        const insertRecoveryResult = (row: {
          session_id: string;
          workspace_id: string;
          admin_user_id: string;
          action_name: string;
        }, operationId?: string, kind: "definitive_failed" | "outcome_unknown" = "outcome_unknown"): ActionResultRef => {
          const id = randomUUID();
          const undispatched = kind === "definitive_failed";
          const result = {
            kind: "receipt",
            receipt: {
              ok: false,
              action: row.action_name,
              code: undispatched ? "operation_cancelled_before_dispatch" : "commit_outcome_unknown",
              message: undispatched
                ? "The server restarted before this queued action reached Clockify. No change was made."
                : "The server restarted while this action was executing, so its outcome is unknown.",
              recovery: undispatched
                ? "Create a fresh request when the service is available."
                : "Verify the result in Clockify before trying the action again.",
            },
          };
          const summary = buildActionResultSummary(id, result);
          db.prepare(
            `INSERT INTO action_results (
               id, operation_id, workspace_id, admin_user_id, session_id, action_name, kind,
               result_json, summary_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            id,
            operationId ?? null,
            row.workspace_id,
            row.admin_user_id,
            row.session_id,
            row.action_name,
            kind,
            actionResultJson(result),
            actionResultJson(summary),
            timestamp,
          );
          return { id, kind, summary };
        };
        const operationResult = (operationId: string): ActionResultRef | undefined => {
          const row = db.prepare(
            `SELECT id, kind, summary_json FROM action_results WHERE operation_id = ?`,
          ).get(operationId) as {
            id: string;
            kind: ActionResultRef["kind"];
            summary_json: string;
          } | undefined;
          return row
            ? { id: row.id, kind: row.kind, summary: JSON.parse(row.summary_json) }
            : undefined;
        };

        const confirmationRows = db.prepare(
          `SELECT c.id, c.operation_id, c.idempotency_key, c.session_id, c.workspace_id, c.admin_user_id,
                  COALESCE(o.action_name, 'unknown_action') AS action_name
             FROM pending_confirmations c
             LEFT JOIN operation_runs o ON o.id = c.operation_id
            WHERE c.status = 'executing'`,
        ).all() as Array<{
          id: string;
          operation_id: string;
          idempotency_key: string | null;
          session_id: string;
          workspace_id: string;
          admin_user_id: string;
          action_name: string;
        }>;
        let operations = 0;
        for (const row of confirmationRows) {
          const recoveryKind = operationWasDispatched(row.operation_id) ? "outcome_unknown" : "definitive_failed";
          const ref = operationResult(row.operation_id) ?? insertRecoveryResult(row, row.operation_id, recoveryKind);
          db.prepare(
            `UPDATE pending_confirmations
                SET status = ?, action_result_id = ?, result_summary_json = ?,
                    nonce_hash = '', operation_json = NULL, agent_state_json = NULL,
                    idempotency_key = NULL
              WHERE id = ? AND status = 'executing'`,
          ).run(ref.kind, ref.id, actionResultJson(ref.summary), row.id);
          operations += db.prepare(
            `UPDATE operation_runs
                SET status = ?, action_result_id = ?, updated_at = ?
              WHERE id = ? AND status = 'executing'`,
          ).run(ref.kind, ref.id, timestamp, row.operation_id).changes;
          if (row.idempotency_key) {
            db.prepare(
              `UPDATE idempotency_keys
                  SET action_result_id = ?, result_summary_json = ?, committed_at = ?, claimed_at = ?
                WHERE key = ? AND workspace_id = ? AND admin_user_id = ?
                  AND action_result_id IS NULL`,
            ).run(
              ref.id,
              actionResultJson(ref.summary),
              now().getTime(),
              now().getTime(),
              row.idempotency_key,
              row.workspace_id,
              row.admin_user_id,
            );
          }
        }

        // Route-backed undos persist their undo id inside the operation envelope.
        // Recover each pair before the generic operation/undo passes so both
        // terminal rows share the operation-owned canonical result. Legacy undo
        // rows have no matching operation and continue through the standalone
        // undo path below.
        const linkedUndoRows = db.prepare(
          `SELECT u.id, u.session_id, u.workspace_id, u.admin_user_id, o.id AS operation_id,
                  o.action_name
             FROM undo_records u
             JOIN operation_runs o
               ON o.session_id = u.session_id
              AND o.workspace_id = u.workspace_id
              AND o.admin_user_id = u.admin_user_id
              AND o.action_name = 'undo'
              AND o.status = 'executing'
              AND json_extract(o.operation_json, '$.operation.undoId') = u.id
            WHERE u.status = 'executing'`,
        ).all() as Array<{
          id: string;
          session_id: string;
          workspace_id: string;
          admin_user_id: string;
          operation_id: string;
          action_name: string;
        }>;
        let undos = 0;
        for (const row of linkedUndoRows) {
          const recoveryKind = operationWasDispatched(row.operation_id) ? "outcome_unknown" : "definitive_failed";
          const ref = operationResult(row.operation_id) ?? insertRecoveryResult(row, row.operation_id, recoveryKind);
          operations += db.prepare(
            `UPDATE operation_runs
                SET status = ?, action_result_id = ?, updated_at = ?
              WHERE id = ? AND status = 'executing'`,
          ).run(ref.kind, ref.id, timestamp, row.operation_id).changes;
          undos += db.prepare(
            `UPDATE undo_records
                SET status = ?, action_result_id = ?,
                    result_summary_json = ?, undone_at = ?
              WHERE id = ? AND status = 'executing'`,
          ).run(
            recoveryKind === "outcome_unknown" ? "outcome_unknown" : "failed",
            ref.id,
            actionResultJson(ref.summary),
            timestamp,
            row.id,
          ).changes;
        }

        const standaloneOperations = db.prepare(
          `SELECT session_id, workspace_id, admin_user_id, action_name, id
             FROM operation_runs
            WHERE status = 'executing'`,
        ).all() as Array<{
          id: string;
          session_id: string;
          workspace_id: string;
          admin_user_id: string;
          action_name: string;
        }>;
        for (const row of standaloneOperations) {
          const recoveryKind = operationWasDispatched(row.id) ? "outcome_unknown" : "definitive_failed";
          const ref = operationResult(row.id) ?? insertRecoveryResult(row, row.id, recoveryKind);
          operations += db.prepare(
            `UPDATE operation_runs
                SET status = ?, action_result_id = ?, updated_at = ?
              WHERE id = ? AND status = 'executing'`,
          ).run(ref.kind, ref.id, timestamp, row.id).changes;
        }
        const undoRows = db.prepare(
          `SELECT id, session_id, workspace_id, admin_user_id
             FROM undo_records WHERE status = 'executing'`,
        ).all() as Array<{
          id: string;
          session_id: string;
          workspace_id: string;
          admin_user_id: string;
        }>;
        for (const row of undoRows) {
          const ref = insertRecoveryResult({ ...row, action_name: "undo" });
          undos += db.prepare(
            `UPDATE undo_records
                SET status = 'outcome_unknown', action_result_id = ?,
                    result_summary_json = ?, undone_at = ?
              WHERE id = ? AND status = 'executing'`,
          ).run(ref.id, actionResultJson(ref.summary), timestamp, row.id).changes;
        }
        const confirmations = confirmationRows.length;
        const executingBatches = db.prepare(
          "SELECT id FROM confirmation_batches WHERE status = 'executing'",
        ).all() as Array<{ id: string }>;
        for (const row of executingBatches) {
          confirmationBatchStore.recoverConfirmationBatch(row.id, timestamp);
        }
        const assistantRuns = db.prepare(
          `UPDATE assistant_runs SET phase = 'failed', updated_at = ?
            WHERE phase IN ('model', 'discovering', 'executing_reads', 'preparing_writes')`,
        ).run(timestamp).changes;
        if (assistantRuns > 0) {
          db.prepare(
            `UPDATE turn_runs SET status = 'failed', updated_at = ?
              WHERE status IN ('prepared', 'executing')
                AND request_id IN (
                  SELECT run_id FROM assistant_runs
                   WHERE phase = 'failed' AND updated_at = ?
                )`,
          ).run(timestamp, timestamp);
        }
        return { turns, operations, confirmations, undos, assistantRuns };
      })();
    },

    close() {
      db.close();
    },
  };

  store.recoverOrphanedRuns();

  return store;
}
