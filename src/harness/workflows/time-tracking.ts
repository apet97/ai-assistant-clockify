import { z } from "zod";
import { zNumberLike, zStringList } from "../arg-shapes.js";
import { defineAction, type ActionContext, type ActionDefinition, type ClarifyOption } from "../action.js";
import type { TimeEntrySummary } from "../../clockify/client.js";
import { successReceipt } from "../receipts.js";
import { resolveProjectTaskRefs, resolveRelativeDay, resolveTagRefs, resolveUserFilter } from "./resolve.js";
import { DAY_MS, SEVEN_DAYS_MS } from "../../durations.js";

/**
 * Time-tracking read + safe-write workflows (SPEC "Safe Writes"): status, start
 * timer, stop timer, log work, review day/week (reads), and fix entry (safe
 * write). All execute immediately when policy allows; none are risky. Ambiguous
 * project/task identity stops and asks the admin.
 */

function nowIso(ctx: ActionContext): string {
  return (ctx.now ?? (() => new Date()))().toISOString();
}

/**
 * Merge `tagIds` + `tagNames` and resolve every entry (id, short id, or NAME —
 * the planner puts names in either slot) to verified tag ids. No refs ⇒
 * undefined (start/log: no tags; fix_entry: leave tags unchanged).
 */
async function resolveEntryTags(
  ctx: ActionContext,
  args: { tagIds?: string[]; tagNames?: string[] },
): Promise<{ ok: true; tagIds: string[] | undefined } | { ok: false; message: string; options?: ClarifyOption[] }> {
  const refs = [...(args.tagIds ?? []), ...(args.tagNames ?? [])];
  if (refs.length === 0) return { ok: true, tagIds: undefined };
  const tags = await resolveTagRefs(refs, { verb: "tag the entry with", listTags: () => ctx.clockify.listTags() });
  if (!tags.ok) return { ok: false, message: tags.clarify.clarify, options: tags.clarify.options };
  return { ok: true, tagIds: tags.tagIds };
}

/** Sum the durations (minutes) of entries that have ended. */
function totalMinutes(entries: TimeEntrySummary[]): number {
  let ms = 0;
  for (const entry of entries) {
    if (entry.end && entry.start) ms += Date.parse(entry.end) - Date.parse(entry.start);
  }
  return Math.round(ms / 60000);
}

const status = defineAction({
  name: "clockify_status",
  description: "Show the admin's currently running timer (if any).",
  featureGroup: "time_tracking",
  risks: ["read"],
  schema: z.object({}).strip(),
  async handler(ctx) {
    const running = await ctx.clockify.getRunningTimeEntry(ctx.adminUserId);
    // Resolve the projectId to a human-readable name so the model has a name to
    // show. Without it the model leaks the opaque internal id to the admin
    // (getProject fetches by id regardless of archived state, unlike listProjects).
    let projectName: string | undefined;
    if (running?.projectId) {
      const project = await ctx.clockify.getProject(running.projectId);
      projectName = project?.name;
    }
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_status",
        entity: "time_entry",
        ids: { workspaceId: ctx.workspaceId },
        data: { running: running ? { ...running, projectName } : null },
      }),
    };
  },
});

const startTimer = defineAction({
  name: "clockify_start_timer",
  description:
    "Start a new timer for the admin on an EXISTING project. Pass the project by name with `projectName` (resolved to its id; an unknown name CLARIFIES, it is never created) — use clockify_create_work_package with startTimer:true only when the admin explicitly asks to CREATE a new project.",
  featureGroup: "time_tracking",
  risks: ["safe_write"],
  schema: z.object({
    description: z.string().optional(),
    projectId: z.string().optional(),
    projectName: z.string().optional(),
    taskId: z.string().optional(),
    taskName: z.string().optional(),
    tagIds: zStringList(z.array(z.string())).optional(),
    /** Tag names (or use tagIds) — resolved to verified ids server-side. */
    tagNames: zStringList(z.array(z.string())).optional(),
    billable: z.boolean().optional(),
  }),
  async handler(ctx, args) {
    // Resolve project/task by NAME (in either slot) at execution time. An
    // unknown name CLARIFIES (offering grounded options) — it is NEVER silently
    // created; creating a project is the job of clockify_create_work_package.
    const refs = await resolveProjectTaskRefs(args, {
      verb: "start the timer on",
      listProjects: (f) => ctx.clockify.listProjects(f),
      listTasks: (projectId) => ctx.clockify.listTasks(projectId),
      projectNotFoundHint: "Or should I create it first?",
    });
    if (!refs.ok) {
      return { kind: "clarify", message: refs.clarify.clarify, options: refs.clarify.options };
    }
    const tags = await resolveEntryTags(ctx, args);
    if (!tags.ok) return { kind: "clarify", message: tags.message, options: tags.options };

    const entry = await ctx.clockify.startTimeEntry({
      userId: ctx.adminUserId,
      description: args.description,
      projectId: refs.projectId,
      taskId: refs.taskId,
      tagIds: tags.tagIds,
      billable: args.billable,
      start: nowIso(ctx),
    });
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_start_timer",
        entity: "time_entry",
        ids: { workspaceId: ctx.workspaceId },
        changed: { created: [{ type: "time_entry", id: entry.id, name: entry.description }] },
      }),
    };
  },
});

const stopTimer = defineAction({
  name: "clockify_stop_timer",
  description: "Stop the admin's currently running timer.",
  featureGroup: "time_tracking",
  risks: ["safe_write"],
  schema: z.object({}).strip(),
  async handler(ctx) {
    const entry = await ctx.clockify.stopTimeEntry({
      userId: ctx.adminUserId,
      end: nowIso(ctx),
    });
    if (!entry) {
      return {
        kind: "receipt",
        receipt: successReceipt({
          action: "clockify_stop_timer",
          warnings: [{ message: "No running timer to stop." }],
        }),
      };
    }
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_stop_timer",
        entity: "time_entry",
        ids: { workspaceId: ctx.workspaceId },
        changed: { updated: [{ type: "time_entry", id: entry.id, name: entry.description }] },
      }),
    };
  },
});

/** Resolve the entry's day (YYYY-MM-DD) server-side — shared {@link resolveRelativeDay}.
 *  `undefined` = unparseable; callers clarify instead of sending it (live: review
 *  crashed with "Invalid time value" on `new Date("today")`). */
function resolveDay(ctx: ActionContext, args: { date?: string; dayOffset?: number }): string | undefined {
  return resolveRelativeDay((ctx.now ?? (() => new Date()))(), args);
}

const DATE_CLARIFY = (raw: string) =>
  `I couldn't make sense of the date "${raw}" — give me a calendar date (YYYY-MM-DD) or something like today, yesterday, or last monday.`;

/**
 * Resolve a completed-entry start/end from the shapes the planner naturally emits
 * ("log 2 hours on Apollo yesterday"). The model reliably gives a duration and a
 * relative day but is unsure of the clock time (and the absolute date), so it used
 * to dead-end on the required `start` and clarify instead of acting. The harness
 * owns this: given a `duration` (+ optional relative `date`/`dayOffset`) it anchors
 * a deterministic 09:00 start on the resolved day and computes the end. An explicit
 * `start` still wins. With neither a start nor a duration there is nothing to log,
 * so it asks one precise question.
 */
function resolveLogTimes(
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

  if (args.start) {
    const end = args.end ?? (durationMinutes !== undefined ? addMinutes(args.start, durationMinutes) : undefined);
    return { kind: "ok", start: args.start, end };
  }
  if (durationMinutes === undefined) {
    return {
      kind: "clarify",
      message: "How long was it (e.g. 2 hours), or what start and end times should I use?",
    };
  }
  const day = resolveDay(ctx, args);
  if (day === undefined) return { kind: "clarify", message: DATE_CLARIFY(args.date as string) };
  const start = `${day}T09:00:00.000Z`;
  const end = args.end ?? addMinutes(start, durationMinutes);
  return { kind: "ok", start, end };
}

const logWork = defineAction({
  name: "clockify_log_work",
  description:
    "Log a completed time entry. Resolves project/task by name. Give either an explicit `start` (+ `end`), or a `duration` (`durationHours`/`durationMinutes`) with the day — and you do NOT need to know the calendar date: pass `date` as `today`/`yesterday`/`tomorrow` (or YYYY-MM-DD), or `dayOffset` (0=today, -1=yesterday), and the harness anchors the start/end. Use this for \"log 2 hours on Apollo yesterday\" instead of asking for a clock time or date.",
  featureGroup: "time_tracking",
  risks: ["safe_write"],
  schema: z.object({
    description: z.string().min(1),
    start: z.string().optional(),
    end: z.string().optional(),
    date: z.string().optional(),
    dayOffset: zNumberLike(z.number().int()).optional(),
    durationMinutes: zNumberLike(z.number().positive()).optional(),
    durationHours: zNumberLike(z.number().positive()).optional(),
    projectId: z.string().optional(),
    projectName: z.string().optional(),
    taskId: z.string().optional(),
    taskName: z.string().optional(),
    tagIds: zStringList(z.array(z.string())).optional(),
    /** Tag names (or use tagIds) — resolved to verified ids server-side. */
    tagNames: zStringList(z.array(z.string())).optional(),
    billable: z.boolean().optional(),
  }),
  async handler(ctx, args) {
    const times = resolveLogTimes(ctx, args);
    if (times.kind === "clarify") {
      return { kind: "clarify", message: times.message };
    }

    // A name in EITHER slot resolves; unknown/ambiguous clarifies with grounded
    // options — never silently created.
    const refs = await resolveProjectTaskRefs(args, {
      verb: "log against",
      listProjects: (f) => ctx.clockify.listProjects(f),
      listTasks: (projectId) => ctx.clockify.listTasks(projectId),
      projectNotFoundHint: "Or should I create it first?",
    });
    if (!refs.ok) {
      return { kind: "clarify", message: refs.clarify.clarify, options: refs.clarify.options };
    }
    const tags = await resolveEntryTags(ctx, args);
    if (!tags.ok) return { kind: "clarify", message: tags.message, options: tags.options };

    const entry = await ctx.clockify.createTimeEntry({
      description: args.description,
      projectId: refs.projectId,
      taskId: refs.taskId,
      tagIds: tags.tagIds,
      billable: args.billable,
      start: times.start,
      end: times.end,
    });
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_log_work",
        entity: "time_entry",
        ids: { workspaceId: ctx.workspaceId },
        changed: { created: [{ type: "time_entry", id: entry.id, name: entry.description }] },
      }),
    };
  },
});

const reviewDay = defineAction({
  name: "clockify_review_day",
  description:
    "Summarize a user's time entries for a single day (defaults to today and the caller). `date` accepts YYYY-MM-DD or a relative day (today/yesterday/last monday…), resolved server-side. `userId` accepts a user id, exact name, or 'me'.",
  featureGroup: "time_tracking",
  risks: ["read"],
  schema: z.object({
    date: z.string().optional(), // YYYY-MM-DD or a relative day; defaults to today
    userId: z.string().optional(),
  }),
  async handler(ctx, args) {
    const date = resolveDay(ctx, { date: args.date });
    if (date === undefined) return { kind: "clarify", message: DATE_CLARIFY(args.date as string) };
    const user = await resolveUserFilter(args.userId, {
      verb: "review the day for",
      adminUserId: ctx.adminUserId,
      listUsers: () => ctx.clockify.listUsers(),
      defaultTo: ctx.adminUserId,
    });
    if (!user.ok) return { kind: "clarify", message: user.clarify.clarify, options: user.clarify.options };
    const userId = user.userId as string;
    const start = `${date}T00:00:00.000Z`;
    // Exclusive end = next-day midnight (consistent with review_week's window).
    const end = new Date(Date.parse(start) + DAY_MS).toISOString();
    const entries = await ctx.clockify.getEntries({ userId, start, end });
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_review_day",
        entity: "time_entry",
        ids: { workspaceId: ctx.workspaceId },
        data: { date, userId, count: entries.length, totalMinutes: totalMinutes(entries), entries },
      }),
    };
  },
});

const reviewWeek = defineAction({
  name: "clockify_review_week",
  description:
    "Summarize a user's time entries across a 7-day window from a start date (defaults to today and the caller). `start` accepts YYYY-MM-DD or a relative day (today/last monday…), resolved server-side. `userId` accepts a user id, exact name, or 'me'.",
  featureGroup: "time_tracking",
  risks: ["read"],
  schema: z.object({
    start: z.string().optional(), // YYYY-MM-DD or a relative day; defaults to today
    userId: z.string().optional(),
  }),
  async handler(ctx, args) {
    const startDate = resolveDay(ctx, { date: args.start });
    if (startDate === undefined) return { kind: "clarify", message: DATE_CLARIFY(args.start as string) };
    const user = await resolveUserFilter(args.userId, {
      verb: "review the week for",
      adminUserId: ctx.adminUserId,
      listUsers: () => ctx.clockify.listUsers(),
      defaultTo: ctx.adminUserId,
    });
    if (!user.ok) return { kind: "clarify", message: user.clarify.clarify, options: user.clarify.options };
    const userId = user.userId as string;
    const start = `${startDate}T00:00:00.000Z`;
    const end = new Date(Date.parse(start) + SEVEN_DAYS_MS).toISOString();
    const entries = await ctx.clockify.getEntries({ userId, start, end });
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_review_week",
        entity: "time_entry",
        ids: { workspaceId: ctx.workspaceId },
        data: { start: startDate, end, userId, count: entries.length, totalMinutes: totalMinutes(entries), entries },
      }),
    };
  },
});

const fixEntry = defineAction({
  name: "clockify_fix_entry",
  description:
    "Update fields of a known time entry (description, project, task, tags, billable). Use this to make entries billable/non-billable. Pass the project/task by id or exact name (`projectId`/`projectName`, `taskId`/`taskName`) — resolved server-side, clarifies on an unknown one. Safe — the entry id is already resolved.",
  featureGroup: "time_tracking",
  risks: ["safe_write"],
  schema: z
    .object({
      id: z.string().min(1),
      description: z.string().optional(),
      projectId: z.string().optional(),
      projectName: z.string().optional(),
      taskId: z.string().optional(),
      taskName: z.string().optional(),
      tagIds: zStringList(z.array(z.string())).optional(),
      /** Tag names (or use tagIds) — resolved to verified ids server-side. */
      tagNames: zStringList(z.array(z.string())).optional(),
      billable: z.boolean().optional(),
    })
    .refine(
      (v) =>
        v.description !== undefined ||
        v.projectId !== undefined ||
        v.projectName !== undefined ||
        v.taskId !== undefined ||
        v.taskName !== undefined ||
        v.tagIds !== undefined ||
        v.tagNames !== undefined ||
        v.billable !== undefined,
      { message: "Provide at least one field to change." },
    ),
  async handler(ctx, args) {
    // A name in either project/task slot resolves to a verified id first — a
    // mistaken identity clarifies, it never reaches the wire.
    const refs = await resolveProjectTaskRefs(args, {
      verb: "move the entry to",
      listProjects: (f) => ctx.clockify.listProjects(f),
      listTasks: (projectId) => ctx.clockify.listTasks(projectId),
    });
    if (!refs.ok) {
      return { kind: "clarify", message: refs.clarify.clarify, options: refs.clarify.options };
    }
    const tags = await resolveEntryTags(ctx, args);
    if (!tags.ok) return { kind: "clarify", message: tags.message, options: tags.options };
    const entry = await ctx.clockify.updateTimeEntry({
      id: args.id,
      description: args.description,
      projectId: refs.projectId,
      taskId: refs.taskId,
      tagIds: tags.tagIds,
      billable: args.billable,
    });
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_fix_entry",
        entity: "time_entry",
        ids: { workspaceId: ctx.workspaceId },
        changed: { updated: [{ type: "time_entry", id: entry.id, name: entry.description }] },
      }),
    };
  },
});

export const TIME_TRACKING_ACTIONS: ActionDefinition[] = [
  status,
  startTimer,
  stopTimer,
  logWork,
  reviewDay,
  reviewWeek,
  fixEntry,
];
