import { z } from "zod";
import { zStringList } from "../arg-shapes.js";
import {
  clarifyResult,
  defineAction,
  defineReadAction,
  defineRiskyAction,
  type ActionDefinition,
  type CommitResult,
  type SemanticLiteralAlias,
} from "../action.js";
import { listReceipt, successReceipt } from "../receipts.js";
import { resolveUserRefs } from "./resolve.js";
import { RATE_FIELDS } from "./rate.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import { executeDurableRiskyStep } from "../durable-risky-write.js";
import { executeCompensationStep, isJournalDegradedStep } from "../mutation-workflow.js";
import { errorReceipt } from "../receipts.js";
import { DefinitiveWriteFailure } from "../../clockify/write-outcome.js";
import { captureStructureSnapshot, defineStructureDurableSafeWriteAction, dispatchWithReconciliation, mutationPlan, reconcileCreate, reconcileDelete, requireFreshSnapshots, snapshot } from "./structure-durable.js";
import { STRUCTURE_API_METADATA } from "./structure-api-metadata.js";
import { GROUP_MEMBER_BATCH_MAX } from "../safety-limits.js";
import {
  commitGenericTaskRate,
  commitTaskClosedUpdate,
  loadTaskDeleteBaseline,
  previewTaskClosedUpdate,
  previewTaskRate,
  resolveTaskRef,
  taskClosedUpdateSchema,
  taskRateSchema,
  taskTargetRefSchema,
} from "./task-action-shared.js";

/**
 * Typed task workflows (goclmcp §2.3). Tasks live under a project. Reads + create
 * execute immediately; update/delete/rate are risky and preview→commit. Rate is a
 * billing action gated by `invoices`; the rest are `work_structure`.
 */

const WORK = "work_structure" as const;
const TASK_BILLABLE_LITERAL_ALIASES = Object.freeze([
  { path: "billable", value: false, authoredPhrases: Object.freeze(["non-billable", "nonbillable", "non billable", "not billable"]) },
  { path: "billable", value: true, authoredPhrases: Object.freeze(["billable"]) },
] satisfies readonly SemanticLiteralAlias[]);

const listTasks = defineReadAction({
  name: "clockify_tasks_list",
  ...STRUCTURE_API_METADATA.clockify_tasks_list,
  description: "List tasks under a project (optional name filter).",
  group: WORK,
  schema: z.object({ projectId: z.string().min(1), name: z.string().optional() }),
  async handler(ctx, args) {
    const { rows, truncated } = await ctx.clockify.listTasks(args.projectId, { name: args.name });
    return listReceipt({
      action: "clockify_tasks_list",
      entity: "task",
      ids: { workspaceId: ctx.workspaceId, projectId: args.projectId },
      rows,
      truncated,
    });
  },
});

const getTask = defineAction({
  name: "clockify_tasks_get",
  ...STRUCTURE_API_METADATA.clockify_tasks_get,
  description:
    "Fetch a single task within a project — by id or exact `name`, in a project given by `projectId` or `projectName` (resolved server-side).",
  featureGroup: WORK,
  risks: ["read"],
  schema: taskTargetRefSchema,
  async handler(ctx, args) {
    const resolved = await resolveTaskRef(ctx, args, "fetch");
    if (!resolved.ok) {
      return clarifyResult(resolved.clarify);
    }
    const entity = await ctx.clockify.getTask(resolved.projectId, resolved.id);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_tasks_get",
        entity: "task",
        ids: { workspaceId: ctx.workspaceId, projectId: resolved.projectId },
        data: { entity },
      }),
    };
  },
});

const createTaskDefinition = defineStructureDurableSafeWriteAction({
  ...STRUCTURE_API_METADATA.clockify_tasks_create,
  name: "clockify_tasks_create",
  description:
    "Create a task under a project, optionally assigning members inline with `assigneeIds` — each entry is a user id, an exact name, or 'me'; the harness resolves names server-side (clarifies on an unknown name). Safe write — executes immediately when policy allows.",
  group: WORK,
  stepName: "Create task",
  mutationContract: durableMutationContract({
    source: "safe",
    targeting: { mode: "snapshots", relations: ["parent"] },
    strategies: ["create"],
  }),
  schema: z.object({
    projectId: z.string().min(1),
    name: z.string().min(1),
    assigneeIds: zStringList(z.array(z.string()).max(GROUP_MEMBER_BATCH_MAX)).optional(),
  }),
  async prepare(ctx, args) {
    const project = await ctx.clockify.getProject(args.projectId);
    if (!project) {
      return { kind: "clarify" as const, clarify: "The selected project does not exist. Provide a current project id." };
    }
    let assigneeIds: string[] | undefined;
    if (args.assigneeIds?.length) {
      const resolved = await resolveUserRefs(args.assigneeIds, {
        verb: "assign",
        adminUserId: ctx.adminUserId,
        listUsers: () => ctx.clockify.listUsers(),
      });
      if (!resolved.ok) return { kind: "clarify", clarify: resolved.clarify.clarify, options: resolved.clarify.options };
      assigneeIds = resolved.userIds;
    }
    const body = {
      projectId: args.projectId,
      name: args.name,
      ...(assigneeIds?.length ? { assigneeIds } : {}),
    };
    const parentSnapshot = await captureStructureSnapshot(ctx, "parent", "project", project);
    return {
      operation: { body, targetSnapshots: [parentSnapshot] },
      mutationPlan: mutationPlan([{ id: "create-task", strategy: "create", fingerprint: parentSnapshot.fingerprint }]),
    };
  },
  async prepareDispatch(ctx, operation) {
    const { body, targetSnapshots } = operation as {
      body: Parameters<typeof ctx.clockify.createTaskAtomic>[0];
      targetSnapshots: ReturnType<typeof snapshot>[];
    };
    await requireFreshSnapshots(ctx, targetSnapshots);
    const baseline = await ctx.clockify.listTasks(body.projectId);
    if (baseline.truncated) throw new Error("create_baseline_incomplete");
    const beforeIds = baseline.rows.map((row) => row.id);
    return {
      preparedDetail: { preDispatch: { strategy: "task_create_baseline", ids: beforeIds, truncated: false } },
      state: { beforeIds },
    };
  },
  async dispatch(ctx, operation, state) {
    const { body } = operation as { body: Parameters<typeof ctx.clockify.createTaskAtomic>[0] };
    const result = await dispatchWithReconciliation({
      dispatch: () => ctx.clockify.createTaskAtomic(body),
      reconcile: () => reconcileCreate({
        beforeIds: state.beforeIds,
        list: () => ctx.clockify.listTasks(body.projectId),
        matches: (row) => row.name === body.name && JSON.stringify(row.assigneeIds ?? []) === JSON.stringify(body.assigneeIds ?? []),
      }),
    });
    const task = result.value;
    const created = { type: "task", id: task.id, name: task.name, projectId: body.projectId };
    return {
      result: successReceipt({
        action: "clockify_tasks_create",
        entity: "task",
        ids: { workspaceId: ctx.workspaceId, projectId: body.projectId },
        changed: { created: [created] },
      }),
      externalId: task.id,
      effect: { created },
      detail: { reconciled: result.reconciled, baselineComplete: true },
    };
  },
});

const createTask = Object.freeze({
  ...createTaskDefinition,
});

const updateTask = defineRiskyAction({
  name: "clockify_tasks_update",
  ...STRUCTURE_API_METADATA.clockify_tasks_update,
  description:
    "Update a task's name, estimate, budget estimate, or billable flag. Pass `projectId` (or the exact `projectName`) and the task's `id` (or its exact `currentName`) — the harness resolves names server-side; use `currentName` + the new `name` to RENAME without listing first. For status or assignees, use clockify_tasks_status_update or clockify_tasks_assignees_replace. Elevated write — previews and requires confirmation.",
  group: WORK,
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations: ["parent", "target"] }, strategies: ["update"] }),
  semanticLiteralAliases: TASK_BILLABLE_LITERAL_ALIASES,
  schema: taskClosedUpdateSchema,
  preview: (ctx, args) => previewTaskClosedUpdate(ctx, args),
  commit: (ctx, payload, operation) => commitTaskClosedUpdate(ctx, payload, operation, "clockify_tasks_update"),
});

const deleteTask = defineRiskyAction({
  name: "clockify_tasks_delete",
  ...STRUCTURE_API_METADATA.clockify_tasks_delete,
  description:
    "Delete a task (marks it DONE first, then deletes). Pass `projectId` (or the exact `projectName`) and the task's `id` (or its exact `name`) — the harness resolves names server-side. Previews and requires confirmation.",
  group: WORK,
  risks: ["destructive"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations: ["parent", "target"] }, strategies: ["state-command", "delete", "update"] }),
  schema: taskTargetRefSchema,
  async preview(ctx, args) {
    const baseline = await loadTaskDeleteBaseline(ctx, args);
    if (!baseline.ok) return baseline.clarify;
    const { resolved, name, parent, current, raw } = baseline;
    const originalStatus = typeof raw.status === "string" ? raw.status : undefined;
    const changedState = originalStatus !== "DONE";
    const doneBody = changedState ? { ...raw, status: "DONE" } : undefined;
    const restoreBody = changedState ? { ...raw, ...(originalStatus === undefined ? {} : { status: originalStatus }) } : undefined;
    const targetSnapshots = [
      await captureStructureSnapshot(ctx, "parent", "project", parent),
      snapshot("target", "task", current, raw, { projectId: resolved.projectId }),
    ];
    const transitionedTargetFingerprint = changedState
      ? snapshot("target", "task", current, doneBody, { projectId: resolved.projectId }).fingerprint
      : targetSnapshots[1]!.fingerprint;
    const steps = changedState
      ? [
          { id: "complete-task-for-delete", strategy: "state-command" as const, fingerprint: targetSnapshots[1]!.fingerprint },
          { id: "delete-task", strategy: "delete" as const, fingerprint: transitionedTargetFingerprint },
          { id: "restore-task-status", kind: "compensation" as const, strategy: "update" as const, fingerprint: transitionedTargetFingerprint },
        ]
      : [{ id: "delete-task", strategy: "delete" as const, fingerprint: targetSnapshots[1]!.fingerprint }];
    return {
      actionLabel: "Delete task",
      targets: [{ type: "task", id: resolved.id, name }],
      expectedChanges: [`Delete task ${name ?? resolved.id}`],
      reversibility: "This cannot be undone.",
      warnings: ["Deleting a task is permanent."],
      payload: { projectId: resolved.projectId, id: resolved.id, name, originalStatus, changedState, doneBody, restoreBody, transitionedTargetFingerprint },
      targetSnapshots,
      mutationPlan: mutationPlan(steps),
    };
  },
  async commit(ctx, payload, operation): Promise<CommitResult> {
    const { projectId, id, name, originalStatus, changedState, doneBody, restoreBody, transitionedTargetFingerprint } = payload as { projectId: string; id: string; name?: string; originalStatus?: string; changedState: boolean; doneBody?: Record<string, unknown>; restoreBody?: Record<string, unknown>; transitionedTargetFingerprint: string };
    let stateStep: Awaited<ReturnType<typeof executeDurableRiskyStep>> | undefined;
    let stateVerificationFailed = false;
    let index = 0;
    if (changedState) {
      stateStep = await executeDurableRiskyStep({
        ctx, operation, planStepId: "complete-task-for-delete", index, name: "Mark task done before delete",
        dispatch: async () => {
          try { await requireFreshSnapshots(ctx, operation.targetSnapshots ?? []); }
          catch (error) {
            if (error instanceof DefinitiveWriteFailure) stateVerificationFailed = true;
            throw error;
          }
          const result = await dispatchWithReconciliation({
            dispatch: () => ctx.clockify.updateTaskAtomic(projectId, id, doneBody!),
            reconcile: async () => { const raw = await ctx.clockify.prepareTaskUpdate(projectId, id, {}); return raw.status === "DONE" ? await ctx.clockify.getTask(projectId, id) ?? undefined : undefined; },
          });
          return { externalId: result.value.id, effect: { status: "DONE", taskId: id, projectId }, detail: { reconciled: result.reconciled } };
        },
      });
      index += 1;
      if (stateStep.status === "outcome_unknown") return errorReceipt({ action: operation.actionName, code: "commit_outcome_unknown", message: "Task status outcome is unknown; delete was not dispatched.", recovery: { hint: "Refresh the task before trying again.", retryable: false } });
      if (stateStep.status === "definitive_failed") return errorReceipt({
        action: operation.actionName,
        code: stateVerificationFailed ? "stale_target" : "write_failed",
        message: stateVerificationFailed
          ? "The task changed before it could be marked DONE. No mutation was sent."
          : "Clockify rejected marking the task DONE; delete was not dispatched.",
      });
      if (isJournalDegradedStep(stateStep)) return { kind: "partial", receipt: successReceipt({ action: operation.actionName, entity: "task", changed: { updated: [{ type: "task", id, name }] } }), message: "The task was marked DONE, but local settlement degraded, so delete was not dispatched.", recovery: { hint: "Refresh the task and review it manually.", retryable: false } };
    }
    let rawBeforeDelete: Record<string, unknown> | undefined;
    try { rawBeforeDelete = await ctx.clockify.prepareTaskUpdate(projectId, id, {}); }
    catch { rawBeforeDelete = undefined; }
    if (!rawBeforeDelete || rawBeforeDelete.status !== "DONE") return errorReceipt({ action: operation.actionName, code: "stale_target", message: "The task was not authoritatively DONE immediately before delete. No delete was sent.", recovery: { hint: "Create a fresh preview.", retryable: true } });
    const deleteSnapshot = snapshot(
      "target",
      "task",
      { id, ...(typeof rawBeforeDelete.name === "string" ? { name: rawBeforeDelete.name } : {}) },
      rawBeforeDelete,
      { projectId },
    );
    if (deleteSnapshot.fingerprint !== transitionedTargetFingerprint) return errorReceipt({ action: operation.actionName, code: "stale_target", message: "The completed task changed before delete. No delete was sent.", recovery: { hint: "Create a fresh preview.", retryable: true } });
    const deleted = await executeDurableRiskyStep({
      ctx, operation, planStepId: "delete-task", index, name: "Delete task",
      dispatch: async () => {
        await requireFreshSnapshots(ctx, [deleteSnapshot]);
        const result = await dispatchWithReconciliation({ dispatch: async () => { await ctx.clockify.deleteTaskAtomic(projectId, id); return true as const; }, reconcile: () => reconcileDelete(() => ctx.clockify.getTask(projectId, id)) });
        return { effect: { deleted: { type: "task", id, projectId } }, detail: { reconciled: result.reconciled } };
      },
    });
    if (deleted.status === "succeeded") return successReceipt({ action: operation.actionName, entity: "task", ids: { workspaceId: ctx.workspaceId, projectId }, changed: { deleted: [{ type: "task", id, name }] } });
    if (deleted.status === "outcome_unknown") return errorReceipt({ action: operation.actionName, code: "commit_outcome_unknown", message: "Task delete outcome is unknown. Status compensation was not attempted.", recovery: { hint: "Verify whether the task exists before any retry.", retryable: false } });
    if (!stateStep || !restoreBody) return errorReceipt({ action: operation.actionName, code: "write_failed", message: "Clockify rejected deletion of the already-DONE task." });
    if (!ctx.mutationJournal) {
      return { kind: "partial", receipt: successReceipt({ action: operation.actionName, entity: "task", changed: { updated: [{ type: "task", id, name }] } }), message: "Task status changed and delete failed; durable compensation was unavailable, so no restore mutation was sent.", recovery: { hint: "Inspect the task status manually.", retryable: false } };
    }
    const compensation = await executeCompensationStep({
      journal: ctx.mutationJournal, operationId: operation.operationId,
      step: { id: "restore-task-status", index: index + 1, name: "Restore task status", kind: "compensation", compensatesStepId: stateStep.id, targetFingerprint: transitionedTargetFingerprint },
      dispatch: async () => {
        const raw = await ctx.clockify.prepareTaskUpdate(projectId, id, {});
        if (raw.status !== "DONE") throw new Error("task_compensation_target_unknown");
        const currentSnapshot = snapshot(
          "target",
          "task",
          { id, ...(typeof raw.name === "string" ? { name: raw.name } : {}) },
          raw,
          { projectId },
        );
        if (currentSnapshot.fingerprint !== transitionedTargetFingerprint) throw new DefinitiveWriteFailure("VERIFY", "stale_target", "Task changed before compensation.");
        const result = await dispatchWithReconciliation({ dispatch: () => ctx.clockify.updateTaskAtomic(projectId, id, restoreBody), reconcile: async () => { const post = await ctx.clockify.prepareTaskUpdate(projectId, id, {}); return post.status === originalStatus ? post as unknown as Awaited<ReturnType<typeof ctx.clockify.updateTaskAtomic>> : undefined; } });
        return { externalId: result.value.id, effect: { restoredStatus: originalStatus, taskId: id }, detail: { reconciled: result.reconciled } };
      },
    });
    const compensationStatus = compensation.status;
    if (compensationStatus === "compensated") return errorReceipt({ action: operation.actionName, code: "write_failed", message: "Task deletion was rejected; the original status was restored." });
    return { kind: "partial", receipt: successReceipt({ action: operation.actionName, entity: "task", changed: { updated: [{ type: "task", id, name }] } }), message: "Task status changed and delete failed; restoring the original state did not complete definitively.", recovery: { hint: "Inspect the task status manually.", retryable: false } };
  },
});

const rateUpdate = defineRiskyAction({
  name: "clockify_tasks_rate_update",
  ...STRUCTURE_API_METADATA.clockify_tasks_rate_update,
  description:
    "Set a task's billable hourly or cost rate. Pass the project by `projectId` or exact `projectName`, and the task by `taskId` or exact `taskName` — the harness resolves names and verifies the task exists server-side. `amount` is major units (e.g. 75 = 75.00) unless `amountUnit` is 'minor'. Billing action — previews and requires confirmation.",
  group: "invoices",
  risks: ["billing"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations: ["parent", "target"] }, strategies: ["update"] }),
  schema: z.intersection(taskRateSchema, z.object({ rateKind: RATE_FIELDS.rateKind })),
  preview: (ctx, args) => previewTaskRate(ctx, args, {
    rateKind: args.rateKind,
    planStepId: "update-task-rate",
    payloadExtras: { rateKind: args.rateKind },
  }),
  commit: (ctx, payload, operation) => commitGenericTaskRate(ctx, payload, operation, "clockify_tasks_rate_update"),
});

export const TASK_ACTIONS: ActionDefinition[] = [
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  rateUpdate,
];
