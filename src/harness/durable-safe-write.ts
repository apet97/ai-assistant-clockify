import type { z } from "zod";
import {
  defineAction,
  isPartialCommitResult,
  type ActionContext,
  type ActionDefinition,
  type ActionResult,
  type CommitResult,
  type PreparedSafeWrite,
} from "./action.js";
import type { FeatureGroup } from "./permissions.js";
import { executeStep, type MutationDispatchResult } from "./mutation-workflow.js";
import { errorReceipt } from "./receipts.js";

export interface DurableSafeWriteDispatch extends MutationDispatchResult {
  result: CommitResult;
}

/**
 * Safe-write builder whose production execution is a real durable host step.
 * The raw dispatch callback is reachable only inside executeStep when the route
 * supplies its scoped journal. Isolated harness tests may omit persistence and
 * use the compatibility branch, but catalog durability is granted only by this
 * builder's journal-enforcing production path.
 */
export function defineDurableSafeWriteAction<S extends z.ZodTypeAny>(def: {
  name: string;
  description: string;
  group: FeatureGroup;
  schema: S;
  stepName: string;
  argumentAliases?: readonly string[];
  argumentOpenPaths?: readonly string[];
  prepare(ctx: ActionContext, args: z.infer<S>): Promise<PreparedSafeWrite> | PreparedSafeWrite;
  dispatch(ctx: ActionContext, operation: unknown): Promise<DurableSafeWriteDispatch>;
}): ActionDefinition {
  const executePrepared = async (
    ctx: ActionContext,
    prepared: PreparedSafeWrite,
  ): Promise<CommitResult> => {
    const primary = prepared.mutationPlan.steps.filter((step) => step.kind === "primary");
    if (primary.length !== 1 || prepared.mutationPlan.mode !== "single") {
      return errorReceipt({
        action: def.name,
        code: "invalid_mutation_plan",
        message: "This safe write does not have exactly one durable host step.",
      });
    }

    // Direct harness callers have no persistence owner. Production chat routes
    // always inject the scoped journal after their single lifecycle transition.
    if (!ctx.mutationJournal) return (await def.dispatch(ctx, prepared.operation)).result;

    let dispatched: DurableSafeWriteDispatch | undefined;
    const step = await executeStep({
      journal: ctx.mutationJournal,
      operationId: ctx.mutationJournal.operationId,
      step: {
        id: primary[0]!.id,
        index: 0,
        name: def.stepName,
        kind: "primary",
        ...(primary[0]!.targetFingerprint
          ? { targetFingerprint: primary[0]!.targetFingerprint }
          : {}),
      },
      dispatch: async () => {
        dispatched = await def.dispatch(ctx, prepared.operation);
        const { result: _result, ...effect } = dispatched;
        return effect;
      },
    });
    if (step.status === "succeeded" && dispatched) return dispatched.result;
    if (step.status === "outcome_unknown") {
      return errorReceipt({
        action: def.name,
        code: "commit_outcome_unknown",
        message: "Clockify did not provide a definitive response, so this change may or may not have been applied.",
        recovery: {
          hint: "Verify the result in Clockify before deciding whether to try again.",
          retryable: false,
        },
      });
    }
    return errorReceipt({
      action: def.name,
      code: "write_failed",
      message: "Clockify definitively rejected this change.",
      recovery: { hint: "Correct the request and try again.", retryable: true },
    });
  };

  return defineAction({
    name: def.name,
    description: def.description,
    featureGroup: def.group,
    risks: ["safe_write"],
    schema: def.schema,
    ...(def.argumentAliases ? { argumentAliases: def.argumentAliases } : {}),
    ...(def.argumentOpenPaths ? { argumentOpenPaths: def.argumentOpenPaths } : {}),
    mutationWorkflow: "durable",
    prepareSafeWrite: async (ctx, args) => def.prepare(ctx, args),
    executeSafeWrite: (ctx, prepared) => executePrepared(ctx, prepared),
    async handler(ctx, args): Promise<ActionResult> {
      const result = await executePrepared(ctx, await def.prepare(ctx, args));
      return isPartialCommitResult(result)
        ? result
        : { kind: "receipt", receipt: result };
    },
  });
}
