import { z } from "zod";
import {
  defineAction,
  type ActionDefinition,
  type ActionResult,
  type ClarifyOption,
  type ConfirmableOperation,
} from "../action.js";
import { canWrite } from "../permissions.js";
import { successReceipt, errorReceipt } from "../receipts.js";
import { leftBehindNote, runComposition, type CompositionStep } from "../compose.js";
import { resolveEntityRef, resolveUserRefs } from "./resolve.js";
import { toMinor } from "../money.js";
import { zNumberLike, zStringList } from "../arg-shapes.js";

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
 * (reverseCreation → project-scoped deleteTask) removes it (and its rate). The
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

function asClarify(c: { clarify: string; options?: ClarifyOption[] }): ActionResult {
  return { kind: "clarify", message: c.clarify, options: c.options };
}

const setupTask = defineAction({
  name: "clockify_setup_task",
  description:
    'Create a NEW task in an existing project AND set it up in one step — assign members (names or "me") and set the task\'s billable/cost rate — as ONE preview and ONE Confirm. Use this for "create a task in <project> and set its rate". For just creating or assigning a task with no rate, use clockify_tasks_create.',
  featureGroup: "work_structure",
  risks: ["high_risk_write", "billing"],
  schema: z
    .object({
      projectId: z.string().optional(),
      projectName: z.string().optional(),
      name: z.string().min(1),
      /** Assignees (names or "me") to set on the new task. */
      assignees: zStringList(z.array(z.string().min(1))).optional(),
      /** The task's billable/cost rate amount (task-wide). */
      rate: zNumberLike(z.number().nonnegative()).optional(),
      rateKind: rateKindEnum.default("hourly"),
      rateUnit: z.enum(["major", "minor"]).default("major"),
    })
    .refine((v) => v.projectId !== undefined || v.projectName !== undefined, {
      message: "Provide the project id or its exact projectName.",
    }),
  async handler(ctx, args) {
    const unit = args.rateUnit ?? "major";

    // 1. Parent project (must already exist) — resolve before any write.
    const project = await resolveEntityRef(
      { id: args.projectId, name: args.projectName },
      { noun: "project", verb: "create the task in", list: (f) => ctx.clockify.listProjects(f) },
    );
    if (!project.ok) return asClarify(project.clarify);

    // 2. Assignees (id/name/"me").
    let assigneeIds: string[] = [];
    let assigneeLabels: string[] = [];
    if (args.assignees?.length) {
      const m = await resolveUserRefs(args.assignees, {
        verb: "assign",
        adminUserId: ctx.adminUserId,
        listUsers: () => ctx.clockify.listUsers(),
        verifyIds: true,
      });
      if (!m.ok) return asClarify(m.clarify);
      assigneeIds = m.userIds;
      assigneeLabels = m.labels;
    }

    // 3. Pre-check the rate's sub-group (invoices) — the outer gate is work_structure.
    if (args.rate !== undefined && !canWrite(ctx.policy, "invoices")) {
      return {
        kind: "clarify",
        message:
          "I can't set the task rate because write access to invoices is disabled in your assistant permissions. Enable it (or drop the rate) and try again.",
      };
    }

    const rate = args.rate !== undefined ? { amountMinor: toMinor(args.rate, unit), kind: args.rateKind } : undefined;
    const projectName = project.name ?? args.projectName;
    const expectedChanges: string[] = [`Create task "${args.name}" in project "${projectName ?? project.id}"`];
    for (const label of assigneeLabels) expectedChanges.push(label === "you" ? "Assign you" : `Assign "${label}"`);
    if (rate) expectedChanges.push(`Set the task ${rate.kind} rate to $${(rate.amountMinor / 100).toFixed(2)}`);

    const payload: SetupTaskPayload = {
      projectId: project.id,
      ...(projectName ? { projectName } : {}),
      name: args.name,
      assigneeIds,
      ...(rate ? { rate } : {}),
    };

    return {
      kind: "preview",
      preview: {
        actionLabel: "Set up task",
        featureGroup: "work_structure",
        riskLabels: ["high_risk_write", "billing"],
        targets: [{ type: "project", id: project.id, ...(projectName ? { name: projectName } : {}) }],
        expectedChanges,
        reversibility: "Undo removes the created task (and its rate) from the project.",
        warnings: ["This creates a task, sets its assignees, and sets a billable rate."],
      },
      operation: {
        actionName: "clockify_setup_task",
        featureGroup: "work_structure",
        risks: ["high_risk_write", "billing"],
        payload: payload as unknown as Record<string, unknown>,
      },
    };
  },
  async commit(ctx, operation) {
    const parsed = setupTaskPayloadSchema.safeParse(operation.payload);
    if (!parsed.success) {
      return errorReceipt({
        action: operation.actionName,
        code: "invalid_payload",
        message:
          "The saved task-setup details no longer match the expected shape — nothing was changed. Please re-issue the request.",
      });
    }
    const p = parsed.data;
    const rate = p.rate;
    const ids: { taskId?: string } = {};
    const steps: CompositionStep[] = [];

    steps.push({
      label: "task",
      required: true,
      run: async () => {
        const created = await ctx.clockify.createTask({
          projectId: p.projectId,
          name: p.name,
          ...(p.assigneeIds.length ? { assigneeIds: p.assigneeIds } : {}),
        });
        ids.taskId = created.id;
        // The created task rides in changed.created WITH its projectId so the
        // post-commit one-click undo can delete it; the in-step rollback
        // compensator uses the same typed deleteTask directly.
        return {
          kind: "done",
          created: [{ type: "task", id: created.id, name: created.name, projectId: p.projectId }],
          undo: async () => {
            await ctx.clockify.deleteTask(p.projectId, created.id);
          },
        };
      },
    });

    if (rate) {
      steps.push({
        label: "rate",
        required: true,
        run: async () => {
          if (!canWrite(ctx.policy, "invoices")) throw new Error("write access to invoices is disabled");
          await ctx.clockify.updateTaskRate({
            projectId: p.projectId,
            taskId: ids.taskId as string,
            rateKind: rate.kind === "cost" ? "COST" : "HOURLY",
            amountMinor: rate.amountMinor,
          });
          return { kind: "done" };
        },
      });
    }

    const outcome = await runComposition(steps);
    if (outcome.status.kind === "failed") {
      return errorReceipt({
        action: "clockify_setup_task",
        code: "setup_failed",
        message: `Couldn't finish setting up task "${p.name}": the ${outcome.status.label} step failed (${outcome.status.message}). ${leftBehindNote(outcome.status.rollbackWarnings)}`,
        recovery: { hint: "Adjust the request and try again.", retryable: true },
      });
    }
    if (outcome.status.kind === "stopped") {
      return errorReceipt({
        action: "clockify_setup_task",
        code: "setup_incomplete",
        message: `Setting up task "${p.name}" stopped before completing.`,
        recovery: { hint: "Try again.", retryable: true },
      });
    }
    return successReceipt({
      action: "clockify_setup_task",
      entity: "task",
      ids: { workspaceId: ctx.workspaceId, projectId: p.projectId },
      // The created task carries its projectId in changed.created, so the standard
      // one-click undo (reverseCreation → project-scoped deleteTask) removes it.
      changed: { created: outcome.created },
      warnings: outcome.warnings.length ? outcome.warnings : undefined,
    });
  },
  idempotencyKey(operation: ConfirmableOperation) {
    // A drifted payload must not throw here (this runs BEFORE commit, to claim the
    // dedup key); a stable raw key keeps dedup deterministic, and commit then surfaces
    // the honest invalid_payload receipt.
    const parsed = setupTaskPayloadSchema.safeParse(operation.payload);
    if (!parsed.success) return JSON.stringify(operation.payload);
    const p = parsed.data;
    return JSON.stringify({
      projectId: p.projectId,
      name: p.name,
      assigneeIds: [...p.assigneeIds].sort(),
      rate: p.rate ?? null,
    });
  },
});

export const SETUP_TASK_ACTIONS: ActionDefinition[] = [setupTask];
