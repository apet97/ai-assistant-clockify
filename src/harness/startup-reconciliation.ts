import type { ReconciliationResult } from "./reconciliation.js";
import type { Store } from "../db/store.js";

export interface StartupReconciliationCandidate {
  id: string;
  status: string;
  sessionId?: string;
  workspaceId?: string;
  adminUserId?: string;
  actionName: string;
  actionFingerprint: string;
  catalogHash: string;
  operationHash?: string;
  operation?: unknown;
  mutationPlan?: unknown;
  targetSnapshots?: ReadonlyArray<unknown>;
  steps: ReadonlyArray<{
    id: string;
    status: string;
    kind: "primary" | "compensation";
    planStepId: string;
    strategy?: "create" | "update" | "delete" | "state-command" | "composed";
    targetFingerprint?: string;
    evidence?: unknown;
  }>;
}

/**
 * Reconcile crash-orphaned dispatches after the store has already marked them
 * unknown. Prepared rows are never touched. The injected callback is read-only
 * by construction; background mutation/compensation capabilities are absent.
 */
export async function runStartupReconciliation(input: {
  listCandidates(): ReadonlyArray<StartupReconciliationCandidate>;
  currentActionFingerprint(actionName: string): string | undefined;
  currentCatalogHash(): string;
  reconcile(input: {
    operationId: string;
    stepId: string;
    planStepId: string;
    strategy: "create" | "update" | "delete" | "state-command" | "composed";
    actionName: string;
    actionFingerprint: string;
    catalogHash: string;
    candidate: StartupReconciliationCandidate;
    step: StartupReconciliationCandidate["steps"][number];
  }): Promise<ReconciliationResult>;
  persist(operationId: string, stepId: string, result: ReconciliationResult): Promise<void> | void;
}): Promise<{ considered: number; reconciled: number; authoritative: number; persistenceFailures: number }> {
  let considered = 0;
  let reconciled = 0;
  let authoritative = 0;
  let persistenceFailures = 0;
  for (const operation of input.listCandidates()) {
    if (operation.status !== "outcome_unknown") continue;
    for (const step of operation.steps) {
      if (step.status !== "outcome_unknown" || step.kind !== "primary" || !step.strategy) continue;
      considered += 1;
      const expectedBinding = {
        operationId: operation.id,
        stepId: step.id,
        planStepId: step.planStepId,
        strategy: step.strategy,
        actionName: operation.actionName,
        actionFingerprint: operation.actionFingerprint,
        catalogHash: operation.catalogHash,
      };
      const currentAction = input.currentActionFingerprint(operation.actionName);
      let result: ReconciliationResult;
      if (currentAction !== operation.actionFingerprint) {
        result = {
          authoritative: false,
          reason: "action_fingerprint_drift",
          binding: expectedBinding,
          evidence: { compatible: false },
        };
      } else if (input.currentCatalogHash() !== operation.catalogHash) {
        result = {
          authoritative: false,
          reason: "catalog_hash_drift",
          binding: expectedBinding,
          evidence: { compatible: false },
        };
      } else {
        try {
          result = await input.reconcile({ ...expectedBinding, candidate: operation, step });
          const returned = result.binding;
          if (
            returned.operationId !== expectedBinding.operationId || returned.stepId !== expectedBinding.stepId ||
            returned.planStepId !== expectedBinding.planStepId || returned.strategy !== expectedBinding.strategy ||
            returned.actionName !== expectedBinding.actionName ||
            returned.actionFingerprint !== expectedBinding.actionFingerprint || returned.catalogHash !== expectedBinding.catalogHash
          ) {
            result = {
              authoritative: false,
              reason: "binding_mismatch",
              binding: expectedBinding,
              evidence: { compatible: false },
            };
          }
        } catch {
          result = {
            authoritative: false,
            reason: "read_failed",
            binding: expectedBinding,
            evidence: { complete: false },
          };
        }
      }
      try {
        await input.persist(operation.id, step.id, result);
        reconciled += 1;
        if (result.authoritative) authoritative += 1;
      } catch {
        persistenceFailures += 1;
      }
    }
  }
  return { considered, reconciled, authoritative, persistenceFailures };
}

/** Real store-backed startup seam. Store construction has already atomically
 * marked dispatched orphans unknown before this read-only pass is callable. */
export function runStoreStartupReconciliation(input: {
  store: Pick<Store, "listStartupReconciliationCandidates" | "recordOperationReconciliation"> &
    Partial<Pick<Store, "settleStartupReconciliation">>;
  currentActionFingerprint(actionName: string): string | undefined;
  currentCatalogHash(): string;
  reconcile: Parameters<typeof runStartupReconciliation>[0]["reconcile"];
}): ReturnType<typeof runStartupReconciliation> {
  return runStartupReconciliation({
    listCandidates: () => input.store.listStartupReconciliationCandidates(),
    currentActionFingerprint: (actionName) => input.currentActionFingerprint(actionName),
    currentCatalogHash: () => input.currentCatalogHash(),
    reconcile: (binding) => input.reconcile(binding),
    persist(operationId, stepId, result) {
      if (result.authoritative) {
        if (!input.store.settleStartupReconciliation) throw new Error("startup_settlement_unavailable");
        input.store.settleStartupReconciliation(operationId, stepId, result);
      }
      else input.store.recordOperationReconciliation(operationId, stepId, result, false);
    },
  });
}
