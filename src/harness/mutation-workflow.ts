import type {
  JournaledMutationStep,
  MutationStepJournal,
} from "./mutation-contract.js";
export type { MutationStepJournal } from "./mutation-contract.js";
import {
  AmbiguousWriteOutcome,
  DefinitiveWriteFailure,
} from "../clockify/write-outcome.js";
import type { CommitResult } from "./action.js";
import { errorReceipt, type ErrorReceipt, type SuccessReceipt } from "./receipts.js";
import { classifyLoggableError } from "../log-error-class.js";
import { boundedCompleteSanitizedJson, exactNonsecretJson } from "./safe-json.js";
import {
  MutationDispatchDenied,
  MutationPlanViolation,
  withMutationPlanStep,
} from "../clockify/rest/core.js";
import {
  HostCallBudgetExceededError,
  HostRequestCancelledError,
} from "../clockify/request-governor.js";

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
  /** Sanitized evidence persisted on the prepared row before dispatch. */
  preparedDetail?: unknown;
  compensatesStepId?: string;
  dispatch: () => Promise<MutationDispatchResult>;
}

function safeFailureDetail(error: unknown): Record<string, unknown> {
  if (error instanceof MutationDispatchDenied) {
    return { type: error.name, code: "mutation_dispatch_denied", denial: error.denial, message: error.message };
  }
  if (error instanceof MutationPlanViolation) {
    return { type: error.name, code: error.code, message: error.message };
  }
  if (error instanceof HostCallBudgetExceededError || error instanceof HostRequestCancelledError) {
    return { type: error.name, code: error.code, message: error.message };
  }
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

function degradedSettlementDetail(input: {
  settlementError: unknown;
  dispatchStatus: string;
  dispatchDetail?: unknown;
}): Record<string, unknown> {
  return {
    journalDegraded: true,
    fullEffectPersisted: false,
    dispatchStatus: input.dispatchStatus,
    settlementError: safeFailureDetail(input.settlementError),
    ...(input.dispatchDetail === undefined ? {} : { dispatchDetail: input.dispatchDetail }),
  };
}

function logDegradedSettlement(kind: "primary" | "compensation", error: unknown): void {
  console.error(
    `${kind} mutation step settlement remained degraded after dispatch: ${classifyLoggableError(error)}`,
  );
}

function runtimeStep(input: {
  base: JournaledMutationStep;
  status: JournaledMutationStep["status"];
  outcome?: MutationDispatchResult;
  detail?: unknown;
}): JournaledMutationStep {
  return {
    ...input.base,
    status: input.status,
    ...(input.outcome?.externalId === undefined ? {} : { externalId: input.outcome.externalId }),
    ...(input.outcome?.effect === undefined ? {} : { effect: input.outcome.effect }),
    ...(input.detail === undefined
      ? input.outcome?.detail === undefined
        ? {}
        : { detail: input.outcome.detail }
      : { detail: input.detail }),
  };
}

function combinePreparedDetail(prepared: unknown, dispatched: unknown): unknown {
  if (prepared === undefined) return dispatched;
  if (dispatched === undefined) return prepared;
  if (prepared && typeof prepared === "object" && !Array.isArray(prepared)) {
    return { ...(prepared as Record<string, unknown>), dispatch: dispatched };
  }
  return { preDispatch: prepared, dispatch: dispatched };
}

/**
 * Execute one and only one injected host mutation. The durable ordering is:
 * prepared -> executing (committed synchronously) -> dispatch -> terminal.
 * Dispatch classification and post-dispatch persistence are deliberately
 * separate: a settlement error can degrade the journal, but cannot rewrite a
 * known host success as a retryable/definitive failure.
 */
export async function executeStep(input: {
  journal: MutationStepJournal;
  operationId: string;
  step: Omit<ExecutableMutationStep, "dispatch">;
  dispatch: () => Promise<MutationDispatchResult>;
}): Promise<JournaledMutationStep> {
  if (input.step.kind !== "primary") {
    throw new Error("compensation_requires_dedicated_executor");
  }
  if (input.journal.operationId !== input.operationId) {
    throw new Error("operation_journal_scope_mismatch");
  }
  if (input.journal.getOperationStatus() !== "executing") {
    throw new Error("operation_not_executing");
  }
  const preparedDetail = input.step.preparedDetail === undefined
    ? undefined
    : exactNonsecretJson(input.step.preparedDetail, 55_000);
  const stepId = input.journal.prepareOperationStep({
    planStepId: input.step.id,
    index: input.step.index,
    name: input.step.name,
    kind: "primary",
    ...(input.step.targetFingerprint ? { targetFingerprint: input.step.targetFingerprint } : {}),
    ...(preparedDetail === undefined ? {} : { preparedDetail }),
  });
  if (!input.journal.markOperationStepExecuting(stepId)) {
    throw new Error("operation_step_not_prepared");
  }
  const executing = input.journal.listOperationSteps().find((step) => step.id === stepId);
  if (!executing) throw new Error("operation_step_not_found");

  let status: "succeeded" | "definitive_failed" | "outcome_unknown";
  let outcome: MutationDispatchResult;
  try {
    outcome = await withMutationPlanStep(
      { id: input.step.id, index: input.step.index, kind: "primary" },
      input.dispatch,
    );
    status = "succeeded";
  } catch (error) {
    status = error instanceof DefinitiveWriteFailure ||
      error instanceof MutationDispatchDenied || error instanceof MutationPlanViolation ||
      error instanceof HostCallBudgetExceededError || error instanceof HostRequestCancelledError
      ? "definitive_failed"
      : "outcome_unknown";
    outcome = { detail: safeFailureDetail(error) };
    if (error instanceof HostRequestCancelledError) {
      const cancellationDetail = preparedDetail === undefined
        ? outcome.detail
        : combinePreparedDetail(preparedDetail, outcome.detail);
      if (input.journal.cancelOperationStepBeforeDispatch(stepId, cancellationDetail)) {
        const cancelled = input.journal.listOperationSteps().find((step) => step.id === stepId);
        if (!cancelled) throw new Error("operation_step_not_found");
        return cancelled;
      }
      // A cancellation is definitive only while the durable row proves that no
      // external dispatch occurred. Otherwise preserve conservative uncertainty.
      status = "outcome_unknown";
    }
  }
  outcome = {
    ...outcome,
    ...(preparedDetail === undefined
      ? {}
      : { detail: combinePreparedDetail(
          preparedDetail,
          outcome.detail === undefined ? undefined : boundedCompleteSanitizedJson(outcome.detail, 8_000),
        ) }),
  };

  try {
    input.journal.settleOperationStep(stepId, status, outcome);
  } catch (settlementError) {
    const detail = degradedSettlementDetail({
      settlementError,
      dispatchStatus: status,
      ...(outcome.detail === undefined ? {} : { dispatchDetail: outcome.detail }),
    });
    try {
      input.journal.settleOperationStepDegraded(stepId, status, {
        ...(outcome.externalId === undefined ? {} : { externalId: outcome.externalId }),
        detail,
      });
      const degraded = input.journal.listOperationSteps().find((step) => step.id === stepId);
      if (degraded) return degraded;
    } catch (fallbackError) {
      logDegradedSettlement("primary", fallbackError);
    }
    const { dispatchDetail: _dispatchDetail, ...degradation } = detail;
    const runtimeDetail = preparedDetail && typeof preparedDetail === "object" && !Array.isArray(preparedDetail)
      ? { ...(preparedDetail as Record<string, unknown>), ...degradation }
      : { ...(preparedDetail === undefined ? {} : { preDispatch: preparedDetail }), ...degradation };
    return runtimeStep({ base: executing, status, outcome, detail: runtimeDetail });
  }

  const settled = input.journal.listOperationSteps().find((step) => step.id === stepId);
  if (!settled) throw new Error("operation_step_not_found");
  return settled;
}

/**
 * Execute one eligible compensation step through its distinct durable state
 * machine. Eligibility is decided transactionally by prepareCompensationStep;
 * dispatch begins only after the source and compensation rows move atomically
 * to compensating/executing.
 */
export async function executeCompensationStep(input: {
  journal: MutationStepJournal;
  operationId: string;
  step: Omit<ExecutableMutationStep, "dispatch"> & {
    kind: "compensation";
    compensatesStepId: string;
  };
  dispatch: () => Promise<MutationDispatchResult>;
}): Promise<JournaledMutationStep> {
  if (input.journal.operationId !== input.operationId) {
    throw new Error("operation_journal_scope_mismatch");
  }
  const stepId = input.journal.prepareCompensationStep({
    planStepId: input.step.id,
    index: input.step.index,
    name: input.step.name,
    compensatesStepId: input.step.compensatesStepId,
    ...(input.step.targetFingerprint ? { targetFingerprint: input.step.targetFingerprint } : {}),
  });
  if (!input.journal.markOperationStepCompensating(stepId)) {
    throw new Error("compensation_step_not_prepared");
  }
  const executing = input.journal.listOperationSteps().find((step) => step.id === stepId);
  if (!executing) throw new Error("compensation_step_not_found");

  let status: "compensated" | "compensation_failed" | "outcome_unknown";
  let outcome: MutationDispatchResult;
  try {
    outcome = await withMutationPlanStep(
      { id: input.step.id, index: input.step.index, kind: "compensation" },
      input.dispatch,
    );
    status = "compensated";
  } catch (error) {
    status = error instanceof DefinitiveWriteFailure ||
      error instanceof MutationDispatchDenied || error instanceof MutationPlanViolation ||
      error instanceof HostCallBudgetExceededError || error instanceof HostRequestCancelledError
      ? "compensation_failed"
      : "outcome_unknown";
    outcome = { detail: safeFailureDetail(error) };
  }

  try {
    input.journal.settleCompensationStep(stepId, status, outcome);
  } catch (settlementError) {
    const detail = degradedSettlementDetail({
      settlementError,
      dispatchStatus: status,
      ...(outcome.detail === undefined ? {} : { dispatchDetail: outcome.detail }),
    });
    try {
      input.journal.settleCompensationStepDegraded(stepId, status, {
        ...(outcome.externalId === undefined ? {} : { externalId: outcome.externalId }),
        detail,
      });
    } catch (fallbackError) {
      logDegradedSettlement("compensation", fallbackError);
    }
    return runtimeStep({ base: executing, status, outcome, detail });
  }

  const settled = input.journal.listOperationSteps().find((step) => step.id === stepId);
  if (!settled) throw new Error("compensation_step_not_found");
  return settled;
}

export interface ExecuteMutationWorkflowInput {
  journal: MutationStepJournal;
  operationId: string;
  actionName: string;
  steps: ExecutableMutationStep[];
  onSuccess(completed: JournaledMutationStep[]): SuccessReceipt;
  onPartial(
    completed: JournaledMutationStep[],
    failed: JournaledMutationStep,
  ): Extract<CommitResult, { kind: "partial" }>;
  onJournalDegraded(
    completedIncludingDegraded: JournaledMutationStep[],
    degraded: JournaledMutationStep,
  ): Extract<CommitResult, { kind: "partial" }>;
  onFailure(failed: JournaledMutationStep): ErrorReceipt;
}

export function isJournalDegradedStep(step: JournaledMutationStep): boolean {
  return typeof step.detail === "object" && step.detail !== null &&
    (step.detail as { journalDegraded?: unknown }).journalDegraded === true;
}

export function withJournalDegradedWarning(receipt: SuccessReceipt): SuccessReceipt {
  if (receipt.warnings?.some((warning) => warning.code === "operation_journal_degraded")) {
    return receipt;
  }
  return {
    ...receipt,
    warnings: [
      ...(receipt.warnings ?? []),
      {
        code: "operation_journal_degraded",
        message:
          "Clockify confirmed the change, but the full local step record could not be saved. The operation will not be retried automatically.",
      },
    ],
  };
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
  if (input.journal.operationId !== input.operationId) {
    throw new Error("operation_journal_scope_mismatch");
  }
  if (input.journal.getOperationStatus() !== "executing") {
    throw new Error("operation_not_executing");
  }
  const primaryStepCount = input.steps.filter((step) => step.kind === "primary").length;
  const completed: JournaledMutationStep[] = [];
  for (const step of input.steps) {
    if (step.kind !== "primary") continue;
    const result = await executeStep({
      journal: input.journal,
      operationId: input.operationId,
      step,
      dispatch: step.dispatch,
    });
    if (result.status === "succeeded" && isJournalDegradedStep(result)) {
      if (primaryStepCount === 1) {
        return withJournalDegradedWarning(input.onSuccess([result]));
      }
      return input.onJournalDegraded([...completed, result], result);
    }
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
    const controlDetail = result.detail && typeof result.detail === "object"
      ? result.detail as { code?: unknown; denial?: unknown }
      : undefined;
    if (completed.length === 0 && controlDetail?.code === "mutation_dispatch_denied" &&
      controlDetail.denial && typeof controlDetail.denial === "object") {
      return controlDetail.denial as ErrorReceipt;
    }
    if (completed.length === 0 && controlDetail?.code === "mutation_plan_violation") {
      return errorReceipt({
        action: input.actionName,
        code: "mutation_plan_violation",
        message: "A host mutation was blocked because it did not match the exact stored plan.",
        recovery: { hint: "Create a fresh preview from the current action catalog.", retryable: false },
      });
    }
    return completed.length > 0
      ? input.onPartial(completed, result)
      : input.onFailure(result);
  }
  return input.onSuccess(completed);
}
