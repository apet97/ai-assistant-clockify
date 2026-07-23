import { z } from "zod";
import { zNumberLike, zStringList } from "../arg-shapes.js";
import type {
  ActionContext,
  CommitResult,
  ConfirmableOperation,
  RiskyClarifyResult,
  RiskyPreviewResult,
} from "../action.js";
import { successReceipt } from "../receipts.js";
import { toMinor } from "../money.js";
import { describePatch, resolveEntityRef, resolveUserRefs } from "./resolve.js";
import { buildRatePreview } from "./rate.js";
import { commitSingleDurableRiskyStep } from "../durable-risky-write.js";
import {
  captureStructureSnapshot,
  dispatchWithReconciliation,
  fetchStructureSnapshot,
  mutationPlan,
  reconcileDelete,
  requireFreshSnapshots,
  snapshot,
} from "./structure-durable.js";
import { sanitizedFingerprint } from "../safe-json.js";
import { GROUP_MEMBER_BATCH_MAX } from "../safety-limits.js";

const TASK_GONE_CLARIFY = "The task or its project no longer exists. Refresh and try again." as const;

async function loadTaskTargetContext(
  ctx: ActionContext,
  projectId: string,
  taskId: string,
): Promise<
  | {
    ok: true;
    parent: NonNullable<Awaited<ReturnType<ActionContext["clockify"]["getProject"]>>>;
    current: NonNullable<Awaited<ReturnType<ActionContext["clockify"]["getTask"]>>>;
  }
  | { ok: false; clarify: RiskyClarifyResult }
> {
  const parent = await ctx.clockify.getProject(projectId);
  const current = await ctx.clockify.getTask(projectId, taskId);
  if (!parent || !current) return { ok: false, clarify: { clarify: TASK_GONE_CLARIFY } };
  return { ok: true, parent, current };
}

async function captureTaskParentTargetSnapshots(
  ctx: ActionContext,
  projectId: string,
  parent: NonNullable<Awaited<ReturnType<ActionContext["clockify"]["getProject"]>>>,
  current: NonNullable<Awaited<ReturnType<ActionContext["clockify"]["getTask"]>>>,
) {
  return [
    await captureStructureSnapshot(ctx, "parent", "project", parent),
    await captureStructureSnapshot(ctx, "target", "task", current, { projectId }),
  ];
}

export async function loadTaskDeleteBaseline(
  ctx: ActionContext,
  args: { projectId?: string; projectName?: string; id?: string; name?: string },
): Promise<
  | {
    ok: true;
    resolved: { projectId: string; id: string; name?: string };
    name?: string;
    parent: NonNullable<Awaited<ReturnType<ActionContext["clockify"]["getProject"]>>>;
    current: NonNullable<Awaited<ReturnType<ActionContext["clockify"]["getTask"]>>>;
    raw: Record<string, unknown>;
  }
  | { ok: false; clarify: RiskyClarifyResult }
> {
  const resolved = await resolveTaskRef(
    ctx,
    { projectId: args.projectId, projectName: args.projectName, id: args.id, name: args.name },
    "delete",
    { verifyTask: true },
  );
  if (!resolved.ok) return { ok: false, clarify: resolved.clarify };
  const loaded = await loadTaskTargetContext(ctx, resolved.projectId, resolved.id);
  if (!loaded.ok) return loaded;
  const raw = await ctx.clockify.prepareTaskUpdate(resolved.projectId, resolved.id, {});
  return {
    ok: true,
    resolved,
    name: resolved.name ?? args.name,
    parent: loaded.parent,
    current: loaded.current,
    raw,
  };
}

export async function resolveTaskRef(
  ctx: ActionContext,
  refs: { projectId?: string; projectName?: string; id?: string; name?: string },
  verb: string,
  opts?: { verifyTask?: boolean },
): Promise<
  | { ok: true; projectId: string; id: string; name?: string }
  | { ok: false; clarify: RiskyClarifyResult }
> {
  const project = await resolveEntityRef(
    { id: refs.projectId, name: refs.projectName },
    {
      noun: "project",
      verb,
      list: (filter) => ctx.clockify.listProjects(filter),
      includeArchived: verb === "delete",
    },
  );
  if (!project.ok) return project;
  const task = await resolveEntityRef(
    { id: refs.id, name: refs.name },
    { noun: "task", verb, list: () => ctx.clockify.listTasks(project.id), verifyId: opts?.verifyTask },
  );
  if (!task.ok) return task;
  return { ok: true, projectId: project.id, id: task.id, name: task.name ?? refs.name };
}

export const taskTargetRefSchema = z
  .object({
    projectId: z.string().min(1).optional(),
    projectName: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
  })
  .refine((v) => v.projectId !== undefined || v.projectName !== undefined, {
    message: "Provide the project id or its exact projectName.",
  })
  .refine((v) => v.id !== undefined || v.name !== undefined, {
    message: "Provide the task id or its exact name.",
  });

export const taskClosedUpdateSchema = z
  .object({
    projectId: z.string().min(1).optional(),
    projectName: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    currentName: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    estimate: z.string().min(1).optional(),
    budgetEstimate: zNumberLike(z.number().int().nonnegative()).optional(),
    billable: z.boolean().optional(),
  })
  .refine((v) => v.projectId !== undefined || v.projectName !== undefined, {
    message: "Provide the project id or its exact projectName.",
  })
  .refine((v) => v.id !== undefined || v.currentName !== undefined, {
    message: "Provide the task id or its exact currentName.",
  })
  .refine(
    (v) => v.name !== undefined || v.estimate !== undefined || v.budgetEstimate !== undefined || v.billable !== undefined,
    { message: "Provide at least one field to change." },
  );

export const taskStatusUpdateSchema = z
  .object({
    projectId: z.string().min(1).optional(),
    projectName: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    currentName: z.string().min(1).optional(),
    status: z.enum(["ACTIVE", "DONE"]),
  })
  .refine((v) => v.projectId !== undefined || v.projectName !== undefined, {
    message: "Provide the project id or its exact projectName.",
  })
  .refine((v) => v.id !== undefined || v.currentName !== undefined, {
    message: "Provide the task id or its exact currentName.",
  });

export const taskAssigneesReplaceSchema = z
  .object({
    projectId: z.string().min(1).optional(),
    projectName: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    currentName: z.string().min(1).optional(),
    assigneeIds: zStringList(z.array(z.string()).min(1).max(GROUP_MEMBER_BATCH_MAX)),
  })
  .refine((v) => v.projectId !== undefined || v.projectName !== undefined, {
    message: "Provide the project id or its exact projectName.",
  })
  .refine((v) => v.id !== undefined || v.currentName !== undefined, {
    message: "Provide the task id or its exact currentName.",
  });

export const taskRateSchema = z
  .object({
    projectId: z.string().min(1).optional(),
    projectName: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    taskName: z.string().min(1).optional(),
    amount: zNumberLike(z.number().nonnegative()),
    amountUnit: z.enum(["major", "minor"]).default("major"),
    since: z.string().optional(),
  })
  .refine((v) => v.projectId !== undefined || v.projectName !== undefined, {
    message: "Provide the project id or its exact projectName.",
  })
  .refine((v) => v.taskId !== undefined || v.taskName !== undefined, {
    message: "Provide the task id or its exact taskName.",
  });

export async function previewTaskClosedUpdate(
  ctx: ActionContext,
  args: z.infer<typeof taskClosedUpdateSchema>,
): Promise<RiskyPreviewResult | RiskyClarifyResult> {
  const resolved = await resolveTaskRef(
    ctx,
    {
      projectId: args.projectId,
      projectName: args.projectName,
      id: args.id,
      name: args.currentName,
    },
    "update",
    { verifyTask: true },
  );
  if (!resolved.ok) return resolved.clarify;
  const patch: Record<string, unknown> = Object.fromEntries(Object.entries({
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.estimate !== undefined ? { estimate: args.estimate } : {}),
    ...(args.budgetEstimate !== undefined ? { budgetEstimate: args.budgetEstimate } : {}),
    ...(args.billable !== undefined ? { billable: args.billable } : {}),
  }).filter(([, value]) => value !== undefined));
  const loaded = await loadTaskTargetContext(ctx, resolved.projectId, resolved.id);
  if (!loaded.ok) return loaded.clarify;
  const targetSnapshots = await captureTaskParentTargetSnapshots(ctx, resolved.projectId, loaded.parent, loaded.current);
  const body = await ctx.clockify.prepareTaskUpdate(resolved.projectId, resolved.id, patch);
  return {
    actionLabel: "Update task",
    targets: [{ type: "task", id: resolved.id, name: resolved.name }],
    expectedChanges: describePatch(patch),
    reversibility: "You can update the task again to revert most fields.",
    warnings: ["Updating a task changes live workspace data."],
    payload: { projectId: resolved.projectId, id: resolved.id, patch, body },
    targetSnapshots,
    mutationPlan: mutationPlan([{ id: "update-task", strategy: "update", fingerprint: targetSnapshots[1]!.fingerprint }]),
  };
}

export async function commitTaskClosedUpdate(
  ctx: ActionContext,
  payload: Record<string, unknown>,
  operation: ConfirmableOperation,
  actionName: string,
): Promise<CommitResult> {
  const { projectId, id, body } = payload as { projectId: string; id: string; body: Record<string, unknown> };
  let updated: Awaited<ReturnType<typeof ctx.clockify.getTask>>;
  return commitSingleDurableRiskyStep({
    ctx, operation, planStepId: "update-task", name: "Update task",
    verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (stored) => fetchStructureSnapshot(ctx, stored) },
    dispatch: async () => {
      const result = await dispatchWithReconciliation({
        dispatch: () => ctx.clockify.updateTaskAtomic(projectId, id, body),
        reconcile: async () => {
          const raw = await ctx.clockify.prepareTaskUpdate(projectId, id, {});
          return sanitizedFingerprint(raw) === sanitizedFingerprint(body)
            ? raw as unknown as Awaited<ReturnType<typeof ctx.clockify.updateTaskAtomic>>
            : undefined;
        },
      });
      updated = result.value;
      return { externalId: result.value.id, effect: { updated: { type: "task", id, projectId } }, detail: { reconciled: result.reconciled } };
    },
    success: () => successReceipt({
      action: actionName,
      entity: "task",
      ids: { workspaceId: ctx.workspaceId, projectId },
      changed: { updated: [{ type: "task", id, name: updated?.name }] },
    }),
  });
}

export async function previewTaskStatusUpdate(
  ctx: ActionContext,
  args: z.infer<typeof taskStatusUpdateSchema>,
): Promise<RiskyPreviewResult | RiskyClarifyResult> {
  const resolved = await resolveTaskRef(
    ctx,
    { projectId: args.projectId, projectName: args.projectName, id: args.id, name: args.currentName },
    "update",
    { verifyTask: true },
  );
  if (!resolved.ok) return resolved.clarify;
  const loaded = await loadTaskTargetContext(ctx, resolved.projectId, resolved.id);
  if (!loaded.ok) return loaded.clarify;
  const patch = { status: args.status };
  const targetSnapshots = await captureTaskParentTargetSnapshots(ctx, resolved.projectId, loaded.parent, loaded.current);
  const body = await ctx.clockify.prepareTaskUpdate(resolved.projectId, resolved.id, patch);
  return {
    actionLabel: "Update task status",
    targets: [{ type: "task", id: resolved.id, name: resolved.name }],
    expectedChanges: [`Set task status to ${args.status}`],
    reversibility: "You can update the task status again.",
    warnings: ["Updating a task changes live workspace data."],
    payload: { projectId: resolved.projectId, id: resolved.id, status: args.status, body },
    targetSnapshots,
    mutationPlan: mutationPlan([{ id: "update-task-status", strategy: "update", fingerprint: targetSnapshots[1]!.fingerprint }]),
  };
}

export async function commitTaskStatusUpdate(
  ctx: ActionContext,
  payload: Record<string, unknown>,
  operation: ConfirmableOperation,
  actionName: string,
): Promise<CommitResult> {
  const { projectId, id, body } = payload as { projectId: string; id: string; body: Record<string, unknown> };
  return commitSingleDurableRiskyStep({
    ctx, operation, planStepId: "update-task-status", name: "Update task status",
    verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (stored) => fetchStructureSnapshot(ctx, stored) },
    dispatch: async () => {
      const result = await dispatchWithReconciliation({
        dispatch: () => ctx.clockify.updateTaskAtomic(projectId, id, body),
        reconcile: async () => {
          const raw = await ctx.clockify.prepareTaskUpdate(projectId, id, {});
          return raw.status === body.status
            ? raw as unknown as Awaited<ReturnType<typeof ctx.clockify.updateTaskAtomic>>
            : undefined;
        },
      });
      return { externalId: result.value.id, effect: { updated: { type: "task", id, projectId, status: body.status } }, detail: { reconciled: result.reconciled } };
    },
    success: () => successReceipt({
      action: actionName,
      entity: "task",
      ids: { workspaceId: ctx.workspaceId, projectId },
      changed: { updated: [{ type: "task", id }] },
    }),
  });
}

export async function previewTaskAssigneesReplace(
  ctx: ActionContext,
  args: z.infer<typeof taskAssigneesReplaceSchema>,
): Promise<RiskyPreviewResult | RiskyClarifyResult> {
  const resolved = await resolveTaskRef(
    ctx,
    { projectId: args.projectId, projectName: args.projectName, id: args.id, name: args.currentName },
    "assign",
    { verifyTask: true },
  );
  if (!resolved.ok) return resolved.clarify;
  const assignees = await resolveUserRefs(args.assigneeIds, {
    verb: "assign",
    adminUserId: ctx.adminUserId,
    listUsers: () => ctx.clockify.listUsers(),
  });
  if (!assignees.ok) return assignees.clarify;
  const loaded = await loadTaskTargetContext(ctx, resolved.projectId, resolved.id);
  if (!loaded.ok) return loaded.clarify;
  const patch = { assigneeIds: assignees.userIds };
  const targetSnapshots = await captureTaskParentTargetSnapshots(ctx, resolved.projectId, loaded.parent, loaded.current);
  const body = await ctx.clockify.prepareTaskUpdate(resolved.projectId, resolved.id, patch);
  return {
    actionLabel: "Replace task assignees",
    targets: [{ type: "task", id: resolved.id, name: resolved.name }],
    expectedChanges: [`Replace assignees (${assignees.userIds.length} member(s))`],
    reversibility: "You can update assignees again to restore prior membership.",
    warnings: ["This changes who is assigned to the task."],
    payload: { projectId: resolved.projectId, id: resolved.id, assigneeIds: assignees.userIds, body },
    targetSnapshots,
    mutationPlan: mutationPlan([{ id: "replace-task-assignees", strategy: "update", fingerprint: targetSnapshots[1]!.fingerprint }]),
  };
}

export async function commitTaskAssigneesReplace(
  ctx: ActionContext,
  payload: Record<string, unknown>,
  operation: ConfirmableOperation,
  actionName: string,
): Promise<CommitResult> {
  const { projectId, id, body, assigneeIds } = payload as {
    projectId: string;
    id: string;
    body: Record<string, unknown>;
    assigneeIds: string[];
  };
  return commitSingleDurableRiskyStep({
    ctx, operation, planStepId: "replace-task-assignees", name: "Replace task assignees",
    verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (stored) => fetchStructureSnapshot(ctx, stored) },
    dispatch: async () => {
      const result = await dispatchWithReconciliation({
        dispatch: () => ctx.clockify.updateTaskAtomic(projectId, id, body),
        reconcile: async () => {
          const raw = await ctx.clockify.prepareTaskUpdate(projectId, id, {});
          return JSON.stringify(raw.assigneeIds ?? []) === JSON.stringify(assigneeIds)
            ? raw as unknown as Awaited<ReturnType<typeof ctx.clockify.updateTaskAtomic>>
            : undefined;
        },
      });
      return { externalId: result.value.id, effect: { assigneeIds, taskId: id, projectId }, detail: { reconciled: result.reconciled } };
    },
    success: () => successReceipt({
      action: actionName,
      entity: "task",
      ids: { workspaceId: ctx.workspaceId, projectId },
      changed: { updated: [{ type: "task", id }] },
    }),
  });
}

export async function previewDeleteCompletedTask(
  ctx: ActionContext,
  args: { projectId?: string; projectName?: string; id?: string; name?: string },
): Promise<RiskyPreviewResult | RiskyClarifyResult> {
  const baseline = await loadTaskDeleteBaseline(ctx, args);
  if (!baseline.ok) return baseline.clarify;
  const { resolved, name, parent, current, raw } = baseline;
  const status = typeof raw.status === "string" ? raw.status : undefined;
  if (status !== "DONE") {
    return {
      clarify: `Task "${name ?? resolved.id}" is not DONE — mark it DONE first with clockify_tasks_status_update, or use clockify_tasks_delete to mark and delete in one confirmation.`,
    };
  }
  const targetSnapshots = [
    await captureStructureSnapshot(ctx, "parent", "project", parent),
    snapshot("target", "task", current, raw, { projectId: resolved.projectId }),
  ];
  return {
    actionLabel: "Delete completed task",
    targets: [{ type: "task", id: resolved.id, name }],
    expectedChanges: [`Delete completed task ${name ?? resolved.id}`],
    reversibility: "This cannot be undone.",
    warnings: ["Deleting a task is permanent."],
    payload: { projectId: resolved.projectId, id: resolved.id, name },
    targetSnapshots,
    mutationPlan: mutationPlan([{ id: "delete-completed-task", strategy: "delete", fingerprint: targetSnapshots[1]!.fingerprint }]),
  };
}

export async function commitDeleteCompletedTask(
  ctx: ActionContext,
  payload: Record<string, unknown>,
  operation: ConfirmableOperation,
  actionName: string,
): Promise<CommitResult> {
  const { projectId, id, name } = payload as { projectId: string; id: string; name?: string };
  return commitSingleDurableRiskyStep({
    ctx, operation, planStepId: "delete-completed-task", name: "Delete completed task",
    verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (stored) => fetchStructureSnapshot(ctx, stored) },
    dispatch: async () => {
      await requireFreshSnapshots(ctx, operation.targetSnapshots ?? []);
      const rawBeforeDelete = await ctx.clockify.prepareTaskUpdate(projectId, id, {});
      if (rawBeforeDelete.status !== "DONE") throw new Error("stale_target");
      const result = await dispatchWithReconciliation({
        dispatch: async () => { await ctx.clockify.deleteTaskAtomic(projectId, id); return true as const; },
        reconcile: () => reconcileDelete(() => ctx.clockify.getTask(projectId, id)),
      });
      return { effect: { deleted: { type: "task", id, projectId } }, detail: { reconciled: result.reconciled } };
    },
    success: () => successReceipt({
      action: actionName,
      entity: "task",
      ids: { workspaceId: ctx.workspaceId, projectId },
      changed: { deleted: [{ type: "task", id, name, projectId }] },
    }),
  });
}

export async function previewTaskRate(
  ctx: ActionContext,
  args: z.infer<typeof taskRateSchema>,
  options: { rateKind: "HOURLY" | "COST"; planStepId: string; payloadExtras?: Record<string, unknown> },
): Promise<RiskyPreviewResult | RiskyClarifyResult> {
  const resolved = await resolveTaskRef(
    ctx,
    { projectId: args.projectId, projectName: args.projectName, id: args.taskId, name: args.taskName },
    "set a rate on",
    { verifyTask: true },
  );
  if (!resolved.ok) return resolved.clarify;
  const loaded = await loadTaskTargetContext(ctx, resolved.projectId, resolved.id);
  if (!loaded.ok) return loaded.clarify;
  const amountMinor = toMinor(args.amount, args.amountUnit);
  const targetSnapshots = await captureTaskParentTargetSnapshots(ctx, resolved.projectId, loaded.parent, loaded.current);
  const taskLabel = resolved.name ?? resolved.id;
  return {
    ...buildRatePreview({
      targetType: "task",
      targetId: resolved.id,
      targetName: resolved.name,
      scopeLabel: `for "${taskLabel}"`,
      amountMinor,
      rateKind: options.rateKind,
      kindNoun: "task",
    }),
    payload: {
      projectId: resolved.projectId,
      taskId: resolved.id,
      amountMinor,
      ...(options.payloadExtras ?? {}),
      ...(args.since !== undefined ? { since: args.since } : {}),
    },
    targetSnapshots,
    mutationPlan: mutationPlan([{ id: options.planStepId, strategy: "update", fingerprint: targetSnapshots[1]!.fingerprint }]),
  };
}

export async function commitTaskRateStep(
  ctx: ActionContext,
  operation: ConfirmableOperation,
  rateInput: { projectId: string; taskId: string; amountMinor: number; since?: string },
  options: {
    planStepId: string;
    stepName: string;
    actionName: string;
    dispatch: (input: typeof rateInput) => Promise<void>;
    reconcileRateKey: "hourlyRate" | "costRate";
  },
): Promise<CommitResult> {
  return commitSingleDurableRiskyStep({
    ctx, operation, planStepId: options.planStepId, name: options.stepName,
    verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (stored) => fetchStructureSnapshot(ctx, stored) },
    dispatch: async () => {
      const result = await dispatchWithReconciliation({
        dispatch: async () => { await options.dispatch(rateInput); return true as const; },
        reconcile: async () => {
          const row = await ctx.clockify.getTask(rateInput.projectId, rateInput.taskId) as unknown as Record<string, unknown> | null;
          return row && (row[options.reconcileRateKey] as { amount?: unknown } | undefined)?.amount === rateInput.amountMinor
            ? true as const
            : undefined;
        },
      });
      return { effect: { updatedRate: { projectId: rateInput.projectId, taskId: rateInput.taskId } }, detail: { reconciled: result.reconciled } };
    },
    success: () => successReceipt({
      action: options.actionName,
      entity: "task",
      ids: { workspaceId: ctx.workspaceId, projectId: rateInput.projectId },
      changed: { updated: [{ type: "task", id: rateInput.taskId }] },
    }),
  });
}

export async function commitGenericTaskRate(
  ctx: ActionContext,
  payload: Record<string, unknown>,
  operation: ConfirmableOperation,
  actionName: string,
): Promise<CommitResult> {
  const typed = payload as {
    projectId: string;
    taskId: string;
    rateKind: "HOURLY" | "COST";
    amountMinor: number;
    since?: string;
  };
  return commitSingleDurableRiskyStep({
    ctx, operation, planStepId: "update-task-rate", name: "Update task rate",
    verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (stored) => fetchStructureSnapshot(ctx, stored) },
    dispatch: async () => {
      const result = await dispatchWithReconciliation({
        dispatch: async () => { await ctx.clockify.updateTaskRateAtomic(typed); return true as const; },
        reconcile: async () => {
          const row = await ctx.clockify.getTask(typed.projectId, typed.taskId) as unknown as Record<string, unknown> | null;
          const key = typed.rateKind === "COST" ? "costRate" : "hourlyRate";
          return row && (row[key] as { amount?: unknown } | undefined)?.amount === typed.amountMinor ? true as const : undefined;
        },
      });
      return { effect: { updatedRate: { projectId: typed.projectId, taskId: typed.taskId } }, detail: { reconciled: result.reconciled } };
    },
    success: () => successReceipt({
      action: actionName,
      entity: "task",
      ids: { workspaceId: ctx.workspaceId, projectId: typed.projectId },
      changed: { updated: [{ type: "task", id: typed.taskId }] },
    }),
  });
}
