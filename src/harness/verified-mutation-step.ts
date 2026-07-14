import { DefinitiveWriteFailure } from "../clockify/write-outcome.js";
import type { TargetSnapshot } from "./action.js";
import type { ExecutableMutationStep, MutationDispatchResult } from "./mutation-workflow.js";
import { executeStep } from "./mutation-workflow.js";
import type { MutationStepJournal } from "./mutation-contract.js";
import type { EntityRef } from "./receipts.js";
import { boundedSanitizedJson } from "./safe-json.js";
import { verifyTargetSnapshots, type SnapshotVerification } from "./target-snapshots.js";

/**
 * Execution-connected target gate. The journal enters executing before this
 * callback runs, but host I/O is invoked only after every exact ordered
 * target/parent snapshot has been re-fetched and matched.
 */
export async function executeVerifiedMutationStep(input: {
  journal: MutationStepJournal;
  operationId: string;
  step: Omit<ExecutableMutationStep, "dispatch">;
  snapshots: readonly TargetSnapshot[];
  fetchSnapshot(snapshot: TargetSnapshot): Promise<{
    ref: EntityRef;
    projection?: unknown;
    truncated?: boolean;
  } | undefined>;
  dispatch(): Promise<MutationDispatchResult>;
}): Promise<{ step: Awaited<ReturnType<typeof executeStep>>; verification: SnapshotVerification }> {
  const snapshots = input.snapshots.map((snapshot) => ({
    ...snapshot,
    ref: { ...snapshot.ref },
    projection: boundedSanitizedJson(snapshot.projection),
  }));
  let verification: SnapshotVerification = { ok: true };
  const step = await executeStep({
    journal: input.journal,
    operationId: input.operationId,
    step: {
      ...input.step,
      preparedDetail: {
        ...(input.step.preparedDetail && typeof input.step.preparedDetail === "object"
          ? input.step.preparedDetail as Record<string, unknown>
          : {}),
        targetSnapshots: snapshots,
      },
    },
    dispatch: async () => {
      verification = await verifyTargetSnapshots(snapshots, (snapshot) => input.fetchSnapshot(snapshot));
      if (!verification.ok) {
        throw new DefinitiveWriteFailure(
          "VERIFY",
          input.step.id,
          verification.code,
        );
      }
      return input.dispatch();
    },
  });
  return { step, verification };
}
