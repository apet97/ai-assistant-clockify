import { z } from "zod";
import { zNumberLike } from "../arg-shapes.js";
import type { ActionContext, CommitResult, ConfirmableOperation, RiskyClarifyResult, RiskyPreviewResult } from "../action.js";
import { successReceipt } from "../receipts.js";
import { toMinor } from "../money.js";
import { resolveEntityRef, resolveUserRef } from "./resolve.js";
import { buildRatePreview } from "./rate.js";
import { commitSingleDurableRiskyStep } from "../durable-risky-write.js";
import {
  captureStructureSnapshot,
  dispatchWithReconciliation,
  fetchStructureSnapshot,
  mutationPlan,
  reconcileDelete,
  requireFreshSnapshots,
} from "./structure-durable.js";
import { projectMembershipsEquivalent } from "./membership-canonical.js";
import { GROUP_MEMBER_BATCH_MAX } from "../safety-limits.js";

const membershipRateSchema = z.object({
  amount: z.number().int().nonnegative(),
  since: z.string().optional(),
});

export const projectMembershipRowSchema = z.object({
  userId: z.string().min(1),
  membershipStatus: z.enum(["PENDING", "ACTIVE", "DECLINED", "INACTIVE"]).optional(),
  membershipType: z.enum(["WORKSPACE", "PROJECT", "USERGROUP"]).optional(),
  hourlyRate: membershipRateSchema.optional(),
  costRate: membershipRateSchema.optional(),
});

function membershipRequestRate(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid_membership_rate");
  const rate = value as Record<string, unknown>;
  if (!Number.isSafeInteger(rate.amount) || (rate.amount as number) < 0 || (rate.amount as number) > 2_147_483_647) {
    throw new TypeError("invalid_membership_rate_amount");
  }
  if (rate.since !== undefined && (
    typeof rate.since !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(rate.since)
    || Number.isNaN(Date.parse(rate.since))
  )) throw new TypeError("invalid_membership_rate_since");
  return { amount: rate.amount, ...(typeof rate.since === "string" ? { since: rate.since } : {}) };
}

export function membershipRequestRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const statuses = new Set(["PENDING", "ACTIVE", "DECLINED", "INACTIVE"]);
  const types = new Set(["WORKSPACE", "PROJECT", "USERGROUP"]);
  const normalized = rows.map((row) => {
    if (typeof row.userId !== "string" || row.userId.length === 0) throw new TypeError("invalid_membership_user_id");
    const hourlyRate = membershipRequestRate(row.hourlyRate);
    const costRate = membershipRequestRate(row.costRate);
    if (row.membershipStatus !== undefined &&
        (typeof row.membershipStatus !== "string" || !statuses.has(row.membershipStatus))) {
      throw new TypeError("invalid_membership_status");
    }
    if (row.membershipType !== undefined &&
        (typeof row.membershipType !== "string" || !types.has(row.membershipType))) {
      throw new TypeError("invalid_membership_type");
    }
    return {
      userId: row.userId,
      ...(typeof row.membershipStatus === "string" ? { membershipStatus: row.membershipStatus } : {}),
      ...(typeof row.membershipType === "string" ? { membershipType: row.membershipType } : {}),
      ...(hourlyRate ? { hourlyRate } : {}),
      ...(costRate ? { costRate } : {}),
    };
  }).sort((left, right) => String(left.userId).localeCompare(String(right.userId)));
  if (new Set(normalized.map((row) => row.userId)).size !== normalized.length) {
    throw new TypeError("duplicate_membership_user_id");
  }
  return normalized;
}

export function membershipRequestRowsFromTyped(rows: Array<z.infer<typeof projectMembershipRowSchema>>): Array<Record<string, unknown>> {
  return membershipRequestRows(rows.map((row) => ({
    userId: row.userId,
    ...(row.membershipStatus !== undefined ? { membershipStatus: row.membershipStatus } : {}),
    ...(row.membershipType !== undefined ? { membershipType: row.membershipType } : {}),
    ...(row.hourlyRate ? { hourlyRate: row.hourlyRate } : {}),
    ...(row.costRate ? { costRate: row.costRate } : {}),
  })));
}

export const projectMemberRateSchema = z
  .object({
    projectId: z.string().min(1).optional(),
    projectName: z.string().min(1).optional(),
    userId: z.string().min(1).optional(),
    userName: z.string().min(1).optional(),
    amount: zNumberLike(z.number().nonnegative()),
    amountUnit: z.enum(["major", "minor"]).default("major"),
    since: z.string().optional(),
  })
  .refine((v) => v.projectId !== undefined || v.projectName !== undefined, { message: "Provide the project id or its exact name." })
  .refine((v) => v.userId !== undefined || v.userName !== undefined, { message: "Provide the member (id or exact name, or 'me')." });

function isRateSelfAlias(args: { userId?: string; userName?: string }): boolean {
  return args.userId === "my" || args.userId === "myself" ||
    (args.userId === undefined && (args.userName === "me" || args.userName === "my" || args.userName === "myself"));
}

export async function previewProjectMemberRate(
  ctx: ActionContext,
  args: z.infer<typeof projectMemberRateSchema> & { rateKind?: "HOURLY" | "COST" },
  options: {
    rateKind: "HOURLY" | "COST";
    planStepId: string;
    includeRateKindInPayload?: boolean;
  },
): Promise<RiskyPreviewResult | RiskyClarifyResult> {
  const project = await resolveEntityRef(
    { id: args.projectId, name: args.projectName },
    { noun: "project", verb: "set a rate on", list: () => ctx.clockify.listProjects() },
  );
  if (!project.ok) return project.clarify;
  const member = await resolveUserRef(
    isRateSelfAlias(args) ? { id: "me" } : { id: args.userId, name: args.userName },
    { verb: "set a rate for", adminUserId: ctx.adminUserId, listUsers: () => ctx.clockify.listUsers() },
  );
  if (!member.ok) return member.clarify;
  const userId = member.userId;
  const memberLabel = member.label;
  const memberships = await ctx.clockify.getProjectMemberships(project.id);
  if (!memberships.rows.some((m) => String(m.userId) === userId)) {
    if (memberships.truncated) {
      return {
        clarify: `Clockify returned an incomplete membership list for "${project.name ?? project.id}", so I can't verify whether ${memberLabel} is already a member. Narrow the membership filter and try again.`,
      };
    }
    const you = memberLabel === "you";
    return {
      clarify: `${you ? "You aren't" : `${memberLabel} isn't`} a member of "${project.name ?? project.id}" yet — Clockify only sets a rate for project members. Add ${you ? "yourself" : "them"} to the project first ("add ${you ? "me" : memberLabel} to ${project.name ?? project.id}"), then set the rate.`,
    };
  }
  const amountMinor = toMinor(args.amount, args.amountUnit);
  const current = await ctx.clockify.getProject(project.id);
  if (!current) return { clarify: "The requested project no longer exists. Refresh and try again." };
  const targetSnapshot = await captureStructureSnapshot(ctx, "target", "project", current);
  return {
    ...buildRatePreview({
      targetType: "project",
      targetId: project.id,
      scopeLabel: `for ${memberLabel} on "${project.name ?? project.id}"`,
      amountMinor,
      rateKind: options.rateKind,
      kindNoun: "project",
    }),
    payload: {
      projectId: project.id,
      userId,
      ...(options.includeRateKindInPayload ? { rateKind: options.rateKind } : {}),
      amountMinor,
      ...(args.since !== undefined ? { since: args.since } : {}),
    },
    targetSnapshots: [targetSnapshot],
    mutationPlan: mutationPlan([{ id: options.planStepId, strategy: "update", fingerprint: targetSnapshot.fingerprint }]),
  };
}

export async function commitProjectMemberRateStep(
  ctx: ActionContext,
  operation: ConfirmableOperation,
  rateInput: { projectId: string; userId: string; amountMinor: number; since?: string; rateKind?: "HOURLY" | "COST" },
  options: {
    planStepId: string;
    stepName: string;
    actionName: string;
    dispatch: (input: typeof rateInput) => Promise<void>;
    reconcileRateKey: "hourlyRate" | "costRate" | "dynamic";
  },
): Promise<CommitResult> {
  return commitSingleDurableRiskyStep({
    ctx, operation, planStepId: options.planStepId, name: options.stepName,
    verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (stored) => fetchStructureSnapshot(ctx, stored) },
    dispatch: async () => {
      const result = await dispatchWithReconciliation({
        dispatch: async () => { await options.dispatch(rateInput); return true as const; },
        reconcile: async () => {
          const row = await ctx.clockify.getProject(rateInput.projectId) as unknown as Record<string, unknown> | null;
          const key = options.reconcileRateKey === "dynamic"
            ? (rateInput.rateKind === "COST" ? "costRate" : "hourlyRate")
            : options.reconcileRateKey;
          return row && (row[key] as { amount?: unknown } | undefined)?.amount === rateInput.amountMinor
            ? true as const
            : undefined;
        },
      });
      return {
        effect: {
          updatedRate: {
            projectId: rateInput.projectId,
            userId: rateInput.userId,
            ...(rateInput.rateKind ? { rateKind: rateInput.rateKind } : {}),
          },
        },
        detail: { reconciled: result.reconciled },
      };
    },
    success: () => successReceipt({
      action: options.actionName,
      entity: "project",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "project", id: rateInput.projectId }] },
    }),
  });
}

export async function previewDeleteArchivedProject(
  ctx: ActionContext,
  args: { id?: string; name?: string },
): Promise<RiskyPreviewResult | RiskyClarifyResult> {
  const resolved = await resolveEntityRef(args, {
    noun: "project",
    verb: "delete",
    list: (filter) => ctx.clockify.listProjects(filter),
    includeArchived: true,
    verifyId: true,
  });
  if (!resolved.ok) return resolved.clarify;
  const name = resolved.name ?? args.name;
  const current = await ctx.clockify.getProject(resolved.id);
  if (!current) return { clarify: "The requested project no longer exists. Refresh and try again." };
  if (current.archived !== true) {
    return {
      clarify: `Project "${name ?? resolved.id}" is still active — archive it first, or use clockify_projects_delete to archive and delete in one confirmation.`,
    };
  }
  const targetSnapshot = await captureStructureSnapshot(ctx, "target", "project", current);
  return {
    actionLabel: "Delete archived project",
    targets: [{ type: "project", id: resolved.id, name }],
    expectedChanges: [`Delete archived project ${name ?? resolved.id} (and its tasks)`],
    reversibility: "This cannot be undone.",
    warnings: ["Deleting a project is permanent and removes its tasks."],
    payload: { id: resolved.id, name },
    targetSnapshots: [targetSnapshot],
    mutationPlan: mutationPlan([{ id: "delete-archived-project", strategy: "delete", fingerprint: targetSnapshot.fingerprint }]),
  };
}

export async function commitDeleteArchivedProject(
  ctx: ActionContext,
  payload: Record<string, unknown>,
  operation: ConfirmableOperation,
  actionName: string,
): Promise<CommitResult> {
  const { id, name } = payload as { id: string; name?: string };
  return commitSingleDurableRiskyStep({
    ctx, operation, planStepId: "delete-archived-project", name: "Delete archived project",
    verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (stored) => fetchStructureSnapshot(ctx, stored) },
    dispatch: async () => {
      await requireFreshSnapshots(ctx, operation.targetSnapshots ?? []);
      const beforeDelete = await ctx.clockify.getProject(id);
      if (!beforeDelete || beforeDelete.archived !== true) {
        throw new Error("stale_target");
      }
      const result = await dispatchWithReconciliation({
        dispatch: async () => { await ctx.clockify.deleteProjectAtomic(id); return true as const; },
        reconcile: () => reconcileDelete(() => ctx.clockify.getProject(id)),
      });
      return { effect: { deleted: { type: "project", id } }, detail: { reconciled: result.reconciled } };
    },
    success: () => successReceipt({
      action: actionName,
      entity: "project",
      ids: { workspaceId: ctx.workspaceId },
      changed: { deleted: [{ type: "project", id, name }] },
    }),
  });
}

export const projectMembershipReplaceSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    memberships: z.array(projectMembershipRowSchema).min(1).max(GROUP_MEMBER_BATCH_MAX),
  })
  .refine((v) => v.id !== undefined || v.name !== undefined, {
    message: "Provide the project id or its exact name.",
  });

export async function previewProjectMembershipReplace(
  ctx: ActionContext,
  args: z.infer<typeof projectMembershipReplaceSchema>,
): Promise<RiskyPreviewResult | RiskyClarifyResult> {
  const resolved = await resolveEntityRef(
    { id: args.id, name: args.name },
    { noun: "project", verb: "update", list: (filter) => ctx.clockify.listProjects(filter), verifyId: true },
  );
  if (!resolved.ok) return resolved.clarify;
  const memberships = membershipRequestRowsFromTyped(args.memberships);
  const currentProject = await ctx.clockify.getProject(resolved.id);
  if (!currentProject) return { clarify: "The requested project no longer exists. Refresh and try again." };
  const targetSnapshot = await captureStructureSnapshot(ctx, "target", "project", currentProject);
  return {
    actionLabel: "Replace project memberships",
    targets: [{ type: "project", id: resolved.id, name: resolved.name ?? args.name }],
    expectedChanges: [`Replace membership set (${memberships.length} member(s))`],
    reversibility: "You can update memberships again to restore prior access.",
    warnings: ["This changes who can access and track time on the project."],
    payload: { id: resolved.id, memberships },
    targetSnapshots: [targetSnapshot],
    mutationPlan: mutationPlan([{ id: "replace-project-memberships", strategy: "update", fingerprint: targetSnapshot.fingerprint }]),
  };
}

export async function commitProjectMembershipReplace(
  ctx: ActionContext,
  payload: Record<string, unknown>,
  operation: ConfirmableOperation,
  actionName: string,
): Promise<CommitResult> {
  const { id, memberships } = payload as { id: string; memberships: Array<Record<string, unknown>> };
  return commitSingleDurableRiskyStep({
    ctx, operation, planStepId: "replace-project-memberships", name: "Replace project memberships",
    verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (stored) => fetchStructureSnapshot(ctx, stored) },
    dispatch: async () => {
      const result = await dispatchWithReconciliation({
        dispatch: async () => { await ctx.clockify.updateProjectMembershipsAtomic(id, { memberships }); return true as const; },
        reconcile: async () => {
          const current = await ctx.clockify.getProjectMemberships(id);
          return !current.truncated && projectMembershipsEquivalent(memberships, current.rows)
            ? true as const
            : undefined;
        },
      });
      return { effect: { memberships: memberships.length, projectId: id }, detail: { reconciled: result.reconciled } };
    },
    success: () => successReceipt({
      action: actionName,
      entity: "project",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "project", id }] },
    }),
  });
}
