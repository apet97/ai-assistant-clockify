import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type Store } from "../src/db/store.js";
import { isPartialCommitResult, type ActionContext, type CommitResult, type ConfirmableOperation } from "../src/harness/action.js";
import type { ExternalMutationPlan, MutationStepJournal } from "../src/harness/mutation-contract.js";
import { actionFingerprint, catalogHash } from "../src/harness/catalog.js";
import { hashOperation } from "../src/harness/confirmations.js";
import { executeStep } from "../src/harness/mutation-workflow.js";
import { bindMutationPlanHostCalls } from "../src/harness/safety-limits.js";
import { withMutationPlanScope } from "../src/clockify/rest/core.js";

function resultStatus(result: CommitResult): "succeeded" | "partial" | "definitive_failed" | "outcome_unknown" {
  if (isPartialCommitResult(result)) return "partial";
  if (result.ok) return "succeeded";
  return result.code === "commit_outcome_unknown" ? "outcome_unknown" : "definitive_failed";
}

function canonicalResult(result: CommitResult): unknown {
  if (isPartialCommitResult(result)) return result;
  return { kind: "receipt", receipt: result };
}

export interface LiveMutationJournal {
  operationJournal: NonNullable<ActionContext["operationJournal"]>;
  startConfirmed(operation: ConfirmableOperation & { mutationPlan: ExternalMutationPlan }): MutationStepJournal;
  settleConfirmed(operationId: string, result: CommitResult): void;
  runSingle(actionName: string, detail: unknown, dispatch: () => Promise<unknown>): Promise<void>;
  close(): void;
}

/**
 * Temporary local SQLite-backed workflow owner for opt-in live scripts. It uses
 * the same operation/step primitives and exact REST scope as the production
 * route, while keeping sacrificial credentials out of every persisted payload.
 */
export function createLiveMutationJournal(workspaceId: string, adminUserId: string): LiveMutationJournal {
  const directory = mkdtempSync(join(tmpdir(), "ai-assistant-live-journal-"));
  const store: Store = createStore(join(directory, "journal.sqlite"));
  const session = store.createSession({ workspaceId, adminUserId });
  let sequence = 0;

  const prepare = (
    actionName: string,
    operation: unknown,
    mutationPlan: ExternalMutationPlan,
    id?: string,
  ): string => {
    const normalizedOperation = JSON.parse(JSON.stringify(operation)) as unknown;
    return store.prepareOperationRun({
      ...(id ? { id } : {}),
      sessionId: session.id,
      workspaceId,
      adminUserId,
      actionName,
      actionFingerprint: actionFingerprint(actionName) ?? hashOperation({ actionName, liveScript: 1 }),
      catalogHash: catalogHash(),
      operationHash: hashOperation({ actionName, operation: normalizedOperation, mutationPlan }),
      operation: normalizedOperation,
      mutationPlan,
    });
  };

  return {
    operationJournal: {
      prepare(actionName, operation, mutationPlan) {
        if (!mutationPlan) throw new Error("live_mutation_plan_required");
        return prepare(actionName, operation, mutationPlan);
      },
      markExecuting(operationId) {
        if (!store.markOperationExecuting(operationId)) throw new Error("live_operation_not_prepared");
      },
      scope(operationId) {
        return store.mutationStepJournal(operationId);
      },
      settle(operationId, status, result) {
        store.settleOperationResult(operationId, status, result);
      },
    },

    startConfirmed(operation) {
      const operationId = prepare(
        operation.actionName,
        operation,
        operation.mutationPlan,
        operation.operationId,
      );
      if (!store.markOperationExecuting(operationId)) throw new Error("live_operation_not_prepared");
      return store.mutationStepJournal(operationId);
    },

    settleConfirmed(operationId, result) {
      store.settleOperationResult(operationId, resultStatus(result), canonicalResult(result));
    },

    async runSingle(actionName, detail, dispatch) {
      const stepId = `live-${sequence++}`;
      const plan = bindMutationPlanHostCalls(actionName, detail, {
        mode: "single",
        steps: [{ id: stepId, kind: "primary" }],
      });
      const operationId = prepare(actionName, detail, plan);
      if (!store.markOperationExecuting(operationId)) throw new Error("live_operation_not_prepared");
      const step = await withMutationPlanScope({
        actionName,
        plan,
        requiresComplete: (result) =>
          typeof result === "object" && result !== null && (result as { status?: unknown }).status === "succeeded",
      }, () => executeStep({
        journal: store.mutationStepJournal(operationId),
        operationId,
        step: { id: stepId, index: 0, name: actionName, kind: "primary", preparedDetail: detail },
        dispatch: async () => {
          await dispatch();
          return {};
        },
      }));
      const status = step.status === "succeeded"
        ? "succeeded"
        : step.status === "outcome_unknown"
          ? "outcome_unknown"
          : "definitive_failed";
      store.settleOperationResult(operationId, status, {
        kind: "receipt",
        receipt: {
          ok: status === "succeeded",
          action: actionName,
          ...(status === "succeeded"
            ? {}
            : { code: status === "outcome_unknown" ? "commit_outcome_unknown" : "write_failed" }),
        },
      });
      if (step.status !== "succeeded") throw new Error(`live_mutation_${step.status}`);
    },

    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
