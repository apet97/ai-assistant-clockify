import { createHash } from "node:crypto";
import type { AuthClass } from "../harness/api-operation.js";

export type RunPhase =
  | "model"
  | "discovering"
  | "executing_reads"
  | "preparing_writes"
  | "awaiting_confirmation"
  | "awaiting_clarification"
  | "completed"
  | "failed";

export interface RunBudget {
  modelCallsUsed: number;
  discoveryCallsUsed: number;
  apiCallsUsed: number;
  hostCallsUsed: number;
  hostCallsReserved: number;
  promptTokensUsed: number;
  completionTokensUsed: number;
  estimatedTokensUsed: number;
  activeWallMsUsed: number;
}

export type RunContinuation =
  | { kind: "none" }
  | { kind: "awaiting_operations"; operationIds: string[]; batchId?: string }
  | { kind: "awaiting_clarification"; clarificationId: string };

export interface UnfinishedOperation {
  id: string;
  operationId?: string;
  actionName: string;
  reason:
    | "pending_confirmation"
    | "dependency"
    | "budget"
    | "definitive_failure"
    | "outcome_unknown";
}

export interface CompletedToolResult {
  toolCallId: string;
  actionName: string;
  actionResultId: string;
}

export interface RunState {
  version: 2;
  runId: string;
  sessionId: string;
  workspaceId: string;
  adminUserId: string;
  installationGeneration: number;
  authClass: AuthClass;
  originalRequest: string;
  requestHash: string;
  phase: RunPhase;
  registryId: "v2-api";
  catalogHash: string;
  loadedToolNames: string[];
  usedToolNames: string[];
  completedResults: CompletedToolResult[];
  pendingOperationIds: string[];
  unfinishedOperations: UnfinishedOperation[];
  continuation: RunContinuation;
  budget: RunBudget;
  createdAt: string;
  updatedAt: string;
}

export const TERMINAL_RUN_PHASES: ReadonlySet<RunPhase> = new Set(["completed", "failed"]);

export const ACTIVE_RUN_PHASES: ReadonlySet<RunPhase> = new Set([
  "model",
  "discovering",
  "executing_reads",
  "preparing_writes",
]);

export function createEmptyRunBudget(): RunBudget {
  return {
    modelCallsUsed: 0,
    discoveryCallsUsed: 0,
    apiCallsUsed: 0,
    hostCallsUsed: 0,
    hostCallsReserved: 0,
    promptTokensUsed: 0,
    completionTokensUsed: 0,
    estimatedTokensUsed: 0,
    activeWallMsUsed: 0,
  };
}

/** Task 17 repeated-request metric key — distinct from turn_runs.intent_hash. */
export function computeRequestHash(originalRequest: string): string {
  const normalized = originalRequest.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function totalChargedTokens(budget: RunBudget): number {
  return budget.promptTokensUsed + budget.completionTokensUsed + budget.estimatedTokensUsed;
}

export function hostCallsCommitted(budget: RunBudget): number {
  return budget.hostCallsUsed + budget.hostCallsReserved;
}

export function isTerminalPhase(phase: RunPhase): boolean {
  return TERMINAL_RUN_PHASES.has(phase);
}
