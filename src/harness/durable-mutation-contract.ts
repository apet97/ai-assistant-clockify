import type { DurableMutationContract, ReconciliationStrategyId } from "./action.js";

export function durableMutationContract(input: {
  source: "safe" | "confirmed";
  targeting: DurableMutationContract["targeting"];
  strategies: [ReconciliationStrategyId, ...ReconciliationStrategyId[]];
  unreconciledStepIds?: readonly string[];
}): DurableMutationContract {
  return {
    operationData: {
      source: input.source === "safe" ? "prepared_safe_write" : "confirmable_operation",
      normalized: true,
      nonsecret: true,
    },
    mutationPlan: {
      source: input.source === "safe" ? "prepared_safe_write" : "preview",
      exact: true,
    },
    targeting: input.targeting,
    reconciliation: {
      strategies: input.strategies,
      ...(input.unreconciledStepIds ? { unreconciledStepIds: input.unreconciledStepIds } : {}),
      stepBound: true,
      requiresCompleteEvidence: true,
    },
  };
}
