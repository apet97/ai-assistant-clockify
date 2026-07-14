import type {
  ActionContext,
  CommitResult,
  ConfirmableOperation,
  ExternalMutationPlan,
} from "./action.js";
import type { JournaledMutationStep } from "./mutation-contract.js";
import {
  executeStep,
  isJournalDegradedStep,
  type MutationDispatchResult,
  withJournalDegradedWarning,
} from "./mutation-workflow.js";
import {
  DefinitiveWriteFailure,
} from "../clockify/write-outcome.js";
import { errorReceipt, type SuccessReceipt } from "./receipts.js";

function syntheticStep(input: {
  operationId: string;
  planStepId: string;
  index: number;
  name: string;
  status: JournaledMutationStep["status"];
  outcome?: MutationDispatchResult;
}): JournaledMutationStep {
  const timestamp = new Date().toISOString();
  return {
    id: `legacy:${input.operationId}:${input.planStepId}`,
    operationId: input.operationId,
    planStepId: input.planStepId,
    index: input.index,
    name: input.name,
    kind: "primary",
    status: input.status,
    ...(input.outcome?.externalId === undefined ? {} : { externalId: input.outcome.externalId }),
    ...(input.outcome?.effect === undefined ? {} : { effect: input.outcome.effect }),
    ...(input.outcome?.detail === undefined ? {} : { detail: input.outcome.detail }),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function plannedPrimary(
  operation: ConfirmableOperation,
  planStepId: string,
  index: number,
): ExternalMutationPlan["steps"][number] {
  const step = operation.mutationPlan?.steps[index];
  if (!step || step.id !== planStepId || step.kind !== "primary") {
    throw new Error("invalid_mutation_plan");
  }
  return step;
}

/** Execute one declared risky-write step; no-journal mode is explicit legacy/test compatibility. */
export async function executeDurableRiskyStep(input: {
  ctx: ActionContext;
  operation: ConfirmableOperation;
  planStepId: string;
  index: number;
  name: string;
  preparedDetail?: unknown;
  dispatch: () => Promise<MutationDispatchResult>;
}): Promise<JournaledMutationStep> {
  const planStep = plannedPrimary(input.operation, input.planStepId, input.index);
  if (input.ctx.mutationJournal) {
    return executeStep({
      journal: input.ctx.mutationJournal,
      operationId: input.operation.operationId,
      step: {
        id: input.planStepId,
        index: input.index,
        name: input.name,
        kind: "primary",
        ...(planStep.targetFingerprint ? { targetFingerprint: planStep.targetFingerprint } : {}),
        ...(input.preparedDetail === undefined ? {} : { preparedDetail: input.preparedDetail }),
      },
      dispatch: input.dispatch,
    });
  }

  try {
    const outcome = await input.dispatch();
    return syntheticStep({
      operationId: input.operation.operationId,
      planStepId: input.planStepId,
      index: input.index,
      name: input.name,
      status: "succeeded",
      outcome: input.preparedDetail === undefined
        ? outcome
        : { ...outcome, detail: input.preparedDetail },
    });
  } catch (error) {
    return syntheticStep({
      operationId: input.operation.operationId,
      planStepId: input.planStepId,
      index: input.index,
      name: input.name,
      status: error instanceof DefinitiveWriteFailure ? "definitive_failed" : "outcome_unknown",
      outcome: { detail: { type: error instanceof Error ? error.name : "UnknownError" } },
    });
  }
}

export async function commitSingleDurableRiskyStep(input: {
  ctx: ActionContext;
  operation: ConfirmableOperation;
  planStepId: string;
  name: string;
  dispatch: () => Promise<MutationDispatchResult>;
  success: (step: JournaledMutationStep) => SuccessReceipt;
}): Promise<CommitResult> {
  const step = await executeDurableRiskyStep({
    ...input,
    index: 0,
  });
  if (step.status === "succeeded") {
    const receipt = input.success(step);
    return isJournalDegradedStep(step) ? withJournalDegradedWarning(receipt) : receipt;
  }
  if (step.status === "outcome_unknown") {
    return errorReceipt({
      action: input.operation.actionName,
      code: "commit_outcome_unknown",
      message: "Clockify did not provide a definitive response, so the change may or may not have been applied.",
      recovery: { hint: "Verify the exact target in Clockify before deciding whether to try again.", retryable: false },
    });
  }
  return errorReceipt({
    action: input.operation.actionName,
    code: "write_failed",
    message: "Clockify definitively rejected this change.",
    recovery: { hint: "Correct the request and preview it again.", retryable: true },
  });
}
