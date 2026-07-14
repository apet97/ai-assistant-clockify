import type {
  OperationStep,
  PrepareOperationStepInput,
} from "../db/store.js";
import {
  AmbiguousWriteOutcome,
  DefinitiveWriteFailure,
} from "../clockify/write-outcome.js";
import type { CommitResult } from "./action.js";
import { errorReceipt, type ErrorReceipt, type SuccessReceipt } from "./receipts.js";

/** The synchronous durable boundary required by one external mutation step. */
export interface MutationStepJournal {
  markOperationExecuting(operationId: string): boolean;
  prepareOperationStep(input: PrepareOperationStepInput): string;
  markOperationStepExecuting(id: string): boolean;
  settleOperationStep(
    id: string,
    status: "succeeded" | "definitive_failed" | "outcome_unknown",
    detail?: { externalId?: string; effect?: unknown; detail?: unknown },
  ): void;
  listOperationSteps(operationId: string): OperationStep[];
}

export interface MutationDispatchResult {
  externalId?: string;
  effect?: unknown;
  detail?: unknown;
}

export interface ExecutableMutationStep {
  /** Stable id from ExternalMutationPlan (not the generated database row id). */
  id: string;
  index: number;
  name: string;
  kind: "primary" | "compensation";
  targetFingerprint?: string;
  compensatesStepId?: string;
  dispatch: () => Promise<MutationDispatchResult>;
}

function safeFailureDetail(error: unknown): Record<string, unknown> {
  if (error instanceof AmbiguousWriteOutcome || error instanceof DefinitiveWriteFailure) {
    return {
      type: error.name,
      method: error.method,
      path: error.path,
      ...(error.status === undefined ? {} : { status: error.status }),
      message: error.message,
    };
  }
  return {
    type: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Execute one and only one injected host mutation. The durable ordering is:
 * prepared -> executing (committed synchronously) -> dispatch -> terminal.
 * Any non-definitive exception after dispatch begins is ambiguous by default.
 */
export async function executeStep(input: {
  journal: MutationStepJournal;
  operationId: string;
  step: Omit<ExecutableMutationStep, "dispatch">;
  dispatch: () => Promise<MutationDispatchResult>;
}): Promise<OperationStep> {
  const stepId = input.journal.prepareOperationStep({
    operationId: input.operationId,
    planStepId: input.step.id,
    index: input.step.index,
    name: input.step.name,
    kind: input.step.kind,
    ...(input.step.targetFingerprint ? { targetFingerprint: input.step.targetFingerprint } : {}),
    ...(input.step.compensatesStepId ? { compensatesStepId: input.step.compensatesStepId } : {}),
  });
  if (!input.journal.markOperationStepExecuting(stepId)) {
    throw new Error("operation_step_not_prepared");
  }

  try {
    const dispatched = await input.dispatch();
    input.journal.settleOperationStep(stepId, "succeeded", dispatched);
  } catch (error) {
    const status = error instanceof DefinitiveWriteFailure
      ? "definitive_failed"
      : "outcome_unknown";
    input.journal.settleOperationStep(stepId, status, { detail: safeFailureDetail(error) });
  }

  const settled = input.journal.listOperationSteps(input.operationId).find((step) => step.id === stepId);
  if (!settled) throw new Error("operation_step_not_found");
  return settled;
}

export interface ExecuteMutationWorkflowInput {
  journal: MutationStepJournal;
  operationId: string;
  actionName: string;
  steps: ExecutableMutationStep[];
  onSuccess(completed: OperationStep[]): SuccessReceipt;
  onPartial(
    completed: OperationStep[],
    failed: OperationStep,
  ): Extract<CommitResult, { kind: "partial" }>;
  onFailure(failed: OperationStep): ErrorReceipt;
}

/**
 * Run primary steps in declared order. Unknown stops immediately and is never
 * auto-retried. A later definitive rejection after known effects is partial;
 * compensation is deliberately not attempted here (it needs explicit evidence
 * and a separately declared compensation step).
 */
export async function executeMutationWorkflow(
  input: ExecuteMutationWorkflowInput,
): Promise<CommitResult> {
  if (!input.journal.markOperationExecuting(input.operationId)) {
    throw new Error("operation_not_prepared");
  }
  const completed: OperationStep[] = [];
  for (const step of input.steps) {
    if (step.kind !== "primary") continue;
    const result = await executeStep({
      journal: input.journal,
      operationId: input.operationId,
      step,
      dispatch: step.dispatch,
    });
    if (result.status === "succeeded") {
      completed.push(result);
      continue;
    }
    if (result.status === "outcome_unknown") {
      return errorReceipt({
        action: input.actionName,
        code: "commit_outcome_unknown",
        message:
          "Clockify did not provide a definitive response, so this change may or may not have been applied. No later step was dispatched.",
        recovery: {
          hint: "Verify the recorded step in Clockify before deciding whether to try again.",
          retryable: false,
        },
      });
    }
    return completed.length > 0
      ? input.onPartial(completed, result)
      : input.onFailure(result);
  }
  return input.onSuccess(completed);
}
