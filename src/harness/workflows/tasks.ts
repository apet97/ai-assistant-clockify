import { z } from "zod";
import { zStringList } from "../arg-shapes.js";
import {
  clarifyResult,
  defineAction,
  defineReadAction,
  defineRiskyAction,
  type ActionContext,
  type ActionDefinition,
  type CommitResult,
  type RiskyClarifyResult,
} from "../action.js";
import { listReceipt, successReceipt } from "../receipts.js";
import { toMinor } from "../money.js";
import { describePatch, resolveEntityRef, resolveUserRefs } from "./resolve.js";
import { RATE_FIELDS, buildRatePreview } from "./rate.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import { commitSingleDurableRiskyStep } from "../durable-risky-write.js";
import { executeDurableRiskyStep } from "../durable-risky-write.js";
import { executeCompensationStep, isJournalDegradedStep } from "../mutation-workflow.js";
import { errorReceipt } from "../receipts.js";
import { DefinitiveWriteFailure } from "../../clockify/write-outcome.js";
import { captureStructureSnapshot, defineStructureDurableSafeWriteAction, dispatchWithReconciliation, fetchStructureSnapshot, mutationPlan, reconcileCreate, reconcileDelete, requireFreshSnapshots, snapshot } from "./structure-durable.js";
import { sanitizedFingerprint } from "../safe-json.js";
import { STRUCTURE_API_METADATA } from "./structure-api-metadata.js";

/**
 * Typed task workflows (goclmcp §2.3). Tasks live under a project. Reads + create
 * execute immediately; update/delete/rate are risky and preview→commit. Rate is a
 * billing action gated by `invoices`; the rest are `work_structure`.
 */

const WORK = "work_structure" as const;

/**
 * Tasks are project-scoped, so a symbolic reference resolves in two steps:
 * project (by id or name) first, then the task within it. Either step can stop
 * with a clarify — an unresolved reference must never reach a confirmable
 * operation (the live loop confirmed previews whose commits then 400'd).
 */
async function resolveTaskRef(
  ctx: ActionContext,
  refs: { projectId?: string; projectName?: string; id?: string; name?: string },
  verb: string,
  // `verifyTask` forces a real task lookup even for a 24-hex id so the caller's
  // preview shows the REAL task name (billing rate cards) and a wrong id clarifies.
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
      // A task delete may target a task inside an ARCHIVED project.
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
  schema: z
    .object({
      projectId: z.string().min(1).optional(),
      projectName: z.string().min(1).optional(),
      id: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
    })
    .refine(
      (v) =>
        (v.projectId !== undefined || v.projectName !== undefined) &&
        (v.id !== undefined || v.name !== undefined),
      { message: "Provide the project (id or name) and the task (id or name)." },
    ),
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
    /** Assignees to set on the new task: user ids, exact names, or 'me' (resolved server-side). */
    assigneeIds: zStringList().optional(),
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
        // projectId rides on the ref so an undo (reverseCreation) can delete the
        // task — a task delete is project-scoped on the wire.
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
    "Update a task (rename, reassign, status, estimate). Pass `projectId` (or the exact `projectName`) and the task's `id` (or its exact `currentName`) — the harness resolves names server-side; use `currentName` + the new `name` to RENAME without listing first. `assigneeIds` entries may be user ids, exact names, or 'me' (resolved server-side, clarifies on an unknown name). Elevated write — previews and requires confirmation.",
  group: WORK,
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations: ["parent", "target"] }, strategies: ["update"] }),
  argumentOpenPaths: ["fields"],
  schema: z
    .object({
      projectId: z.string().min(1).optional(),
      /** The task's project name, resolved to an id server-side. */
      projectName: z.string().min(1).optional(),
      id: z.string().min(1).optional(),
      /** The task's existing name, resolved to an id server-side (rename-by-name). */
      currentName: z.string().min(1).optional(),
      name: z.string().optional(),
      status: z.string().optional(),
      assigneeIds: zStringList(z.array(z.string())).optional(),
      fields: z.record(z.string(), z.unknown()).optional(),
    })
    .refine((v) => v.projectId !== undefined || v.projectName !== undefined, {
      message: "Provide the project id or its exact projectName.",
    })
    .refine((v) => v.id !== undefined || v.currentName !== undefined, {
      message: "Provide the task id or its exact currentName.",
    })
    .refine((v) => v.name !== undefined || v.status !== undefined || v.assigneeIds !== undefined || v.fields !== undefined, {
      message: "Provide at least one field to change.",
    }),
  async preview(ctx, args) {
    const resolved = await resolveTaskRef(
      ctx,
      { projectId: args.projectId, projectName: args.projectName, id: args.id, name: args.currentName },
      "update",
      { verifyTask: true },
    );
    if (!resolved.ok) return resolved.clarify;
    let assigneeIds: string[] | undefined;
    if (args.assigneeIds !== undefined) {
      const assignees = await resolveUserRefs(args.assigneeIds, {
        verb: "assign",
        adminUserId: ctx.adminUserId,
        listUsers: () => ctx.clockify.listUsers(),
      });
      if (!assignees.ok) return assignees.clarify;
      assigneeIds = assignees.userIds;
    }
    const patch: Record<string, unknown> = {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(assigneeIds !== undefined ? { assigneeIds } : {}),
      ...(args.fields ?? {}),
    };
    const parent = await ctx.clockify.getProject(resolved.projectId);
    const current = await ctx.clockify.getTask(resolved.projectId, resolved.id);
    if (!parent || !current) return { clarify: "The task or its project no longer exists. Refresh and try again." };
    const targetSnapshots = [
      await captureStructureSnapshot(ctx, "parent", "project", parent),
      await captureStructureSnapshot(ctx, "target", "task", current, { projectId: resolved.projectId }),
    ];
    const body = await ctx.clockify.prepareTaskUpdate(resolved.projectId, resolved.id, patch);
    return {
      actionLabel: "Update task",
      targets: [{ type: "task", id: resolved.id, name: resolved.name ?? args.name }],
      expectedChanges: describePatch(patch),
      reversibility: "You can update the task again to revert most fields.",
      warnings: ["Updating a task changes live workspace data."],
      payload: { projectId: resolved.projectId, id: resolved.id, patch, body },
      targetSnapshots,
      mutationPlan: mutationPlan([{ id: "update-task", strategy: "update", fingerprint: targetSnapshots[1]!.fingerprint }]),
    };
  },
  async commit(ctx, payload, operation) {
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
      success: () => successReceipt({ action: "clockify_tasks_update", entity: "task", ids: { workspaceId: ctx.workspaceId, projectId }, changed: { updated: [{ type: "task", id, name: updated?.name }] } }),
    });
  },
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
  schema: z
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
    }),
  async preview(ctx, args) {
    const resolved = await resolveTaskRef(
      ctx,
      { projectId: args.projectId, projectName: args.projectName, id: args.id, name: args.name },
      "delete",
      { verifyTask: true },
    );
    if (!resolved.ok) return resolved.clarify;
    const name = resolved.name ?? args.name;
    const parent = await ctx.clockify.getProject(resolved.projectId);
    const current = await ctx.clockify.getTask(resolved.projectId, resolved.id);
    if (!parent || !current) return { clarify: "The task or its project no longer exists. Refresh and try again." };
    const raw = await ctx.clockify.prepareTaskUpdate(resolved.projectId, resolved.id, {});
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
  schema: z
    .object({
      projectId: z.string().min(1).optional(),
      projectName: z.string().min(1).optional(),
      taskId: z.string().min(1).optional(),
      taskName: z.string().min(1).optional(),
      ...RATE_FIELDS,
    })
    .refine((v) => v.projectId !== undefined || v.projectName !== undefined, { message: "Provide the project id or its exact projectName." })
    .refine((v) => v.taskId !== undefined || v.taskName !== undefined, { message: "Provide the task id or its exact taskName." }),
  async preview(ctx, args) {
    // Resolve + VERIFY the task exists before previewing (verifyTask): an
    // unverified 24-hex id would otherwise sail past the trust-the-id path,
    // echo the model-supplied name onto the billing card, and 404 at commit.
    // verifyTask fetches the REAL name and clarifies on a wrong id.
    const resolved = await resolveTaskRef(
      ctx,
      { projectId: args.projectId, projectName: args.projectName, id: args.taskId, name: args.taskName },
      "set a rate on",
      { verifyTask: true },
    );
    if (!resolved.ok) return resolved.clarify;
    const amountMinor = toMinor(args.amount, args.amountUnit);
    const parent = await ctx.clockify.getProject(resolved.projectId);
    const current = await ctx.clockify.getTask(resolved.projectId, resolved.id);
    if (!parent || !current) return { clarify: "The task or its project no longer exists. Refresh and try again." };
    const targetSnapshots = [
      await captureStructureSnapshot(ctx, "parent", "project", parent),
      await captureStructureSnapshot(ctx, "target", "task", current, { projectId: resolved.projectId }),
    ];
    const taskLabel = resolved.name ?? resolved.id;
    return {
      ...buildRatePreview({
        targetType: "task",
        targetId: resolved.id,
        targetName: resolved.name,
        scopeLabel: `for "${taskLabel}"`,
        amountMinor,
        rateKind: args.rateKind,
        kindNoun: "task",
      }),
      payload: {
        projectId: resolved.projectId,
        taskId: resolved.id,
        rateKind: args.rateKind,
        amountMinor,
        since: args.since,
      },
      targetSnapshots,
      mutationPlan: mutationPlan([{ id: "update-task-rate", strategy: "update", fingerprint: targetSnapshots[1]!.fingerprint }]),
    };
  },
  async commit(ctx, payload, operation) {
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
      success: () => successReceipt({ action: "clockify_tasks_rate_update", entity: "task", ids: { workspaceId: ctx.workspaceId, projectId: typed.projectId }, changed: { updated: [{ type: "task", id: typed.taskId }] } }),
    });
  },
});

export const TASK_ACTIONS: ActionDefinition[] = [
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  rateUpdate,
];
