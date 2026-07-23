import { z } from "zod";
import type {
  ActionContext,
  CommitResult,
  ConfirmableOperation,
  RiskyClarifyResult,
  RiskyPreviewResult,
  SemanticLiteralAlias,
  TargetSnapshot,
} from "../action.js";
import { successReceipt } from "../receipts.js";
import { commitSingleDurableRiskyStep } from "../durable-risky-write.js";
import { dispatchWithReconciliation } from "./structure-durable.js";
import { captureTargetSnapshot } from "../target-snapshots.js";
import { resolveEntityRef } from "./resolve.js";
import type { ExpenseCategorySummary } from "../../clockify/ports/expenses.js";

export const EXPENSE_CATEGORY_ARCHIVED_LITERAL_ALIASES = Object.freeze([
  { path: "archived", value: false, authoredPhrases: Object.freeze(["active", "restore", "unarchive", "unarchived"]) },
  { path: "archived", value: true, authoredPhrases: Object.freeze(["archive", "archived"]) },
] satisfies readonly SemanticLiteralAlias[]);

export const expenseCategoryTargetRefSchema = z
  .object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
  .refine((v) => v.id !== undefined || v.name !== undefined, {
    message: "Provide the category id or its exact name.",
  });

export const expenseCategoryRenameSchema = z
  .object({
    id: z.string().min(1).optional(),
    currentName: z.string().min(1).optional(),
    name: z.string().min(1),
  })
  .refine((v) => v.id !== undefined || v.currentName !== undefined, {
    message: "Provide the category id or its exact currentName.",
  });

export const expenseCategoryStatusUpdateSchema = z
  .object({
    id: z.string().min(1).optional(),
    currentName: z.string().min(1).optional(),
    archived: z.boolean(),
  })
  .refine((v) => v.id !== undefined || v.currentName !== undefined, {
    message: "Provide the category id or its exact currentName.",
  });

export async function listAllExpenseCategories(ctx: ActionContext): Promise<ExpenseCategorySummary[] | undefined> {
  const [active, archived] = await Promise.all([
    ctx.clockify.listExpenseCategories({ archived: false }),
    ctx.clockify.listExpenseCategories({ archived: true }),
  ]);
  if (active.truncated || archived.truncated) return undefined;
  return [...new Map([...active.rows, ...archived.rows].map((row) => [row.id, row])).values()];
}

export async function expenseCategoryById(ctx: ActionContext, id: string) {
  const complete = await listAllExpenseCategories(ctx);
  if (!complete) return undefined;
  const matches = complete.filter((row) => row.id === id);
  return matches.length === 1 ? matches[0] : undefined;
}

export async function expenseCategoryTarget(ctx: ActionContext, id: string): Promise<TargetSnapshot | undefined> {
  const category = await expenseCategoryById(ctx, id);
  return category
    ? captureTargetSnapshot("target", { type: "expense_category", id: category.id, name: category.name }, category)
    : undefined;
}

function staleCategoryFetch(ctx: ActionContext, snapshot: TargetSnapshot) {
  return expenseCategoryById(ctx, snapshot.ref.id).then((row) => row
    ? { ref: { type: "expense_category", id: row.id, name: row.name }, projection: row, truncated: false }
    : undefined);
}

async function resolveExpenseCategoryRef(
  ctx: ActionContext,
  args: { id?: string; currentName?: string; name?: string },
  verb: string,
  includeArchived?: boolean,
) {
  return resolveEntityRef(
    { id: args.id, name: args.currentName ?? args.name },
    {
      noun: "expense category",
      verb,
      list: (filter) => ctx.clockify.listExpenseCategories(filter),
      includeArchived,
      verifyId: true,
    },
  );
}

export async function previewExpenseCategoryRename(
  ctx: ActionContext,
  args: z.infer<typeof expenseCategoryRenameSchema>,
): Promise<RiskyPreviewResult | RiskyClarifyResult> {
  const resolved = await resolveExpenseCategoryRef(ctx, args, "rename");
  if (!resolved.ok) return resolved.clarify;
  const target = await expenseCategoryTarget(ctx, resolved.id);
  if (!target) return { clarify: `Expense category ${resolved.id} could not be verified completely.` };
  return {
    actionLabel: "Rename expense category",
    targets: [{ type: "expense_category", id: resolved.id, name: args.name }],
    expectedChanges: [`Rename expense category to "${args.name}"`],
    reversibility: "You can rename the category again.",
    warnings: ["This changes a workspace expense category."],
    payload: { id: resolved.id, name: args.name },
    targetSnapshots: [target],
    mutationPlan: {
      mode: "single",
      steps: [{ id: "rename-expense-category", kind: "primary", targetFingerprint: target.fingerprint, reconciliationStrategy: "update" }],
    },
  };
}

export async function commitExpenseCategoryRename(
  ctx: ActionContext,
  payload: Record<string, unknown>,
  operation: ConfirmableOperation,
  actionName: string,
): Promise<CommitResult> {
  const { id, name } = payload as { id: string; name: string };
  return commitSingleDurableRiskyStep({
    ctx, operation, planStepId: "rename-expense-category", name: "Rename expense category",
    verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (snapshot) => staleCategoryFetch(ctx, snapshot) },
    dispatch: async () => {
      const result = await dispatchWithReconciliation({
        dispatch: () => ctx.clockify.updateExpenseCategoryAtomic(id, { name }),
        reconcile: async () => { const row = await expenseCategoryById(ctx, id); return row?.name === name ? row : undefined; },
      });
      return { externalId: result.value.id, effect: { renamed: { id, name } }, detail: { reconciled: result.reconciled } };
    },
    success: () => successReceipt({
      action: actionName,
      entity: "expense_category",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "expense_category", id, name }] },
    }),
  });
}

export async function previewExpenseCategoryStatusUpdate(
  ctx: ActionContext,
  args: z.infer<typeof expenseCategoryStatusUpdateSchema>,
): Promise<RiskyPreviewResult | RiskyClarifyResult> {
  const resolved = await resolveExpenseCategoryRef(ctx, args, "update", args.archived === false);
  if (!resolved.ok) return resolved.clarify;
  const target = await expenseCategoryTarget(ctx, resolved.id);
  if (!target) return { clarify: `Expense category ${resolved.id} could not be verified completely.` };
  return {
    actionLabel: "Set expense category status",
    targets: [{ type: "expense_category", id: resolved.id, name: resolved.name }],
    expectedChanges: [`${args.archived ? "Archive" : "Unarchive"} expense category ${resolved.name ?? resolved.id}`],
    reversibility: "You can change the category status again.",
    warnings: ["This changes a workspace expense category."],
    payload: { id: resolved.id, archived: args.archived },
    targetSnapshots: [target],
    mutationPlan: {
      mode: "single",
      steps: [{ id: "set-expense-category-status", kind: "primary", targetFingerprint: target.fingerprint, reconciliationStrategy: "state-command" }],
    },
  };
}

export async function commitExpenseCategoryStatusUpdate(
  ctx: ActionContext,
  payload: Record<string, unknown>,
  operation: ConfirmableOperation,
  actionName: string,
): Promise<CommitResult> {
  const { id, archived } = payload as { id: string; archived: boolean };
  return commitSingleDurableRiskyStep({
    ctx, operation, planStepId: "set-expense-category-status", name: "Set expense category status",
    verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (snapshot) => staleCategoryFetch(ctx, snapshot) },
    dispatch: async () => {
      const result = await dispatchWithReconciliation({
        dispatch: async () => { await ctx.clockify.setExpenseCategoryArchivedAtomic(id, archived); return true as const; },
        reconcile: async () => (await expenseCategoryById(ctx, id))?.archived === archived ? true as const : undefined,
      });
      return { effect: { archived }, detail: { reconciled: result.reconciled } };
    },
    success: () => successReceipt({
      action: actionName,
      entity: "expense_category",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "expense_category", id, name: archived ? "archived" : "active" }] },
    }),
  });
}

export async function previewDeleteArchivedExpenseCategory(
  ctx: ActionContext,
  args: z.infer<typeof expenseCategoryTargetRefSchema>,
): Promise<RiskyPreviewResult | RiskyClarifyResult> {
  const resolved = await resolveExpenseCategoryRef(ctx, args, "delete", true);
  if (!resolved.ok) return resolved.clarify;
  const name = resolved.name ?? args.name;
  const target = await expenseCategoryTarget(ctx, resolved.id);
  if (!target) return { clarify: `Expense category ${resolved.id} could not be verified completely.` };
  const current = target.projection as { archived?: boolean };
  if (current.archived !== true) {
    return {
      clarify: `Expense category "${name ?? resolved.id}" is still active — archive it first with clockify_expenses_categories_status_update, or use clockify_expenses_categories_delete to archive and delete in one confirmation.`,
    };
  }
  return {
    actionLabel: "Delete archived expense category",
    targets: [{ type: "expense_category", id: resolved.id, ...(name !== undefined ? { name } : {}) }],
    expectedChanges: [`Delete archived expense category ${name ?? resolved.id}`],
    reversibility: "This cannot be undone.",
    warnings: ["Deleting an expense category is permanent."],
    payload: { id: resolved.id, ...(name !== undefined ? { name } : {}) },
    targetSnapshots: [target],
    mutationPlan: {
      mode: "single",
      steps: [{ id: "delete-expense-category", kind: "primary", targetFingerprint: target.fingerprint, reconciliationStrategy: "delete" }],
    },
  };
}

export async function commitDeleteArchivedExpenseCategory(
  ctx: ActionContext,
  payload: Record<string, unknown>,
  operation: ConfirmableOperation,
  actionName: string,
): Promise<CommitResult> {
  const { id, name } = payload as { id: string; name?: string };
  return commitSingleDurableRiskyStep({
    ctx, operation, planStepId: "delete-expense-category", name: "Delete expense category",
    verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (snapshot) => staleCategoryFetch(ctx, snapshot) },
    dispatch: async () => {
      const current = await expenseCategoryById(ctx, id);
      if (!current || current.archived !== true) throw new Error("stale_target");
      const result = await dispatchWithReconciliation({
        dispatch: async () => { await ctx.clockify.deleteExpenseCategoryAtomic(id); return true as const; },
        reconcile: async () => {
          const rows = await listAllExpenseCategories(ctx);
          return rows && !rows.some((row) => row.id === id) ? true as const : undefined;
        },
      });
      return { effect: { deleted: { type: "expense_category", id } }, detail: { reconciled: result.reconciled } };
    },
    success: () => successReceipt({
      action: actionName,
      entity: "expense_category",
      ids: { workspaceId: ctx.workspaceId },
      changed: { deleted: [{ type: "expense_category", id, name }] },
    }),
  });
}
