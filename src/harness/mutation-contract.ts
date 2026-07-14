/** Exact external dispatch order persisted before the first host mutation. */
export interface ExternalMutationPlan {
  mode: "single" | "curated" | "batch";
  steps: Array<{
    id: string;
    kind: "primary" | "compensation";
    targetFingerprint?: string;
  }>;
}

export type JournaledOperationStatus =
  | "prepared"
  | "executing"
  | "succeeded"
  | "partial"
  | "definitive_failed"
  | "outcome_unknown";

export type JournaledStepStatus =
  | "prepared"
  | "executing"
  | "succeeded"
  | "definitive_failed"
  | "outcome_unknown"
  | "compensating"
  | "compensated"
  | "compensation_failed"
  | "skipped";

export interface JournaledMutationStep {
  id: string;
  operationId: string;
  planStepId: string;
  index: number;
  name: string;
  kind: "primary" | "compensation";
  status: JournaledStepStatus;
  targetFingerprint?: string;
  compensatesStepId?: string;
  externalId?: string;
  effect?: unknown;
  detail?: unknown;
  dispatchedAt?: string;
  settledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScopedPreparePrimaryStep {
  id?: string;
  planStepId: string;
  index: number;
  name: string;
  kind: "primary";
  targetFingerprint?: string;
}

export interface ScopedPrepareCompensationStep {
  id?: string;
  planStepId: string;
  index: number;
  name: string;
  targetFingerprint?: string;
  compensatesStepId: string;
}

/**
 * Durable step capabilities bound to one operation. Callers cannot redirect a
 * step to another operation id, and lifecycle ownership remains outside this
 * surface (safe-write start or the one-use confirmation claim).
 */
export interface MutationStepJournal {
  readonly operationId: string;
  getOperationStatus(): JournaledOperationStatus | undefined;
  prepareOperationStep(input: ScopedPreparePrimaryStep): string;
  markOperationStepExecuting(id: string): boolean;
  settleOperationStep(
    id: string,
    status: "succeeded" | "definitive_failed" | "outcome_unknown",
    detail?: { externalId?: string; effect?: unknown; detail?: unknown },
  ): void;
  prepareCompensationStep(input: ScopedPrepareCompensationStep): string;
  markOperationStepCompensating(id: string): boolean;
  settleCompensationStep(
    id: string,
    status: "compensated" | "compensation_failed" | "outcome_unknown",
    detail?: { externalId?: string; effect?: unknown; detail?: unknown },
  ): void;
  listOperationSteps(): JournaledMutationStep[];
}
