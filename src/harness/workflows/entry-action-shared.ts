import { z } from "zod";
import { zNumberLike, zStringList } from "../arg-shapes.js";
import type { ActionContext, ClarifyOption, SemanticLiteralAlias } from "../action.js";
import { nowDate, nowIso } from "../../durations.js";
import { TIME_ENTRY_TAG_BATCH_MAX } from "../safety-limits.js";
import { commitSingleDurableRiskyStep } from "../durable-risky-write.js";
import {
  resolveInstant,
  resolveProjectTaskRefs,
  resolveRelativeDay,
  resolveTagRefs,
  zonedDayTimeInstant,
} from "./resolve.js";
import {
  captureStructureSnapshot,
  dispatchWithReconciliation,
  fetchStructureSnapshot,
  mutationPlan,
  reconcileCreate,
  requireFreshSnapshots,
  snapshot,
} from "./structure-durable.js";
import { successReceipt } from "../receipts.js";

export const TIME_ENTRY_BILLABLE_LITERAL_ALIASES = Object.freeze([
  { path: "billable", value: false, authoredPhrases: Object.freeze(["non-billable", "nonbillable", "non billable", "not billable"]) },
  { path: "billable", value: true, authoredPhrases: Object.freeze(["billable"]) },
] satisfies readonly SemanticLiteralAlias[]);

const boundedTagIds = zStringList(z.array(z.string()).max(TIME_ENTRY_TAG_BATCH_MAX)).optional();

const entriesCreateFields = z.object({
  description: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  date: z.string().optional(),
  dayOffset: zNumberLike(z.number().int()).optional(),
  durationMinutes: zNumberLike(z.number().positive().max(168 * 60)).optional(),
  durationHours: zNumberLike(z.number().positive().max(168)).optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  taskId: z.string().optional(),
  taskName: z.string().optional(),
  tagIds: boundedTagIds,
  billable: z.boolean().optional(),
}).strict();

function refineEntriesCreateShape(args: z.infer<typeof entriesCreateFields>, ctx: z.RefinementCtx): void {
  const durationCount = Number(args.durationMinutes !== undefined) + Number(args.durationHours !== undefined);
  const dateCount = Number(args.date !== undefined) + Number(args.dayOffset !== undefined);
  const startEnd = args.start !== undefined && args.end !== undefined && durationCount === 0 && dateCount === 0;
  const startDuration = args.start !== undefined && args.end === undefined && durationCount === 1 && dateCount === 0;
  const dateDuration = args.start === undefined && args.end === undefined && durationCount === 1 && dateCount === 1;
  if (!startEnd && !startDuration && !dateDuration) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Use exactly start+end, start+one duration, or date/dayOffset+one duration.",
    });
  }
}

export const entriesCreateSchema = entriesCreateFields.superRefine(refineEntriesCreateShape);

export const entriesCreateGenericSchema = entriesCreateFields.extend({
  tagNames: zStringList(z.array(z.string())).optional(),
}).strict().superRefine(refineEntriesCreateShape);

export const entriesStartSchema = z.object({
  description: z.string().optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  taskId: z.string().optional(),
  taskName: z.string().optional(),
  tagIds: boundedTagIds,
  billable: z.boolean().optional(),
}).strict();

export const entriesStartGenericSchema = entriesStartSchema.extend({
  tagNames: zStringList(z.array(z.string())).optional(),
});

export const DATE_CLARIFY = (raw: string) =>
  `I couldn't make sense of the date "${raw}" — give me a calendar date (YYYY-MM-DD) or something like today, yesterday, or last monday.`;

export function resolveDay(ctx: ActionContext, args: { date?: string; dayOffset?: number }): string | undefined {
  return resolveRelativeDay(nowDate(ctx), args, ctx.timeZone);
}

export async function resolveEntryTagsUnbounded(
  ctx: ActionContext,
  args: { tagIds?: string[]; tagNames?: string[] },
): Promise<{ ok: true; tagIds: string[] | undefined } | { ok: false; message: string; options?: ClarifyOption[] }> {
  const refs = [...(args.tagIds ?? []), ...(args.tagNames ?? [])];
  if (refs.length === 0) return { ok: true, tagIds: undefined };
  const tags = await resolveTagRefs(refs, { verb: "tag the entry with", listTags: () => ctx.clockify.listTags() });
  if (!tags.ok) return { ok: false, message: tags.clarify.clarify, options: tags.clarify.options };
  return { ok: true, tagIds: tags.tagIds };
}

async function resolveBoundedEntryTags(
  ctx: ActionContext,
  tagIds: string[] | undefined,
): Promise<{ ok: true; tagIds: string[] | undefined } | { ok: false; message: string; options?: ClarifyOption[] }> {
  if (!tagIds?.length) return { ok: true, tagIds: undefined };
  const tags = await resolveTagRefs(tagIds, { verb: "tag the entry with", listTags: () => ctx.clockify.listTags() });
  if (!tags.ok) return { ok: false, message: tags.clarify.clarify, options: tags.clarify.options };
  return { ok: true, tagIds: tags.tagIds };
}

export function resolveLogTimes(
  ctx: ActionContext,
  args: {
    start?: string;
    end?: string;
    date?: string;
    dayOffset?: number;
    durationMinutes?: number;
    durationHours?: number;
  },
): { kind: "ok"; start: string; end?: string } | { kind: "clarify"; message: string } {
  const durationMinutes =
    args.durationMinutes ?? (args.durationHours !== undefined ? args.durationHours * 60 : undefined);
  const addMinutes = (iso: string, minutes: number): string =>
    new Date(Date.parse(iso) + minutes * 60_000).toISOString();

  let start: string;
  let end: string | undefined;
  if (args.start) {
    if (!args.start.includes("T")) {
      return { kind: "clarify", message: "The start must be a full ISO datetime with a Z or numeric offset." };
    }
    const parsedStart = resolveInstant(nowDate(ctx), args.start, "start", ctx.timeZone);
    if (parsedStart === undefined) {
      return { kind: "clarify", message: "The start must be a full ISO datetime with a Z or numeric offset." };
    }
    start = parsedStart;
    if (args.end !== undefined) {
      if (!args.end.includes("T")) {
        return { kind: "clarify", message: "The end must be a full ISO datetime with a Z or numeric offset." };
      }
      end = resolveInstant(nowDate(ctx), args.end, "end", ctx.timeZone);
      if (end === undefined) {
        return { kind: "clarify", message: "The end must be a full ISO datetime with a Z or numeric offset." };
      }
    } else {
      end = durationMinutes !== undefined ? addMinutes(start, durationMinutes) : undefined;
    }
  } else {
    if (durationMinutes === undefined) {
      return {
        kind: "clarify",
        message: "How long was it (e.g. 2 hours), or what start and end times should I use?",
      };
    }
    if (!ctx.timeZone) {
      return {
        kind: "clarify",
        message: "I couldn't verify your Clockify timezone, so I won't guess which instant 09:00 means. Refresh the add-on and try again.",
      };
    }
    const day = resolveDay(ctx, args);
    if (day === undefined) return { kind: "clarify", message: DATE_CLARIFY(args.date as string) };
    const localStart = zonedDayTimeInstant(day, 9, 0, ctx.timeZone);
    if (localStart === undefined) return { kind: "clarify", message: DATE_CLARIFY(args.date as string) };
    start = localStart;
    end = args.end ?? addMinutes(start, durationMinutes);
  }
  if (end !== undefined && Date.parse(end) <= Date.parse(start)) {
    return {
      kind: "clarify",
      message:
        "The end time is at or before the start, which would be a negative-length entry. For an overnight entry, give the end as the next day (a full date/time); otherwise double-check the start and end.",
    };
  }
  return { kind: "ok", start, end };
}

export async function resolveEntryProjectTask(
  ctx: ActionContext,
  args: { projectId?: string; projectName?: string; taskId?: string; taskName?: string },
  verb: string,
) {
  return resolveProjectTaskRefs(args, {
    verb,
    listProjects: (f) => ctx.clockify.listProjects(f),
    listTasks: (projectId) => ctx.clockify.listTasks(projectId),
    projectNotFoundHint: "Or should I create it first?",
  });
}

export async function captureEntryParentSnapshots(
  ctx: ActionContext,
  refs: { projectId?: string; taskId?: string },
) {
  const targetSnapshots: ReturnType<typeof snapshot>[] = [];
  if (refs.projectId) {
    const project = await ctx.clockify.getProject(refs.projectId);
    if (!project) return { ok: false as const, clarify: "The selected project no longer exists. Refresh and try again." };
    targetSnapshots.push(await captureStructureSnapshot(ctx, "parent", "project", project));
  }
  if (refs.taskId && refs.projectId) {
    const task = await ctx.clockify.getTask(refs.projectId, refs.taskId);
    if (!task) return { ok: false as const, clarify: "The selected task no longer exists. Refresh and try again." };
    targetSnapshots.push(await captureStructureSnapshot(ctx, "parent", "task", task, { projectId: refs.projectId }));
  }
  return { ok: true as const, targetSnapshots };
}

export async function prepareEntriesCreate(
  ctx: ActionContext,
  args: z.infer<typeof entriesCreateSchema>,
  options?: { planStepId?: string },
) {
  const times = resolveLogTimes(ctx, args);
  if (times.kind === "clarify") return { kind: "clarify" as const, clarify: times.message };
  const refs = await resolveEntryProjectTask(ctx, args, "log against");
  if (!refs.ok) return { kind: "clarify" as const, clarify: refs.clarify.clarify, options: refs.clarify.options };
  const tags = await resolveBoundedEntryTags(ctx, args.tagIds);
  if (!tags.ok) return { kind: "clarify" as const, clarify: tags.message, options: tags.options };
  const parents = await captureEntryParentSnapshots(ctx, refs);
  if (!parents.ok) return { kind: "clarify" as const, clarify: parents.clarify };
  const body = {
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(refs.projectId !== undefined ? { projectId: refs.projectId } : {}),
    ...(refs.taskId !== undefined ? { taskId: refs.taskId } : {}),
    ...(tags.tagIds !== undefined ? { tagIds: tags.tagIds } : {}),
    ...(args.billable !== undefined ? { billable: args.billable } : {}),
    start: times.start,
    ...(times.end !== undefined ? { end: times.end } : {}),
  };
  return {
    operation: { body, targetSnapshots: parents.targetSnapshots },
    mutationPlan: mutationPlan([{
      id: options?.planStepId ?? "create-time-entry",
      strategy: "create",
      fingerprint: parents.targetSnapshots.map((item) => item.fingerprint).join(":") || undefined,
    }]),
  };
}

export async function prepareEntriesStart(
  ctx: ActionContext,
  args: z.infer<typeof entriesStartSchema>,
  options?: { planStepId?: string },
) {
  const refs = await resolveEntryProjectTask(ctx, args, "start the timer on");
  if (!refs.ok) return { kind: "clarify" as const, clarify: refs.clarify.clarify, options: refs.clarify.options };
  const tags = await resolveBoundedEntryTags(ctx, args.tagIds);
  if (!tags.ok) return { kind: "clarify" as const, clarify: tags.message, options: tags.options };
  const parents = await captureEntryParentSnapshots(ctx, refs);
  if (!parents.ok) return { kind: "clarify" as const, clarify: parents.clarify };
  const body = {
    userId: ctx.adminUserId,
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(refs.projectId !== undefined ? { projectId: refs.projectId } : {}),
    ...(refs.taskId !== undefined ? { taskId: refs.taskId } : {}),
    ...(tags.tagIds !== undefined ? { tagIds: tags.tagIds } : {}),
    ...(args.billable !== undefined ? { billable: args.billable } : {}),
    start: nowIso(ctx),
  };
  return {
    operation: { body, targetSnapshots: parents.targetSnapshots },
    mutationPlan: mutationPlan([{
      id: options?.planStepId ?? "start-time-entry",
      strategy: "create",
      fingerprint: parents.targetSnapshots.map((item) => item.fingerprint).join(":") || undefined,
    }]),
  };
}

export async function prepareEntriesCreateDispatch(
  ctx: ActionContext,
  operation: unknown,
) {
  const { body, targetSnapshots } = operation as {
    body: Parameters<typeof ctx.clockify.createTimeEntryAtomic>[0];
    targetSnapshots: ReturnType<typeof snapshot>[];
  };
  if (targetSnapshots.length) await requireFreshSnapshots(ctx, targetSnapshots);
  const baseline = await ctx.clockify.getEntries({
    userId: ctx.adminUserId,
    start: body.start,
    end: new Date(Date.parse(body.start) + 1).toISOString(),
  });
  if (baseline.truncated) throw new Error("create_baseline_incomplete");
  return {
    preparedDetail: { preDispatch: { strategy: "time_entry_create_baseline", ids: baseline.rows.map((row) => row.id), truncated: false } },
    state: { beforeIds: baseline.rows.map((row) => row.id) },
  };
}

export async function dispatchEntriesCreate(
  ctx: ActionContext,
  operation: unknown,
  state: { beforeIds: string[] },
  actionName: "clockify_entries_create" | "clockify_log_work",
) {
  const { body } = operation as { body: Parameters<typeof ctx.clockify.createTimeEntryAtomic>[0] };
  const result = await dispatchWithReconciliation({
    dispatch: () => ctx.clockify.createTimeEntryAtomic(body),
    reconcile: async () => reconcileCreate({
      beforeIds: state.beforeIds,
      list: () => ctx.clockify.getEntries({
        userId: ctx.adminUserId,
        start: body.start,
        end: new Date(Date.parse(body.start) + 1).toISOString(),
      }),
      matches: (row) => row.start === body.start && row.end === (body.end ?? null) && row.description === body.description &&
        row.projectId === body.projectId && row.taskId === body.taskId &&
        JSON.stringify(row.tagIds ?? []) === JSON.stringify(body.tagIds ?? []) && row.billable === body.billable,
    }),
  });
  const entry = result.value;
  const created = { type: "time_entry", id: entry.id, name: entry.description };
  return {
    result: successReceipt({
      action: actionName,
      entity: "time_entry",
      ids: { workspaceId: ctx.workspaceId },
      changed: { created: [created] },
    }),
    externalId: entry.id,
    effect: { created },
    detail: { reconciled: result.reconciled, baselineComplete: true },
  };
}

export async function dispatchEntriesStart(
  ctx: ActionContext,
  operation: unknown,
  actionName: "clockify_entries_start" | "clockify_start_timer",
) {
  const { body, targetSnapshots } = operation as {
    body: Parameters<typeof ctx.clockify.startTimeEntryAtomic>[0];
    targetSnapshots: ReturnType<typeof snapshot>[];
  };
  if (targetSnapshots.length) await requireFreshSnapshots(ctx, targetSnapshots);
  const result = await dispatchWithReconciliation({
    dispatch: () => ctx.clockify.startTimeEntryAtomic(body),
    reconcile: async () => {
      const row = await ctx.clockify.getRunningTimeEntry(body.userId);
      if (!row) return undefined;
      const matches = row.start === body.start && row.description === body.description && row.projectId === body.projectId &&
        row.taskId === body.taskId && JSON.stringify(row.tagIds ?? []) === JSON.stringify(body.tagIds ?? []) &&
        row.billable === body.billable;
      return matches ? row : undefined;
    },
  });
  const entry = result.value;
  const created = { type: "time_entry", id: entry.id, name: entry.description };
  return {
    result: successReceipt({
      action: actionName,
      entity: "time_entry",
      ids: { workspaceId: ctx.workspaceId },
      changed: { created: [created] },
    }),
    externalId: entry.id,
    effect: { created },
    detail: { reconciled: result.reconciled },
  };
}

const entriesUpdateFields = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  taskId: z.string().optional(),
  taskName: z.string().optional(),
  tagIds: boundedTagIds,
  billable: z.boolean().optional(),
}).strict();

function refineEntriesUpdateShape(
  args: z.infer<typeof entriesUpdateFields> & { tagNames?: string[] },
  ctx: z.RefinementCtx,
): void {
  if (
    args.description === undefined &&
    args.projectId === undefined &&
    args.projectName === undefined &&
    args.taskId === undefined &&
    args.taskName === undefined &&
    args.tagIds === undefined &&
    args.tagNames === undefined &&
    args.billable === undefined
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide at least one field to change." });
  }
}

export const entriesUpdateSchema = entriesUpdateFields.superRefine(refineEntriesUpdateShape);

export const entriesUpdateGenericSchema = entriesUpdateFields.extend({
  tagNames: zStringList(z.array(z.string())).optional(),
}).strict().superRefine(refineEntriesUpdateShape);

type EntriesUpdateArgs = z.infer<typeof entriesUpdateSchema>;
type EntriesUpdateGenericArgs = z.infer<typeof entriesUpdateGenericSchema>;

async function resolveUpdateTags(
  ctx: ActionContext,
  args: EntriesUpdateGenericArgs,
  bounded: boolean,
) {
  return bounded
    ? resolveBoundedEntryTags(ctx, args.tagIds)
    : resolveEntryTagsUnbounded(ctx, args);
}

export async function previewEntriesUpdate(
  ctx: ActionContext,
  args: EntriesUpdateGenericArgs,
  options?: { boundedTags?: boolean },
) {
  const current = await ctx.clockify.getEntry(args.id);
  if (!current) return { clarify: "The requested time entry does not exist. Provide a current entry id." };
  const refs = await resolveEntryProjectTask(ctx, args, "move the entry to");
  if (!refs.ok) return refs.clarify;
  const tags = await resolveUpdateTags(ctx, args, options?.boundedTags ?? true);
  if (!tags.ok) return { clarify: tags.message, options: tags.options };

  const expectedChanges: string[] = [];
  if (args.description !== undefined) expectedChanges.push(`Description → "${args.description}"`);
  if (refs.projectId !== undefined) expectedChanges.push(`Project → ${refs.projectName ?? refs.projectId}`);
  if (refs.taskId !== undefined) expectedChanges.push(`Task → ${refs.taskName ?? refs.taskId}`);
  if (tags.tagIds !== undefined) expectedChanges.push(`Tags → ${tags.tagIds.length} tag(s)`);
  if (args.billable !== undefined) expectedChanges.push(`Billable → ${args.billable ? "billable" : "non-billable"}`);

  const targetSnapshots = [await captureStructureSnapshot(ctx, "target", "time_entry", current)];
  if (refs.projectId) {
    const parent = await ctx.clockify.getProject(refs.projectId);
    if (!parent) return { clarify: "The selected project no longer exists. Refresh and try again." };
    targetSnapshots.push(await captureStructureSnapshot(ctx, "parent", "project", parent));
  }
  if (refs.taskId && refs.projectId) {
    const parent = await ctx.clockify.getTask(refs.projectId, refs.taskId);
    if (!parent) return { clarify: "The selected task no longer exists. Refresh and try again." };
    targetSnapshots.push(await captureStructureSnapshot(ctx, "parent", "task", parent, { projectId: refs.projectId }));
  }
  const normalized = {
    id: args.id,
    description: args.description,
    projectId: refs.projectId,
    taskId: refs.taskId,
    tagIds: tags.tagIds,
    billable: args.billable,
  };
  const body = await ctx.clockify.prepareTimeEntryUpdate(normalized);
  return {
    actionLabel: "Update time entry",
    targets: [{ type: "time_entry", id: args.id }],
    expectedChanges,
    reversibility: "Editing replaces these fields on the existing entry; there is no automatic undo — re-edit to change them back.",
    warnings: ["Updating a time entry changes live workspace data and can affect billing and reports."],
    payload: { ...normalized, body },
    targetSnapshots,
    mutationPlan: mutationPlan([{ id: "update-time-entry", strategy: "update", fingerprint: targetSnapshots[0]!.fingerprint }]),
  };
}

export async function commitEntriesUpdate(
  ctx: ActionContext,
  payload: unknown,
  operation: Parameters<typeof commitSingleDurableRiskyStep>[0]["operation"],
  actionName: "clockify_entries_update" | "clockify_fix_entry",
) {
  const p = payload as EntriesUpdateArgs & { body: Record<string, unknown> };
  let entry: Awaited<ReturnType<typeof ctx.clockify.getEntry>>;
  return commitSingleDurableRiskyStep({
    ctx,
    operation,
    planStepId: "update-time-entry",
    name: "Update time entry",
    verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (stored) => fetchStructureSnapshot(ctx, stored) },
    dispatch: async () => {
      const result = await dispatchWithReconciliation({
        dispatch: () => ctx.clockify.updateTimeEntryAtomic(p.id, p.body),
        reconcile: async () => {
          const row = await ctx.clockify.getEntry(p.id);
          if (!row) return undefined;
          const expected = { description: p.description, projectId: p.projectId, taskId: p.taskId, tagIds: p.tagIds, billable: p.billable };
          return Object.entries(expected).every(([key, value]) =>
            value === undefined || JSON.stringify((row as unknown as Record<string, unknown>)[key]) === JSON.stringify(value)) ? row : undefined;
        },
      });
      entry = result.value;
      return { externalId: result.value.id, effect: { updated: { type: "time_entry", id: p.id } }, detail: { reconciled: result.reconciled } };
    },
    success: () => successReceipt({
      action: actionName,
      entity: "time_entry",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "time_entry", id: p.id, name: entry?.description }] },
    }),
  });
}
