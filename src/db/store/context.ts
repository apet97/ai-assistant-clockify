import type Database from "better-sqlite3";
import type { RiskLabel } from "../../harness/risk.js";
import type { SuccessReceipt, ErrorReceipt, EntityRef } from "../../harness/receipts.js";
import type { ActionResultRef } from "../action-results.js";
import type { ExternalMutationPlan } from "../../harness/action.js";

/**
 * Shared primitives every store concern module needs. Built once inside
 * `createStore` (after opening `db` and the crypto helpers) and passed to each
 * `build<Concern>Store(ctx)` builder. This is a LEAF module (imports only the
 * better-sqlite3 type + upstream harness types) so the concern modules and
 * `store.ts` can both import it without madge seeing a cycle.
 */
export interface StoreContext {
  /** The better-sqlite3 handle. */
  db: Database.Database;
  /** Injectable clock; tests advance it. */
  now: () => Date;
  nowIso: () => string;
  /** AES-256-GCM seal/open keyed from DATA_ENCRYPTION_KEY (no-op when unset). */
  sealToken: (plain: string) => string;
  openToken: (ciphertext: string) => string;
}

/*
 * Data-shape types shared between `store.ts` (the facade, which re-exports them
 * so every `../db/store.js` import stays byte-identical) and the per-concern
 * builder modules that take/return them. They live in this leaf so a concern
 * module can import its method's argument/return types without creating a
 * `store.ts ↔ store/<concern>.ts` cycle. Definitions are moved here VERBATIM.
 */

export type InstallationStatus = "active" | "inactive" | "deleted";

export interface InstallationInput {
  workspaceId: string;
  addonId: string;
  addonUserId: string;
  addonToken: string;
  apiUrl?: string;
  backendUrl?: string;
  reportsUrl?: string;
  status?: InstallationStatus;
  installedByUserId?: string;
}

export interface Installation {
  workspaceId: string;
  addonId: string;
  addonUserId: string;
  addonToken: string;
  apiUrl?: string;
  backendUrl?: string;
  reportsUrl?: string;
  status: InstallationStatus;
  installedByUserId?: string;
  installedAt: string;
  updatedAt: string;
}

/** Environment URLs refreshed from the latest verified token (component load). */
export interface InstallationEnv {
  apiUrl?: string;
  backendUrl?: string;
  reportsUrl?: string;
}

export interface ChatSession {
  id: string;
  workspaceId: string;
  adminUserId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export interface NewSessionInput {
  workspaceId: string;
  adminUserId: string;
  ttlMs?: number;
}

/**
 * A summary of one chat session for the history switcher: the session id, a
 * display title (the first USER message), the total message count, and the
 * last-activity timestamp. Only live (non-expired), owned, non-empty sessions
 * are surfaced (see {@link Store.listSessions}).
 */
export interface SessionSummary {
  id: string;
  title: string;
  messageCount: number;
  lastMessageAt: string;
  createdAt: string;
}

export type ChatRole = "user" | "assistant" | "system";

export interface NewMessageInput {
  sessionId: string;
  workspaceId: string;
  adminUserId: string;
  role: ChatRole;
  content: string;
  payload?: unknown;
  resultLinks?: DurableResultLink[];
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  payload?: unknown;
}

export type DurableResultLink =
  | { kind: "action_result"; ref: ActionResultRef }
  | { kind: "preview" | "inline"; descriptor: unknown };

export type TurnRunStatus = "prepared" | "executing" | "succeeded" | "failed" | "outcome_unknown";

export interface TurnRunClaimInput {
  requestId: string;
  sessionId: string;
  workspaceId: string;
  adminUserId: string;
  intentHash: string;
}

export type TurnRunClaimResult =
  | { state: "won" }
  | { state: "in_flight" }
  | { state: "conflict" }
  | { state: "outcome_unknown" }
  | { state: "replay"; response: unknown };

export interface TurnRun extends TurnRunClaimInput {
  status: TurnRunStatus;
  response?: unknown;
  createdAt: string;
  updatedAt: string;
}

export type OperationRunStatus =
  | "prepared"
  | "executing"
  | "succeeded"
  | "partial"
  | "definitive_failed"
  | "outcome_unknown";

export interface PrepareOperationRunInput {
  id?: string;
  requestId?: string;
  confirmationId?: string;
  sessionId: string;
  workspaceId: string;
  adminUserId: string;
  actionName: string;
  actionFingerprint: string;
  catalogHash: string;
  operationHash: string;
  /** Normalized nonsecret wire intent. Legacy callers omit it explicitly. */
  operation?: unknown;
  mutationPlan?: ExternalMutationPlan;
  /** Reserved for the persisted intent-capability phase. */
  capabilityHash?: string;
}

export interface OperationRun extends Omit<PrepareOperationRunInput, "id"> {
  id: string;
  status: OperationRunStatus;
  actionResultId?: string;
  reconciledAt?: string;
  reconciliation?: unknown;
  createdAt: string;
  updatedAt: string;
}

export type OperationStepKind = "primary" | "compensation";
export type OperationStepStatus =
  | "prepared"
  | "executing"
  | "succeeded"
  | "definitive_failed"
  | "outcome_unknown"
  | "compensating"
  | "compensated"
  | "compensation_failed"
  | "skipped";

export interface PrepareOperationStepInput {
  id?: string;
  operationId: string;
  planStepId: string;
  index: number;
  name: string;
  kind: OperationStepKind;
  targetFingerprint?: string;
  compensatesStepId?: string;
}

export interface PrepareCompensationStepInput
  extends Omit<PrepareOperationStepInput, "kind" | "compensatesStepId"> {
  compensatesStepId: string;
}

export interface OperationStep extends Omit<PrepareOperationStepInput, "id"> {
  id: string;
  status: OperationStepStatus;
  externalId?: string;
  effect?: unknown;
  detail?: unknown;
  dispatchedAt?: string;
  settledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactRecord {
  id: string;
  workspaceId: string;
  adminUserId: string;
  sessionId: string;
  contentType: string;
  filename: string;
  bytes: Uint8Array;
  checksum: string;
  createdAt: string;
  expiresAt: string;
}

interface AuditEventBase {
  workspaceId: string;
  adminUserId: string;
  sessionId?: string;
  actionName: string;
  risk: RiskLabel[];
}

export type AuditEventInput = AuditEventBase & (
  | { resultRef: ActionResultRef; receipt?: never }
  | { resultRef?: never; receipt: SuccessReceipt | ErrorReceipt | Record<string, unknown> }
);

export interface UndoRecordInput {
  sessionId: string;
  workspaceId: string;
  adminUserId: string;
  actionName: string;
  reversal: EntityRef[];
}

export interface UndoRecord extends UndoRecordInput {
  id: string;
  status: "available" | "executing" | "partially_undone" | "undone" | "failed" | "outcome_unknown" | "expired";
  remaining: EntityRef[];
  createdAt: string;
  expiresAt: string;
  undoneAt?: string;
}

/** Rows deleted per table by {@link Store.eraseWorkspace}. */
export interface EraseCounts {
  installations: number;
  adminPolicies: number;
  chatSessions: number;
  chatMessages: number;
  pendingConfirmations: number;
  auditEvents: number;
  undoRecords: number;
  turnTelemetry: number;
  turnRuns: number;
  operationSteps: number;
  operationRuns: number;
  actionResults: number;
  artifacts: number;
  idempotencyKeys: number;
  turnRunResultLinks: number;
  chatMessageResultLinks: number;
}
