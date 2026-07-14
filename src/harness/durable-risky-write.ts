import type {
  ActionContext,
  CommitResult,
  ConfirmableOperation,
  ExternalMutationPlan,
  TargetSnapshot,
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
import type { EntityRef } from "./receipts.js";
import { executeVerifiedMutationStep } from "./verified-mutation-step.js";
import { verifyTargetSnapshots } from "./target-snapshots.js";

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
  verification?: {
    snapshots: readonly TargetSnapshot[];
    fetchSnapshot(snapshot: TargetSnapshot): Promise<{ ref: EntityRef; projection?: unknown; truncated?: boolean } | undefined>;
  };
}): Promise<CommitResult> {
  let verificationFailure: "stale_target" | "stale_parent" | undefined;
  if (input.verification?.snapshots.length === 0) verificationFailure = "stale_target";
  if (input.verification && !input.ctx.mutationJournal && !verificationFailure) {
    const verified = await verifyTargetSnapshots(
      input.verification.snapshots,
      (snapshot) => input.verification!.fetchSnapshot(snapshot),
    );
    if (!verified.ok) verificationFailure = verified.code;
  }
  const planStep = plannedPrimary(input.operation, input.planStepId, 0);
  const step = verificationFailure
    ? undefined
    : input.verification && input.ctx.mutationJournal
    ? (await executeVerifiedMutationStep({
        journal: input.ctx.mutationJournal,
        operationId: input.operation.operationId,
        step: {
          id: input.planStepId,
          index: 0,
          name: input.name,
          kind: "primary",
          ...(planStep.targetFingerprint ? { targetFingerprint: planStep.targetFingerprint } : {}),
        },
        snapshots: input.verification.snapshots,
        fetchSnapshot: (snapshot) => input.verification!.fetchSnapshot(snapshot),
        dispatch: () => input.dispatch(),
      }).then((result) => {
        if (!result.verification.ok) verificationFailure = result.verification.code;
        return result.step;
      }))
    : await executeDurableRiskyStep({ ...input, index: 0 });
  if (verificationFailure) {
    return errorReceipt({
      action: input.operation.actionName,
      code: verificationFailure,
      message: verificationFailure === "stale_parent"
        ? "The target parent changed or could not be verified. No Clockify mutation was sent."
        : "The target changed or could not be verified. No Clockify mutation was sent.",
      recovery: { hint: "Refresh the target and create a fresh preview.", retryable: true },
    });
  }
  if (!step) throw new Error("verified_step_missing");
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
