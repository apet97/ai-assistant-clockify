import type { ActionContext } from "./action.js";
import type { EntityRef, SuccessReceipt, ErrorReceipt, Warning } from "./receipts.js";
import { successReceipt, errorReceipt } from "./receipts.js";
import { canWrite, type AdminPolicy, type FeatureGroup } from "./permissions.js";
import type { ExternalMutationPlan, ExternalMutationPlanDraft, JournaledMutationStep } from "./mutation-contract.js";
import { executeStep, isJournalDegradedStep } from "./mutation-workflow.js";
import { withMutationPlanScope } from "../clockify/rest/core.js";
import { bindMutationPlanHostCalls } from "./safety-limits.js";

/**
 * Undo of the last reversible action (Phase 5b). The only thing we reverse is a
 * CREATION — we delete the entities a successful action created (read straight from
 * `receipt.changed.created`), in REVERSE order so dependents go before their parents
 * (task → project → client). Deletes and field-updates are out of scope (a delete
 * can't be un-deleted; restoring a field needs before-state we don't capture yet).
 *
 * Higher-stakes creations (users, groups) are deliberately NOT reversible here. The
 * undo re-checks write policy for every affected group and denies the whole undo if
 * any is disabled — it never half-reverses on a policy boundary.
 */
const REVERSIBLE_ENTITY_GROUP: Record<string, FeatureGroup> = {
  project: "work_structure",
  client: "work_structure",
  task: "work_structure",
  tag: "work_structure",
  time_entry: "time_tracking",
  invoice: "invoices",
  expense: "expenses",
  webhook: "webhooks",
  group: "users_groups",
  holiday: "time_off_approvals",
  assignment: "scheduling",
  // time_off_request is deliberately ABSENT: its delete needs the POLICY id,
  // which the created-entity ref doesn't carry.
};

/** The created entities from a success receipt that can be reversed by deleting them. */
export function reversibleCreations(receipt: SuccessReceipt): EntityRef[] {
  return (receipt.changed?.created ?? []).filter((e) => e.type in REVERSIBLE_ENTITY_GROUP);
}

/** The first feature group an undo of these refs needs but the policy denies, else undefined. */
export function firstDeniedGroup(policy: AdminPolicy, refs: EntityRef[]): FeatureGroup | undefined {
  const groups = [...new Set(refs.map((r) => REVERSIBLE_ENTITY_GROUP[r.type]).filter(Boolean))] as FeatureGroup[];
  return groups.find((g) => !canWrite(policy, g));
}

interface UndoPlanStep {
  id: string;
  index: number;
  ref: EntityRef;
  operation: "transition" | "delete";
}

function undoPlanSteps(refs: EntityRef[]): UndoPlanStep[] {
  const steps: UndoPlanStep[] = [];
  const reversed = [...refs].reverse();
  for (const [refIndex, ref] of reversed.entries()) {
    if (ref.type === "project" || ref.type === "client" || ref.type === "task") {
      steps.push({
        id: `undo-${refIndex}-${ref.type}-transition`,
        index: steps.length,
        ref,
        operation: "transition",
      });
    }
    steps.push({
      id: `undo-${refIndex}-${ref.type}-delete`,
      index: steps.length,
      ref,
      operation: "delete",
    });
  }
  return steps;
}

/** Exact ordered host plan for one durable undo operation. */
export function undoMutationPlan(refs: EntityRef[]): ExternalMutationPlan {
  const plan: ExternalMutationPlanDraft = {
    mode: "batch",
    steps: undoPlanSteps(refs).map((step) => ({
      id: step.id,
      kind: "primary" as const,
      reconciliationStrategy: step.operation === "delete" ? "delete" as const : "state-command" as const,
    })),
  };
  return bindMutationPlanHostCalls("undo", { refs }, plan);
}

async function prepareTransition(ctx: ActionContext, ref: EntityRef): Promise<Record<string, unknown>> {
  if (ref.type === "project") return ctx.clockify.prepareProjectUpdate(ref.id, { archived: true });
  if (ref.type === "client") return ctx.clockify.prepareClientUpdate(ref.id, { archived: true });
  if (ref.type === "task") {
    if (!ref.projectId) throw new Error("task_project_id_missing");
    return ctx.clockify.prepareTaskUpdate(ref.projectId, ref.id, { status: "DONE" });
  }
  throw new Error("undo_transition_not_supported");
}

async function dispatchTransition(ctx: ActionContext, ref: EntityRef, body: Record<string, unknown>): Promise<void> {
  if (ref.type === "project") {
    await ctx.clockify.archiveProjectAtomic(ref.id, body);
    return;
  }
  if (ref.type === "client") {
    await ctx.clockify.updateClientAtomic(ref.id, body);
    return;
  }
  if (ref.type === "task" && ref.projectId) {
    await ctx.clockify.updateTaskAtomic(ref.projectId, ref.id, body);
    return;
  }
  throw new Error("undo_transition_not_supported");
}

async function dispatchDelete(ctx: ActionContext, ref: EntityRef): Promise<void> {
  if (ref.type === "project") return ctx.clockify.deleteProjectAtomic(ref.id);
  if (ref.type === "client") return ctx.clockify.deleteClientAtomic(ref.id);
  if (ref.type === "task") {
    if (!ref.projectId) throw new Error("task_project_id_missing");
    return ctx.clockify.deleteTaskAtomic(ref.projectId, ref.id);
  }
  if (ref.type === "tag") return ctx.clockify.deleteTagAtomic(ref.id);
  if (ref.type === "time_entry") return ctx.clockify.deleteTimeEntryAtomic(ref.id);
  if (ref.type === "invoice") return ctx.clockify.deleteInvoiceAtomic(ref.id);
  if (ref.type === "expense") return ctx.clockify.deleteExpenseAtomic(ref.id);
  if (ref.type === "webhook") return ctx.clockify.deleteWebhookAtomic(ref.id);
  if (ref.type === "group") return ctx.clockify.deleteGroupAtomic(ref.id);
  if (ref.type === "holiday") return ctx.clockify.deleteHolidayAtomic(ref.id);
  if (ref.type === "assignment") return ctx.clockify.deleteAssignmentAtomic(ref.id);
  throw new Error(`undo_delete_not_supported:${ref.type}`);
}

export interface DurableUndoResult {
  receipt: SuccessReceipt | ErrorReceipt;
  status: "partially_undone" | "undone" | "failed" | "outcome_unknown";
  remaining: EntityRef[];
}

function remainingAfter(refs: EntityRef[], deleted: EntityRef[]): EntityRef[] {
  const deletedKeys = new Set(deleted.map((ref) => `${ref.type}:${ref.id}`));
  return refs.filter((ref) => !deletedKeys.has(`${ref.type}:${ref.id}`));
}

function failedUndoReceipt(refs: EntityRef[], detail: string): ErrorReceipt {
  return errorReceipt({
    action: "undo",
    code: "undo_failed",
    message: refs.length === 1
      ? `Couldn't undo — the change could not be reversed. ${detail}`.trim()
      : `Couldn't undo — none of the ${refs.length} created items could be removed. ${detail}`.trim(),
    recovery: { hint: "Nothing was removed; remove them manually if needed.", retryable: false },
  });
}

/**
 * The ONE undo path: every host effect is one exact durable primary step.
 * (C4 deleted the non-durable `reverseCreation` twin; nothing bypasses the
 * operation journal any more.)
 */
export async function reverseCreationDurably(
  ctx: ActionContext,
  refs: EntityRef[],
  operationId: string,
  plan: ExternalMutationPlan,
): Promise<DurableUndoResult> {
  if (refs.length === 0) {
    return {
      receipt: errorReceipt({ action: "undo", code: "not_undoable", message: "There is nothing to undo." }),
      status: "failed",
      remaining: [],
    };
  }
  const denied = firstDeniedGroup(ctx.policy, refs);
  if (denied) {
    return {
      receipt: errorReceipt({
        action: "undo",
        code: "policy_denied",
        message: `Undo needs write access to ${denied}, which is disabled in your assistant permissions.`,
        recovery: { hint: `Enable write access for ${denied} and try again.`, retryable: true },
      }),
      status: "failed",
      remaining: refs,
    };
  }
  if (!ctx.mutationJournal || ctx.mutationJournal.operationId !== operationId) {
    throw new Error("undo_operation_journal_required");
  }
  const specs = undoPlanSteps(refs);
  if (plan.steps.length !== specs.length || plan.steps.some((step, index) =>
    step.id !== specs[index]?.id || step.kind !== "primary")) {
    throw new Error("invalid_undo_mutation_plan");
  }
  const deleted: EntityRef[] = [];
  const transitioned = new Set<string>();
  const warnings: Warning[] = [];
  let terminal: JournaledMutationStep | undefined;
  let preparationFailure: string | undefined;

  await withMutationPlanScope({
    actionName: "undo",
    plan,
    authorizeDispatch: async () => ctx.authorizeWrite?.("undo"),
    onDispatch: (step) => markUndoStepDispatched(ctx, step.id, step.kind),
    requiresComplete: () =>
      terminal?.status === "succeeded"
      && !isJournalDegradedStep(terminal)
      && ctx.mutationJournal!.listOperationSteps().length === specs.length,
  }, async () => {
    for (const spec of specs) {
      let preparedBody: Record<string, unknown> | undefined;
      if (spec.operation === "transition") {
        try {
          preparedBody = await prepareTransition(ctx, spec.ref);
        } catch {
          preparationFailure = `Couldn't prepare ${spec.ref.type} ${spec.ref.name ?? spec.ref.id} for removal.`;
          break;
        }
      }
      const step = await executeStep({
        journal: ctx.mutationJournal!,
        operationId,
        step: {
          id: spec.id,
          index: spec.index,
          name: spec.operation === "delete" ? `Delete ${spec.ref.type}` : `Prepare ${spec.ref.type} for deletion`,
          kind: "primary",
          preparedDetail: {
            ref: {
              type: spec.ref.type,
              id: spec.ref.id,
              ...(spec.ref.projectId ? { projectId: spec.ref.projectId } : {}),
            },
            ...(preparedBody ? { body: preparedBody } : {}),
          },
        },
        dispatch: async () => {
          if (spec.operation === "transition") {
            await dispatchTransition(ctx, spec.ref, preparedBody!);
            return { externalId: spec.ref.id, effect: { updated: spec.ref } };
          }
          await dispatchDelete(ctx, spec.ref);
          return { externalId: spec.ref.id, effect: { deleted: spec.ref } };
        },
      });
      terminal = step;
      if (step.status !== "succeeded") break;
      if (spec.operation === "transition") transitioned.add(`${spec.ref.type}:${spec.ref.id}`);
      else deleted.push(spec.ref);
      if (isJournalDegradedStep(step)) break;
    }
  });

  const remaining = remainingAfter(refs, deleted);
  const knownEffects = deleted.length + transitioned.size;
  if (terminal?.status === "outcome_unknown") {
    const warning: Warning = {
      code: "undo_outcome_unknown",
      message: "A Clockify undo step had an unknown outcome. No later removal was dispatched.",
    };
    if (knownEffects > 0) {
      return {
        receipt: successReceipt({
          action: "undo",
          entity: "undo",
          ids: { workspaceId: ctx.workspaceId },
          changed: { deleted, updated: refs.filter((ref) => transitioned.has(`${ref.type}:${ref.id}`)) },
          warnings: [warning],
        }),
        status: "outcome_unknown",
        remaining,
      };
    }
    return {
      receipt: errorReceipt({
        action: "undo",
        code: "commit_outcome_unknown",
        message: warning.message,
        recovery: { hint: "Verify the affected item in Clockify before taking further action.", retryable: false },
      }),
      status: "outcome_unknown",
      remaining,
    };
  }
  if (preparationFailure || (terminal && terminal.status !== "succeeded")) {
    const message = preparationFailure ?? "Clockify definitively rejected an undo step. No later removal was dispatched.";
    warnings.push({ code: "undo_failed", message });
    if (knownEffects === 0) {
      return { receipt: failedUndoReceipt(refs, message), status: "failed", remaining };
    }
    return {
      receipt: successReceipt({
        action: "undo",
        entity: "undo",
        ids: { workspaceId: ctx.workspaceId },
        changed: { deleted, updated: refs.filter((ref) => transitioned.has(`${ref.type}:${ref.id}`)) },
        warnings,
      }),
      status: "partially_undone",
      remaining,
    };
  }
  if (terminal && isJournalDegradedStep(terminal)) {
    warnings.push({
      code: "operation_journal_degraded",
      message: "Clockify confirmed the undo step, but its full local journal settlement degraded. No later removal was dispatched.",
    });
    return {
      receipt: successReceipt({
        action: "undo",
        entity: "undo",
        ids: { workspaceId: ctx.workspaceId },
        changed: { deleted },
        warnings,
      }),
      status: remaining.length > 0 ? "partially_undone" : "undone",
      remaining,
    };
  }
  return {
    receipt: successReceipt({
      action: "undo",
      entity: "undo",
      ids: { workspaceId: ctx.workspaceId },
      changed: { deleted },
    }),
    status: "undone",
    remaining: [],
  };
}

function markUndoStepDispatched(
  ctx: ActionContext,
  planStepId: string,
  kind: "primary" | "compensation",
): void {
  const journal = ctx.mutationJournal;
  if (!journal) throw new Error("undo_operation_journal_required");
  const row = journal.listOperationSteps().find((candidate) =>
    candidate.planStepId === planStepId && candidate.kind === kind);
  if (!row || !journal.markOperationStepDispatched(row.id)) {
    throw new Error(`dispatch_journal_unavailable:${planStepId}`);
  }
}
