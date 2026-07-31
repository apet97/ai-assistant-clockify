import { z } from "zod";
import {
  defineRiskyAction,
  type CommitResult,
  type ActionDefinition,
  type RiskyPreviewResult,
} from "../action.js";
import { canWrite } from "../permissions.js";
import { successReceipt, errorReceipt } from "../receipts.js";
import { resolveEntityRef, resolveUserRefs } from "./resolve.js";
import { fromMinor, toMinor } from "../money.js";
import { zNumberLike, zStringList } from "../arg-shapes.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import { executeDurableRiskyStep } from "../durable-risky-write.js";
import { captureStructureSnapshot, dispatchWithReconciliation, reconcileCreate } from "./structure-durable.js";
import { dynamicMutationPlan, fetchCompositeSnapshot, userProjection } from "./composite-durable.js";
import { captureTargetSnapshot, verifyTargetSnapshots } from "../target-snapshots.js";
import { sanitizedFingerprint } from "../safe-json.js";
import { DefinitiveWriteFailure } from "../../clockify/write-outcome.js";
import { SETUP_TASK_ASSIGNEE_BATCH_MAX } from "../safety-limits.js";
import { STRUCTURE_API_METADATA } from "./structure-api-metadata.js";

/**
 * `clockify_setup_task` — the task analog of `clockify_setup_project`. "Create a
 * task in <project>, assign people, set its rate" becomes ONE preview listing
 * every change → ONE Confirm → an atomic composition (create task with assignees,
 * then set the task's billable rate). Mirrors the setup_project shape.
 *
 * Note vs setup_project: a task's assignees ride in the createTask body (one
 * work_structure write) and a task's rate is task-wide (no per-member rate), so
 * there are at most two steps and only `invoices` (the rate) needs a sub-group
 * pre-check beyond the outer `work_structure` gate. The created task is reported
 * in `changed.created` WITH its projectId, so the standard one-click undo
 * (reverseCreationDurably → project-scoped deleteTask) removes it (and its rate). The
 * mid-commit rollback uses the same typed deleteTask compensator.
 */

const rateKindEnum = z.enum(["hourly", "cost"]);

// The resolved composition payload, persisted to the pending confirmation and read
// back at commit/idempotency time. A Zod schema (not just a cast) so a stored-shape
// drift — e.g. a pending preview that spans a deploy which changed this shape — fails
// LOUDLY at commit instead of a silent wrong-field cast. z.infer keeps the type in sync.
const setupTaskPayloadSchema = z.object({
  projectId: z.string(),
  projectName: z.string().optional(),
  name: z.string(),
  assigneeIds: z.array(z.string()),
  rate: z.object({ amountMinor: z.number(), kind: rateKindEnum }).optional(),
});
type SetupTaskPayload = z.infer<typeof setupTaskPayloadSchema>;

const setupTask = defineRiskyAction({
  name: "clockify_setup_task",
  ...STRUCTURE_API_METADATA.clockify_setup_task,
  description:
    'Create a NEW task in an existing project AND set it up in one step — assign members (names or "me") and set the task\'s billable/cost rate — as ONE preview and ONE Confirm. Use this for "create a task in <project> and set its rate". For just creating or assigning a task with no rate, use clockify_tasks_create.',
  group: "work_structure",
  risks: ["high_risk_write", "billing"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({
    source: "confirmed",
    targeting: { mode: "snapshots", relations: ["parent"] },
    strategies: ["create", "update"],
  }),
  schema: z
    .object({
      projectId: z.string().optional(),
      projectName: z.string().optional(),
      name: z.string().min(1),
      /** Assignees (names or "me") to set on the new task. */
      assignees: zStringList(z.array(z.string().min(1)).max(SETUP_TASK_ASSIGNEE_BATCH_MAX)).optional(),
      /** The task's billable/cost rate amount (task-wide). */
      rate: zNumberLike(z.number().nonnegative()).optional(),
      rateKind: rateKindEnum.default("hourly"),
      rateUnit: z.enum(["major", "minor"]).default("major"),
    })
    .refine((v) => v.projectId !== undefined || v.projectName !== undefined, {
      message: "Provide the project id or its exact projectName.",
    }),
  async preview(ctx, args) {
    const unit = args.rateUnit ?? "major";

    // 1. Parent project (must already exist) — resolve before any write.
    const project = await resolveEntityRef(
      { id: args.projectId, name: args.projectName },
      { noun: "project", verb: "create the task in", list: (f) => ctx.clockify.listProjects(f), verifyId: true },
    );
    if (!project.ok) return project.clarify;
    const currentProject = await ctx.clockify.getProject(project.id);
    if (!currentProject) return { clarify: "The selected project no longer exists. Refresh and try again." };
    const parentSnapshot = await captureStructureSnapshot(ctx, "parent", "project", currentProject);

    // 2. Assignees (id/name/"me").
    let assigneeIds: string[] = [];
    let assigneeLabels: string[] = [];
    let usersPromise: ReturnType<typeof ctx.clockify.listUsers> | undefined;
    const listUsers = (): ReturnType<typeof ctx.clockify.listUsers> =>
      (usersPromise ??= ctx.clockify.listUsers());
    if (args.assignees?.length) {
      const m = await resolveUserRefs(args.assignees, {
        verb: "assign",
        adminUserId: ctx.adminUserId,
        listUsers,
        verifyIds: true,
      });
      if (!m.ok) return m.clarify;
      assigneeIds = m.userIds;
      assigneeLabels = m.labels;
    }
    const parentSnapshots = [parentSnapshot];
    if (assigneeIds.length) {
      const users = await listUsers();
      if (users.truncated) return { clarify: "Clockify returned an incomplete assignee list. Use exact active user IDs or retry." };
      for (const userId of assigneeIds) {
        const user = users.rows.find((candidate) => candidate.id === userId);
        if (!user) return { clarify: `Assignee ${userId} could not be verified. Refresh and try again.` };
        parentSnapshots.push(captureTargetSnapshot(
          "parent",
          { type: "user", id: user.id, name: user.name },
          userProjection(user),
        ));
      }
    }

    // 3. Pre-check the rate's sub-group (invoices) — the outer gate is work_structure.
    if (args.rate !== undefined && !canWrite(ctx.policy, "invoices")) {
      return {
        clarify:
          "I can't set the task rate because write access to invoices is disabled in your assistant permissions. Enable it (or drop the rate) and try again.",
      };
    }

    const rate = args.rate !== undefined ? { amountMinor: toMinor(args.rate, unit), kind: args.rateKind } : undefined;
    const projectName = project.name ?? args.projectName;
    const expectedChanges: string[] = [`Create task "${args.name}" in project "${projectName ?? project.id}"`];
    for (const label of assigneeLabels) expectedChanges.push(label === "you" ? "Assign you" : `Assign "${label}"`);
    if (rate) expectedChanges.push(`Set the task ${rate.kind} rate to $${fromMinor(rate.amountMinor)}`);

    const payload: SetupTaskPayload = {
      projectId: project.id,
      ...(projectName ? { projectName } : {}),
      name: args.name,
      assigneeIds,
      ...(rate ? { rate } : {}),
    };

    const result: RiskyPreviewResult = {
      actionLabel: "Set up task",
      targets: [{ type: "project", id: project.id, ...(projectName ? { name: projectName } : {}) }],
      expectedChanges,
      reversibility: "Undo removes the created task (and its rate) from the project.",
      warnings: ["This creates a task, sets its assignees, and sets a billable rate."],
      payload: payload as unknown as Record<string, unknown>,
      targetSnapshots: parentSnapshots,
      mutationPlan: dynamicMutationPlan([
        {
          id: "create-task",
          strategy: "create",
          targetFingerprint: sanitizedFingerprint(parentSnapshots.map(({ relation, ref, fingerprint }) => ({ relation, ref, fingerprint }))),
        },
        ...(rate ? [{ id: "set-task-rate", strategy: "update" as const }] : []),
      ]),
    };
    return result;
  },
  async commit(ctx, payload, operation): Promise<CommitResult> {
    const parsed = setupTaskPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return errorReceipt({
        action: "clockify_setup_task",
        code: "invalid_payload",
        message:
          "The saved task-setup details no longer match the expected shape — nothing was changed. Please re-issue the request.",
      });
    }
    const p = parsed.data;
    const rate = p.rate;
    const verifyParents = () => verifyTargetSnapshots(
      operation.targetSnapshots ?? [],
      (snapshot) => fetchCompositeSnapshot(ctx, snapshot),
    );
    const initialParents = await verifyParents();
    if (!initialParents.ok) {
      return errorReceipt({
        action: operation.actionName,
        code: initialParents.code,
        message: "The project or an assignee changed before task creation. No task was created.",
        recovery: { hint: "Refresh the project and assignees and create a fresh preview.", retryable: true },
      });
    }
    const baseline = await ctx.clockify.listTasks(p.projectId);
    if (baseline.truncated) {
      return errorReceipt({
        action: "clockify_setup_task",
        code: "target_evidence_incomplete",
        message: "Clockify returned an incomplete task list, so no task was created.",
        recovery: { hint: "Narrow the project task list and create a fresh preview.", retryable: true },
      });
    }
    const body = {
      projectId: p.projectId,
      name: p.name,
      ...(p.assigneeIds.length ? { assigneeIds: p.assigneeIds } : {}),
    };
    const immediateParents = await verifyParents();
    if (!immediateParents.ok) {
      return errorReceipt({
        action: operation.actionName,
        code: immediateParents.code,
        message: "The project or an assignee changed immediately before task creation. No task was created.",
        recovery: { hint: "Refresh the project and assignees and create a fresh preview.", retryable: true },
      });
    }
    let created: Awaited<ReturnType<typeof ctx.clockify.createTaskAtomic>> | undefined;
    let createReconciled = false;
    const createStep = await executeDurableRiskyStep({
      ctx,
      operation,
      planStepId: "create-task",
      index: 0,
      name: "Create task",
      preparedDetail: { beforeIds: baseline.rows.map((row) => row.id), body },
      dispatch: async () => {
        const verified = await verifyParents();
        if (!verified.ok) throw new DefinitiveWriteFailure("VERIFY", "create-task", verified.code);
        const dispatched = await dispatchWithReconciliation({
          dispatch: () => ctx.clockify.createTaskAtomic(body),
          reconcile: () => reconcileCreate({
            beforeIds: baseline.rows.map((row) => row.id),
            list: () => ctx.clockify.listTasks(p.projectId),
            matches: (row) => row.name === p.name &&
              JSON.stringify([...(row.assigneeIds ?? [])].sort()) === JSON.stringify([...p.assigneeIds].sort()),
          }),
        });
        createReconciled = dispatched.reconciled;
        created = dispatched.value;
        return {
          externalId: created.id,
          effect: { created: { type: "task", id: created.id, name: created.name, projectId: p.projectId } },
          detail: { reconciled: dispatched.reconciled },
        };
      },
    });
    if (createStep.status === "outcome_unknown") {
      return errorReceipt({
        action: "clockify_setup_task",
        code: "commit_outcome_unknown",
        message: "Task creation may or may not have applied. No rate mutation was sent.",
        recovery: { hint: "Verify the task list before retrying.", retryable: false },
      });
    }
    if (createStep.status !== "succeeded" || !created) {
      return errorReceipt({ action: "clockify_setup_task", code: "setup_failed", message: `Couldn't create task "${p.name}".` });
    }
    const createdRef = { type: "task", id: created.id, name: created.name, projectId: p.projectId };
    if (createReconciled && rate) {
      return partialSetupTask(createdRef, "The task create was proven successful after an ambiguous response, so no rate mutation was sent.");
    }
    if (rate) {
      if (!canWrite(ctx.policy, "invoices")) {
        return partialSetupTask(createdRef, "The task was created, but invoice write access is no longer available, so its rate was not set.");
      }
      const rateStep = await executeDurableRiskyStep({
        ctx,
        operation,
        planStepId: "set-task-rate",
        index: 1,
        name: "Set task rate",
        preparedDetail: { projectId: p.projectId, taskId: created.id, rate },
        dispatch: async () => {
          const current = await ctx.clockify.getTask(p.projectId, created!.id);
          if (!current) throw new Error("created_task_not_found");
          const input = {
            projectId: p.projectId,
            taskId: created!.id,
            rateKind: rate.kind === "cost" ? "COST" as const : "HOURLY" as const,
            amountMinor: rate.amountMinor,
          };
          const dispatched = await dispatchWithReconciliation({
            dispatch: async () => { await ctx.clockify.updateTaskRateAtomic(input); return true as const; },
            reconcile: async () => {
              const raw = await ctx.clockify.prepareTaskUpdate(p.projectId, created!.id, {});
              const key = input.rateKind === "COST" ? "costRate" : "hourlyRate";
              return (raw[key] as { amount?: unknown } | undefined)?.amount === input.amountMinor ? true as const : undefined;
            },
          });
          return { externalId: created!.id, effect: { updatedRate: input }, detail: { reconciled: dispatched.reconciled } };
        },
      });
      if (rateStep.status !== "succeeded") {
        return partialSetupTask(createdRef, "The task was created, but setting its rate did not complete definitively.");
      }
    }
    return successReceipt({
      action: "clockify_setup_task",
      entity: "task",
      ids: { workspaceId: ctx.workspaceId, projectId: p.projectId },
      changed: { created: [createdRef] },
    });
  },
  idempotencyKey(payload) {
    // A drifted payload must not throw here (this runs BEFORE commit, to claim the
    // dedup key); a stable raw key keeps dedup deterministic, and commit then surfaces
    // the honest invalid_payload receipt.
    const parsed = setupTaskPayloadSchema.safeParse(payload);
    if (!parsed.success) return JSON.stringify(payload);
    const p = parsed.data;
    return JSON.stringify({
      projectId: p.projectId,
      name: p.name,
      assigneeIds: [...p.assigneeIds].sort(),
      rate: p.rate ?? null,
    });
  },
});

function partialSetupTask(
  created: { type: string; id: string; name?: string; projectId: string },
  message: string,
): Extract<CommitResult, { kind: "partial" }> {
  return {
    kind: "partial",
    receipt: successReceipt({ action: "clockify_setup_task", entity: "task", changed: { created: [created] } }),
    message,
    recovery: { hint: "Review the created task and apply the missing rate manually if needed.", retryable: false },
  };
}

export const SETUP_TASK_ACTIONS: ActionDefinition[] = [setupTask];
