import type { z } from "zod";
import { AmbiguousWriteOutcome, DefinitiveWriteFailure } from "../../clockify/write-outcome.js";
import type { ListResult } from "../../clockify/types.js";
import {
  defineAction,
  isPartialCommitResult,
  isPreparedSafeWrite,
  isSafeWriteClarification,
  mutationPlanContractError,
  type ActionContext,
  type BoundedPreparedSafeWrite,
  type CommitResult,
  type DurableMutationContract,
  type ExternalMutationPlanDraft,
  type SafeWriteActionDefinition,
  type SafeWritePreparationResult,
  type SemanticLiteralAlias,
  type TargetSnapshot,
} from "../action.js";
import { executeStep, isJournalDegradedStep, withJournalDegradedWarning, type MutationDispatchResult } from "../mutation-workflow.js";
import type { FeatureGroup } from "../permissions.js";
import { errorReceipt, type EntityRef } from "../receipts.js";
import { sanitizedFingerprint } from "../safe-json.js";
import { captureTargetSnapshot, verifyTargetSnapshots } from "../target-snapshots.js";
import {
  apiActionMetadataFields,
  type ApiActionMetadataCarrier,
} from "../api-operation.js";

interface StructureSafeWriteDispatch extends MutationDispatchResult {
  result: CommitResult;
}

/** Structure-domain safe-write builder whose complete create baseline is read
 * immediately before the step is prepared, then committed with that exact step
 * before any host dispatch. */
export function defineStructureDurableSafeWriteAction<S extends z.ZodTypeAny, State>(def: ApiActionMetadataCarrier & {
  name: string;
  description: string;
  group: FeatureGroup;
  schema: S;
  stepName: string;
  mutationContract: DurableMutationContract;
  argumentAliases?: readonly string[];
  semanticLiteralAliases?: readonly SemanticLiteralAlias[];
  argumentOpenPaths?: readonly string[];
  prepare(ctx: ActionContext, args: z.infer<S>): Promise<SafeWritePreparationResult> | SafeWritePreparationResult;
  prepareDispatch(ctx: ActionContext, operation: unknown): Promise<{ preparedDetail: unknown; state: State }>;
  dispatch(ctx: ActionContext, operation: unknown, state: State): Promise<StructureSafeWriteDispatch>;
}): SafeWriteActionDefinition {
  const executePrepared = async (ctx: ActionContext, prepared: BoundedPreparedSafeWrite): Promise<CommitResult> => {
    const contractError = mutationPlanContractError(def.mutationContract, prepared.mutationPlan);
    const primary = prepared.mutationPlan.steps.filter((step) => step.kind === "primary");
    if (contractError || primary.length !== 1 || prepared.mutationPlan.mode !== "single") {
      return errorReceipt({ action: def.name, code: "invalid_mutation_plan", message: "The durable host plan is incompatible with this action." });
    }
    let before: { preparedDetail: unknown; state: State };
    try {
      before = await def.prepareDispatch(ctx, prepared.operation);
    } catch {
      return errorReceipt({
        action: def.name,
        code: "create_baseline_unavailable",
        message: "A complete create baseline could not be persisted immediately before dispatch. No mutation was sent.",
        recovery: { hint: "Retry after Clockify list reads recover.", retryable: true },
      });
    }
    if (!ctx.mutationJournal) return (await def.dispatch(ctx, prepared.operation, before.state)).result;
    let dispatched: StructureSafeWriteDispatch | undefined;
    const step = await executeStep({
      journal: ctx.mutationJournal,
      operationId: ctx.mutationJournal.operationId,
      step: {
        id: primary[0]!.id,
        index: 0,
        name: def.stepName,
        kind: "primary",
        ...(primary[0]!.targetFingerprint ? { targetFingerprint: primary[0]!.targetFingerprint } : {}),
        preparedDetail: before.preparedDetail,
      },
      dispatch: async () => {
        dispatched = await def.dispatch(ctx, prepared.operation, before.state);
        const { result: _result, ...outcome } = dispatched;
        return outcome;
      },
    });
    if (step.status === "succeeded" && dispatched) {
      return isJournalDegradedStep(step) && !isPartialCommitResult(dispatched.result) && dispatched.result.ok
        ? withJournalDegradedWarning(dispatched.result)
        : dispatched.result;
    }
    if (step.status === "outcome_unknown") {
      return errorReceipt({
        action: def.name,
        code: "commit_outcome_unknown",
        message: "Clockify did not provide a definitive response, so this change may or may not have applied.",
        recovery: { hint: "Verify the result in Clockify before deciding whether to retry.", retryable: false },
      });
    }
    return errorReceipt({ action: def.name, code: "write_failed", message: "Clockify definitively rejected this change." });
  };

  return defineAction({
    name: def.name,
    description: def.description,
    featureGroup: def.group,
    risks: ["safe_write"],
    schema: def.schema,
    ...apiActionMetadataFields(def),
    mutationWorkflow: "durable",
    mutationContract: def.mutationContract,
    ...(def.argumentAliases ? { argumentAliases: def.argumentAliases } : {}),
    ...(def.semanticLiteralAliases ? { semanticLiteralAliases: def.semanticLiteralAliases } : {}),
    ...(def.argumentOpenPaths ? { argumentOpenPaths: def.argumentOpenPaths } : {}),
    prepareSafeWrite: async (ctx, args) => {
      const prepared = await def.prepare(ctx, args);
      if (isSafeWriteClarification(prepared)) return prepared;
      if (!isPreparedSafeWrite(prepared)) throw new Error("invalid_safe_write_preparation");
      if (mutationPlanContractError(def.mutationContract, prepared.mutationPlan)) throw new Error("invalid_mutation_plan_contract");
      return prepared;
    },
    executeSafeWrite: executePrepared,
  }) as SafeWriteActionDefinition;
}

export function mutationPlan(
  steps: Array<{ id: string; kind?: "primary" | "compensation"; strategy: "create" | "update" | "delete" | "state-command" | "composed"; fingerprint?: string }>,
): ExternalMutationPlanDraft {
  return {
    mode: steps.length === 1 ? "single" : "curated",
    steps: steps.map((step) => ({
      id: step.id,
      kind: step.kind ?? "primary",
      reconciliationStrategy: step.strategy,
      ...(step.fingerprint ? { targetFingerprint: step.fingerprint } : {}),
    })),
  };
}

export function snapshot(
  relation: "target" | "parent",
  type: string,
  row: { id: string; name?: string },
  projection: unknown = row,
  extraRef?: Record<string, string>,
): TargetSnapshot {
  return captureTargetSnapshot(
    relation,
    { type, id: row.id, ...(row.name ? { name: row.name } : {}), ...(extraRef ?? {}) },
    projection,
  );
}

async function loadStructureProjection(
  ctx: ActionContext,
  type: string,
  id: string,
  projectId?: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    if (type === "project" || type === "project_template") {
      return (await ctx.clockify.getProjectMutationState(id)) ?? undefined;
    }
    if (type === "client") return (await ctx.clockify.getClientMutationState(id)) ?? undefined;
    if (type === "task") {
      if (!projectId) return undefined;
      return await ctx.clockify.prepareTaskUpdate(projectId, id, {});
    }
    if (type === "tag") return await ctx.clockify.prepareTagUpdate(id, {});
    if (type === "time_entry") return await ctx.clockify.prepareTimeEntryUpdate({ id });
  } catch {
    return undefined;
  }
  return undefined;
}

/** Capture the complete raw target document used by replacement writes. */
export async function captureStructureSnapshot(
  ctx: ActionContext,
  relation: "target" | "parent",
  type: string,
  row: { id: string; name?: string },
  extraRef?: Record<string, string>,
): Promise<TargetSnapshot> {
  const projection = await loadStructureProjection(ctx, type, row.id, extraRef?.projectId);
  if (!projection) throw new DefinitiveWriteFailure("GET", type, `Unable to capture authoritative ${type} state.`);
  return snapshot(relation, type, row, projection, extraRef);
}

export async function fetchStructureSnapshot(
  ctx: ActionContext,
  stored: TargetSnapshot,
): Promise<{ ref: EntityRef; projection?: unknown; truncated?: boolean } | undefined> {
  const projectId = typeof stored.ref.projectId === "string" ? stored.ref.projectId : undefined;
  const row = await loadStructureProjection(ctx, stored.ref.type, stored.ref.id, projectId);
  if (!row || typeof row !== "object") return undefined;
  const candidate = row as { id?: unknown; name?: unknown };
  if (typeof candidate.id !== "string") return undefined;
  return {
    ref: {
      ...stored.ref,
      id: candidate.id,
      ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
    },
    projection: row,
    truncated: false,
  };
}

export async function requireFreshSnapshots(
  ctx: ActionContext,
  snapshots: readonly TargetSnapshot[],
): Promise<void> {
  const verified = await verifyTargetSnapshots(snapshots, (stored) => fetchStructureSnapshot(ctx, stored));
  if (!verified.ok) throw new DefinitiveWriteFailure("VERIFY", verified.code, verified.message);
}

export async function reconcileCreate<T extends { id: string }>(input: {
  beforeIds: readonly string[];
  list(): Promise<ListResult<T>>;
  matches(row: T): boolean;
}): Promise<T | undefined> {
  const after = await input.list();
  if (after.truncated) return undefined;
  const before = new Set(input.beforeIds);
  const matches = after.rows.filter((row) => !before.has(row.id) && input.matches(row));
  return matches.length === 1 ? matches[0] : undefined;
}

export async function dispatchWithReconciliation<T>(input: {
  dispatch(): Promise<T>;
  reconcile(): Promise<T | undefined>;
}): Promise<{ value: T; reconciled: boolean }> {
  try {
    return { value: await input.dispatch(), reconciled: false };
  } catch (error) {
    if (!(error instanceof AmbiguousWriteOutcome)) throw error;
    let value: T | undefined;
    try {
      value = await input.reconcile();
    } catch {
      value = undefined;
    }
    if (value === undefined) throw error;
    return { value, reconciled: true };
  }
}

export async function reconcileExactUpdate<T>(
  read: () => Promise<T | null | undefined>,
  expectedProjection: unknown,
  project: (row: T) => unknown,
): Promise<T | undefined> {
  const row = await read();
  return row && sanitizedFingerprint(project(row)) === sanitizedFingerprint(expectedProjection) ? row : undefined;
}

export async function reconcileDelete(read: () => Promise<unknown | null | undefined>): Promise<true | undefined> {
  return (await read()) == null ? true : undefined;
}
