import type { ActionDefinition } from "./action.js";

function isExternalWrite(action: ActionDefinition): boolean {
  return action.name.startsWith("clockify_") && action.risks.some((risk) => risk !== "read");
}

function hasDurableMutationPath(action: ActionDefinition): boolean {
  return action.mutationWorkflow === "durable";
}

function invalidContract(action: ActionDefinition): string | undefined {
  const contract = action.mutationContract as Partial<NonNullable<ActionDefinition["mutationContract"]>> | undefined;
  if (!contract?.operationData) return "operationData";
  if (
    contract.operationData.normalized !== true || contract.operationData.nonsecret !== true ||
    !["prepared_safe_write", "confirmable_operation"].includes(contract.operationData.source ?? "")
  ) return "operationData";
  if (!contract.mutationPlan) return "mutationPlan";
  if (
    contract.mutationPlan.exact !== true ||
    !["prepared_safe_write", "preview"].includes(contract.mutationPlan.source ?? "")
  ) return "mutationPlan";
  if (!contract.targeting) return "targeting";
  if (contract.targeting.mode === "snapshots") {
    if (!Array.isArray(contract.targeting.relations) || contract.targeting.relations.length === 0 ||
      contract.targeting.relations.some((relation) => relation !== "target" && relation !== "parent")) return "targeting";
  } else if (contract.targeting.mode !== "create_no_target") return "targeting";
  if (!contract.reconciliation) return "reconciliation";
  const reconciliationStrategies = new Set(["create", "update", "delete", "state-command", "composed"]);
  if (!Array.isArray(contract.reconciliation.strategies) || contract.reconciliation.strategies.length === 0 ||
    contract.reconciliation.strategies.some((strategy) => !reconciliationStrategies.has(strategy)) ||
    (contract.reconciliation.unreconciledStepIds !== undefined &&
      (!Array.isArray(contract.reconciliation.unreconciledStepIds) ||
        contract.reconciliation.unreconciledStepIds.some((id) => typeof id !== "string" || id.length === 0) ||
        new Set(contract.reconciliation.unreconciledStepIds).size !== contract.reconciliation.unreconciledStepIds.length)) ||
    contract.reconciliation.stepBound !== true || contract.reconciliation.requiresCompleteEvidence !== true) {
    return "reconciliation";
  }
  const safePath = !!action.prepareSafeWrite && !!action.executeSafeWrite;
  const confirmedPath = typeof action.commit === "function";
  if (safePath) {
    if (contract.operationData.source !== "prepared_safe_write" || contract.mutationPlan.source !== "prepared_safe_write") return "source";
  } else if (confirmedPath) {
    if (contract.operationData.source !== "confirmable_operation" || contract.mutationPlan.source !== "preview") return "source";
  } else {
    return "source";
  }
  return undefined;
}

export function mutationCatalogCoverage(
  actions: ReadonlyArray<ActionDefinition>,
): { uncovered: string[]; invalidContracts: string[] } {
  const invalidContracts = actions.flatMap((action) => {
    if (!isExternalWrite(action)) return [];
    const invalid = invalidContract(action);
    return invalid ? [`${action.name}:${invalid}`] : [];
  }).sort();
  return {
    uncovered: actions
      .filter((action) => isExternalWrite(action) && !hasDurableMutationPath(action))
      .map((action) => action.name)
      .sort(),
    invalidContracts,
  };
}
