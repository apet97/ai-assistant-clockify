import { z } from "zod";
import { zNumberLike, zStringList } from "../arg-shapes.js";
import { defineAction, defineRiskyAction, type ActionContext, type ActionDefinition, type ClarifyOption, type SemanticLiteralAlias } from "../action.js";
import type {
  ApiAccess,
  ApiActionMetadataCarrier,
  ApiMethod,
  AvailabilityByAuthClass,
  MaterialFieldMetadata,
} from "../api-operation.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import { defineDurableSafeWriteAction } from "../durable-safe-write.js";
import { commitSingleDurableRiskyStep } from "../durable-risky-write.js";
import type { TimeEntrySummary } from "../../clockify/client.js";
import { listReceipt, successReceipt } from "../receipts.js";
import {
  resolveInstant,
  resolveProjectTaskRefs,
  resolveRelativeDay,
  resolveTagRefs,
  resolveUserFilter,
  zonedDayTimeInstant,
} from "./resolve.js";
import { DAY_MS, SEVEN_DAYS_MS, nowDate, nowIso } from "../../durations.js";
import { captureStructureSnapshot, defineStructureDurableSafeWriteAction, dispatchWithReconciliation, fetchStructureSnapshot, mutationPlan, reconcileCreate, requireFreshSnapshots, snapshot } from "./structure-durable.js";

/**
 * Time-tracking read + write workflows (SPEC "Safe Writes"): status, start timer,
 * stop timer, log work, review day/week (reads) — these execute immediately when
 * policy allows. fix entry EDITS an existing entry, so it is a high_risk_write:
 * it previews + requires confirmation like every other update action (editing
 * existing data has no undo). Ambiguous project/task identity stops and asks.
 */

type TimeTrackingActionName =
  | "clockify_status"
  | "clockify_start_timer"
  | "clockify_stop_timer"
  | "clockify_log_work"
  | "clockify_review_day"
  | "clockify_review_week"
  | "clockify_fix_entry";

const AVAILABLE_TO_BOTH_AUTH_CLASSES: AvailabilityByAuthClass = Object.freeze({
  addon: Object.freeze({ available: true }),
  api_key: Object.freeze({ available: true }),
});

function endpointKey(
  access: ApiAccess,
  method: ApiMethod,
  path: string,
  sourceModule: string,
): string {
  return [access, "api", method, path, sourceModule].join("\0");
}

function valueField(
  path: string,
  label: string,
  formatterId: string,
  requiredInPreview: boolean,
): MaterialFieldMetadata {
  return Object.freeze({
    kind: "value",
    path,
    label,
    formatterId,
    formatterVersion: 1,
    requiredInPreview,
  });
}

function apiMetadata(input: {
  actionName: TimeTrackingActionName;
  operationId: string;
  method: ApiMethod;
  path: string;
  access: ApiAccess;
  primary: string;
  support: readonly string[];
  materialFields: readonly MaterialFieldMetadata[];
}): ApiActionMetadataCarrier {
  return Object.freeze({
    apiExposure: "api",
    apiOperation: Object.freeze({
      operationId: input.operationId,
      host: "api",
      method: input.method,
      path: input.path,
      access: input.access,
      exposure: "api",
    }),
    adapterEndpoints: Object.freeze({
      primary: Object.freeze([input.primary]),
      support: Object.freeze([...input.support]),
    }),
    availabilityByAuthClass: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    boundedArgumentDictionaries: Object.freeze([]),
    materialFields: Object.freeze([...input.materialFields]),
    presentation: Object.freeze({ presenterId: input.actionName, version: 1 }),
  });
}

function internalMetadata(input: {
  exposure: "composite" | "generic";
  reason: string;
  primary: readonly string[];
  support: readonly string[];
}): ApiActionMetadataCarrier {
  return Object.freeze({
    apiExposure: input.exposure,
    apiExposureReason: input.reason,
    adapterEndpoints: Object.freeze({
      primary: Object.freeze([...input.primary]),
      support: Object.freeze([...input.support]),
    }),
    availabilityByAuthClass: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    boundedArgumentDictionaries: Object.freeze([]),
  });
}

const endpoint = Object.freeze({
  timeEntries: Object.freeze({
    list: endpointKey("read", "GET", "/workspaces/{workspaceId}/user/{userId}/time-entries", "time-entries.ts"),
    get: endpointKey("read", "GET", "/workspaces/{workspaceId}/time-entries/{id}", "time-entries.ts"),
    create: endpointKey("write", "POST", "/workspaces/{workspaceId}/time-entries", "time-entries.ts"),
    stop: endpointKey("write", "PATCH", "/workspaces/{workspaceId}/user/{userId}/time-entries", "time-entries.ts"),
    update: endpointKey("write", "PUT", "/workspaces/{workspaceId}/time-entries/{id}", "time-entries.ts"),
  }),
  projects: Object.freeze({
    list: endpointKey("read", "GET", "/workspaces/{workspaceId}/projects", "projects.ts"),
    get: endpointKey("read", "GET", "/workspaces/{workspaceId}/projects/{id}", "projects.ts"),
  }),
  tasks: Object.freeze({
    list: endpointKey("read", "GET", "/workspaces/{workspaceId}/projects/{projectId}/tasks", "tasks.ts"),
    get: endpointKey("read", "GET", "/workspaces/{workspaceId}/projects/{projectId}/tasks/{id}", "tasks.ts"),
  }),
  tags: Object.freeze({
    list: endpointKey("read", "GET", "/workspaces/{workspaceId}/tags", "tags.ts"),
  }),
  users: Object.freeze({
    list: endpointKey("read", "GET", "/workspaces/{workspaceId}/users", "users.ts"),
  }),
});

const TIME_TRACKING_API_METADATA = Object.freeze({
  clockify_status: apiMetadata({
    actionName: "clockify_status",
    operationId: "getTimeEntries",
    method: "GET",
    path: "/workspaces/{workspaceId}/user/{userId}/time-entries",
    access: "read",
    primary: endpoint.timeEntries.list,
    support: [endpoint.projects.get],
    materialFields: [],
  }),
  clockify_start_timer: internalMetadata({
    exposure: "generic",
    reason: "The tagIds and tagNames inputs are unbounded, so leaf-level material expansion cannot be statically bounded; Task 6 must expose a narrowed start operation.",
    primary: [endpoint.timeEntries.create],
    support: [
      endpoint.projects.list,
      endpoint.projects.get,
      endpoint.tasks.list,
      endpoint.tasks.get,
      endpoint.tags.list,
      endpoint.timeEntries.list,
    ],
  }),
  clockify_stop_timer: apiMetadata({
    actionName: "clockify_stop_timer",
    operationId: "stopRunningTimeEntry",
    method: "PATCH",
    path: "/workspaces/{workspaceId}/user/{userId}/time-entries",
    access: "write",
    primary: endpoint.timeEntries.stop,
    support: [endpoint.timeEntries.list, endpoint.timeEntries.get],
    materialFields: [
      valueField("/userId", "User", "entity", true),
      valueField("/end", "Stop time", "text", true),
    ],
  }),
  clockify_log_work: internalMetadata({
    exposure: "generic",
    reason: "The tagIds and tagNames inputs are unbounded, so leaf-level material expansion cannot be statically bounded; Task 6 must expose a narrowed create operation.",
    primary: [endpoint.timeEntries.create],
    support: [
      endpoint.projects.list,
      endpoint.projects.get,
      endpoint.tasks.list,
      endpoint.tasks.get,
      endpoint.tags.list,
      endpoint.timeEntries.list,
    ],
  }),
  clockify_review_day: internalMetadata({
    exposure: "composite",
    reason: "Resolves a user and day window, then computes an aggregate total over the list response, so it remains an internal review workflow.",
    primary: [endpoint.timeEntries.list],
    support: [endpoint.users.list],
  }),
  clockify_review_week: internalMetadata({
    exposure: "composite",
    reason: "Resolves a user and seven-day window, then computes an aggregate total over the list response, so it remains an internal review workflow.",
    primary: [endpoint.timeEntries.list],
    support: [endpoint.users.list],
  }),
  clockify_fix_entry: internalMetadata({
    exposure: "generic",
    reason: "The tagIds and tagNames inputs are unbounded, so leaf-level material expansion cannot be statically bounded; Task 6 must expose a narrowed update operation.",
    primary: [endpoint.timeEntries.update],
    support: [
      endpoint.timeEntries.get,
      endpoint.projects.list,
      endpoint.projects.get,
      endpoint.tasks.list,
      endpoint.tasks.get,
      endpoint.tags.list,
    ],
  }),
} satisfies Readonly<Record<TimeTrackingActionName, ApiActionMetadataCarrier>>);

const BILLABLE_LITERAL_ALIASES = Object.freeze([
  { path: "billable", value: false, authoredPhrases: Object.freeze(["non-billable", "nonbillable", "non billable", "not billable"]) },
  { path: "billable", value: true, authoredPhrases: Object.freeze(["billable"]) },
] satisfies readonly SemanticLiteralAlias[]);

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

/**
 * Caveat for a review whose entry list hit the pagination backstop: the count
 * AND `totalMinutes` are computed on an incomplete set, so the total is an
 * UNDERSTATEMENT, not the full picture. Shared by review_day + review_week.
 */
const TRUNCATED_TOTAL_WARNING = {
  code: "list_truncated",
  message:
    "This window has more time entries than I could fetch at once, so the count and total are UNDERSTATED (the real total is higher). Narrow the date range to get a complete total.",
} as const;

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
  ...TIME_TRACKING_API_METADATA.clockify_status,
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

const startTimer = defineDurableSafeWriteAction({
  name: "clockify_start_timer",
  ...TIME_TRACKING_API_METADATA.clockify_start_timer,
  description:
    "Start a new timer for the admin on an EXISTING project. Call this DIRECTLY when asked to start a timer — do NOT check the current status first, and when no project is mentioned just start it with no project (all args are optional). Pass the project by name with `projectName` (resolved to its id; an unknown name CLARIFIES, it is never created) — use clockify_create_work_package with startTimer:true only when the admin explicitly asks to CREATE a new project.",
  group: "time_tracking",
  stepName: "Start timer",
  mutationContract: durableMutationContract({
    source: "safe",
    targeting: { mode: "snapshots", relations: ["parent"] },
    strategies: ["create"],
  }),
  semanticLiteralAliases: BILLABLE_LITERAL_ALIASES,
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
  async prepare(ctx, args) {
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
      return { kind: "clarify", clarify: refs.clarify.clarify, options: refs.clarify.options };
    }
    const tags = await resolveEntryTags(ctx, args);
    if (!tags.ok) return { kind: "clarify", clarify: tags.message, options: tags.options };
    const targetSnapshots: ReturnType<typeof snapshot>[] = [];
    if (refs.projectId) {
      const project = await ctx.clockify.getProject(refs.projectId);
      if (!project) return { kind: "clarify" as const, clarify: "The selected project no longer exists. Refresh and try again." };
      targetSnapshots.push(await captureStructureSnapshot(ctx, "parent", "project", project));
    }
    if (refs.taskId && refs.projectId) {
      const task = await ctx.clockify.getTask(refs.projectId, refs.taskId);
      if (!task) return { kind: "clarify" as const, clarify: "The selected task no longer exists. Refresh and try again." };
      targetSnapshots.push(await captureStructureSnapshot(ctx, "parent", "task", task, { projectId: refs.projectId }));
    }
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
      operation: { body, targetSnapshots },
      mutationPlan: mutationPlan([{ id: "start-timer", strategy: "create", fingerprint: targetSnapshots.map((item) => item.fingerprint).join(":") || undefined }]),
    };
  },
  async dispatch(ctx, operation) {
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
        action: "clockify_start_timer",
        entity: "time_entry",
        ids: { workspaceId: ctx.workspaceId },
        changed: { created: [created] },
      }),
      externalId: entry.id,
      effect: { created },
      detail: { reconciled: result.reconciled },
    };
  },
});

const stopTimer = defineDurableSafeWriteAction({
  name: "clockify_stop_timer",
  ...TIME_TRACKING_API_METADATA.clockify_stop_timer,
  description: "Stop the admin's currently running timer.",
  group: "time_tracking",
  stepName: "Stop timer",
  mutationContract: durableMutationContract({
    source: "safe",
    targeting: { mode: "snapshots", relations: ["target"] },
    strategies: ["state-command"],
  }),
  schema: z.object({}).strip(),
  async prepare(ctx) {
    const running = await ctx.clockify.getRunningTimeEntry(ctx.adminUserId);
    const targetSnapshots = running ? [await captureStructureSnapshot(ctx, "target", "time_entry", running)] : [];
    return {
      operation: { userId: ctx.adminUserId, end: nowIso(ctx), targetSnapshots },
      mutationPlan: mutationPlan([{ id: "stop-timer", strategy: "state-command", fingerprint: targetSnapshots[0]?.fingerprint }]),
    };
  },
  async dispatch(ctx, operation) {
    const prepared = operation as { userId: string; end: string; targetSnapshots: ReturnType<typeof snapshot>[] };
    if (prepared.targetSnapshots.length) await requireFreshSnapshots(ctx, prepared.targetSnapshots);
    const result = await dispatchWithReconciliation({
      dispatch: () => ctx.clockify.stopTimeEntryAtomic({ userId: prepared.userId, end: prepared.end }),
      reconcile: async () => {
        if (!prepared.targetSnapshots[0]) return undefined;
        const current = await ctx.clockify.getEntry(prepared.targetSnapshots[0].ref.id);
        return current?.end ? current : undefined;
      },
    });
    const entry = result.value;
    if (!entry) {
      return {
        result: successReceipt({
          action: "clockify_stop_timer",
          warnings: [{ message: "No running timer to stop." }],
        }),
      };
    }
    return {
      result: successReceipt({
        action: "clockify_stop_timer",
        entity: "time_entry",
        ids: { workspaceId: ctx.workspaceId },
        changed: { updated: [{ type: "time_entry", id: entry.id, name: entry.description }] },
      }),
      externalId: entry.id,
      effect: { stopped: { type: "time_entry", id: entry.id } },
      detail: { reconciled: result.reconciled },
    };
  },
});

/** Resolve the entry's day (YYYY-MM-DD) server-side — shared {@link resolveRelativeDay}.
 *  `undefined` = unparseable; callers clarify instead of sending it (live: review
 *  crashed with "Invalid time value" on `new Date("today")`). */
function resolveDay(ctx: ActionContext, args: { date?: string; dayOffset?: number }): string | undefined {
  return resolveRelativeDay(nowDate(ctx), args, ctx.timeZone);
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
  // An explicit end at or before the start is a negative-length entry (e.g.
  // "5pm to 9am" resolved same-day). log_work is a SAFE write — it commits
  // immediately with no preview to catch it — so clarify rather than log a
  // reversed span; an overnight entry must name the next day explicitly.
  if (end !== undefined && Date.parse(end) <= Date.parse(start)) {
    return {
      kind: "clarify",
      message:
        "The end time is at or before the start, which would be a negative-length entry. For an overnight entry, give the end as the next day (a full date/time); otherwise double-check the start and end.",
    };
  }
  return { kind: "ok", start, end };
}

const logWorkDefinition = defineStructureDurableSafeWriteAction({
  name: "clockify_log_work",
  description:
    "Log a completed time entry. Resolves project/task by name. `description` is OPTIONAL — never invent one. Use exactly one shape: `start+end`, `start+durationHours|durationMinutes`, or `date|dayOffset + durationHours|durationMinutes`. Explicit datetimes require Z or a numeric offset. Duration is capped at 168 hours.",
  group: "time_tracking",
  stepName: "Log time entry",
  mutationContract: durableMutationContract({ source: "safe", targeting: { mode: "snapshots", relations: ["parent"] }, strategies: ["create"] }),
  semanticLiteralAliases: BILLABLE_LITERAL_ALIASES,
  schema: z.object({
    /** Optional — omitted entries are honest blanks; never ask for or invent one. */
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
    tagIds: zStringList(z.array(z.string())).optional(),
    /** Tag names (or use tagIds) — resolved to verified ids server-side. */
    tagNames: zStringList(z.array(z.string())).optional(),
    billable: z.boolean().optional(),
  }).superRefine((args, ctx) => {
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
  }),
  async prepare(ctx, args) {
    const times = resolveLogTimes(ctx, args);
    if (times.kind === "clarify") {
      return { kind: "clarify", clarify: times.message };
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
      return { kind: "clarify", clarify: refs.clarify.clarify, options: refs.clarify.options };
    }
    const tags = await resolveEntryTags(ctx, args);
    if (!tags.ok) return { kind: "clarify", clarify: tags.message, options: tags.options };
    const targetSnapshots: ReturnType<typeof snapshot>[] = [];
    if (refs.projectId) {
      const project = await ctx.clockify.getProject(refs.projectId);
      if (!project) return { kind: "clarify" as const, clarify: "The selected project no longer exists. Refresh and try again." };
      targetSnapshots.push(await captureStructureSnapshot(ctx, "parent", "project", project));
    }
    if (refs.taskId && refs.projectId) {
      const task = await ctx.clockify.getTask(refs.projectId, refs.taskId);
      if (!task) return { kind: "clarify" as const, clarify: "The selected task no longer exists. Refresh and try again." };
      targetSnapshots.push(await captureStructureSnapshot(ctx, "parent", "task", task, { projectId: refs.projectId }));
    }
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
      operation: { body, targetSnapshots },
      mutationPlan: mutationPlan([{ id: "log-time-entry", strategy: "create", fingerprint: targetSnapshots.map((item) => item.fingerprint).join(":") || undefined }]),
    };
  },
  async prepareDispatch(ctx, operation) {
    const { body, targetSnapshots } = operation as {
      body: Parameters<typeof ctx.clockify.createTimeEntryAtomic>[0];
      targetSnapshots: ReturnType<typeof snapshot>[];
    };
    if (targetSnapshots.length) await requireFreshSnapshots(ctx, targetSnapshots);
    const baseline = await ctx.clockify.getEntries({ userId: ctx.adminUserId, start: body.start, end: new Date(Date.parse(body.start) + 1).toISOString() });
    if (baseline.truncated) throw new Error("create_baseline_incomplete");
    const beforeIds = baseline.rows.map((row) => row.id);
    return {
      preparedDetail: { preDispatch: { strategy: "time_entry_create_baseline", ids: beforeIds, truncated: false } },
      state: { beforeIds },
    };
  },
  async dispatch(ctx, operation, state) {
    const { body } = operation as { body: Parameters<typeof ctx.clockify.createTimeEntryAtomic>[0] };
    const result = await dispatchWithReconciliation({
      dispatch: () => ctx.clockify.createTimeEntryAtomic(body),
      reconcile: async () => reconcileCreate({
        beforeIds: state.beforeIds,
        list: () => ctx.clockify.getEntries({ userId: ctx.adminUserId, start: body.start, end: new Date(Date.parse(body.start) + 1).toISOString() }),
        matches: (row) => row.start === body.start && row.end === (body.end ?? null) && row.description === body.description &&
          row.projectId === body.projectId && row.taskId === body.taskId && JSON.stringify(row.tagIds ?? []) === JSON.stringify(body.tagIds ?? []) && row.billable === body.billable,
      }),
    });
    const entry = result.value;
    const created = { type: "time_entry", id: entry.id, name: entry.description };
    return {
      result: successReceipt({
        action: "clockify_log_work",
        entity: "time_entry",
        ids: { workspaceId: ctx.workspaceId },
        changed: { created: [created] },
      }),
      externalId: entry.id,
      effect: { created },
      detail: { reconciled: result.reconciled, baselineComplete: true },
    };
  },
});

const logWork = Object.freeze({
  ...logWorkDefinition,
  ...TIME_TRACKING_API_METADATA.clockify_log_work,
});

const reviewDay = defineAction({
  name: "clockify_review_day",
  ...TIME_TRACKING_API_METADATA.clockify_review_day,
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
    const userId = user.userId;
    const start = `${date}T00:00:00.000Z`;
    // Exclusive end = next-day midnight (consistent with review_week's window).
    const end = new Date(Date.parse(start) + DAY_MS).toISOString();
    const { rows, truncated } = await ctx.clockify.getEntries({ userId, start, end });
    return {
      kind: "receipt",
      receipt: listReceipt({
        action: "clockify_review_day",
        entity: "time_entry",
        ids: { workspaceId: ctx.workspaceId },
        rows,
        truncated,
        data: {
          date,
          userId,
          totalMinutes: totalMinutes(rows),
        },
        dataKey: "entries",
        truncationMessage: TRUNCATED_TOTAL_WARNING.message,
      }),
    };
  },
});

const reviewWeek = defineAction({
  name: "clockify_review_week",
  ...TIME_TRACKING_API_METADATA.clockify_review_week,
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
    const userId = user.userId;
    const start = `${startDate}T00:00:00.000Z`;
    const end = new Date(Date.parse(start) + SEVEN_DAYS_MS).toISOString();
    const { rows, truncated } = await ctx.clockify.getEntries({ userId, start, end });
    return {
      kind: "receipt",
      receipt: listReceipt({
        action: "clockify_review_week",
        entity: "time_entry",
        ids: { workspaceId: ctx.workspaceId },
        rows,
        truncated,
        data: {
          start: startDate,
          end,
          userId,
          totalMinutes: totalMinutes(rows),
        },
        dataKey: "entries",
        truncationMessage: TRUNCATED_TOTAL_WARNING.message,
      }),
    };
  },
});

const fixEntry = defineRiskyAction({
  name: "clockify_fix_entry",
  ...TIME_TRACKING_API_METADATA.clockify_fix_entry,
  description:
    "Update fields of an existing time entry (description, project, task, tags, billable). Use this to make entries billable/non-billable. Pass the project/task by id or exact name (`projectId`/`projectName`, `taskId`/`taskName`) — resolved server-side, clarifies on an unknown one. Elevated write — editing an existing entry previews and requires confirmation.",
  group: "time_tracking",
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({
    source: "confirmed",
    targeting: { mode: "snapshots", relations: ["target", "parent"] },
    strategies: ["update"],
  }),
  semanticLiteralAliases: BILLABLE_LITERAL_ALIASES,
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
  async preview(ctx, args) {
    const current = await ctx.clockify.getEntry(args.id);
    if (!current) return { clarify: "The requested time entry does not exist. Provide a current entry id." };
    // Resolve identity at PREVIEW time: a name in either project/task slot becomes
    // a verified id, and a mistaken identity clarifies here — it never reaches the
    // wire (and never gets stored in the confirmable payload).
    const refs = await resolveProjectTaskRefs(args, {
      verb: "move the entry to",
      listProjects: (f) => ctx.clockify.listProjects(f),
      listTasks: (projectId) => ctx.clockify.listTasks(projectId),
    });
    if (!refs.ok) return refs.clarify;
    const tags = await resolveEntryTags(ctx, args);
    if (!tags.ok) return { clarify: tags.message, options: tags.options };

    // Human-readable change list for the preview (resolved NAMES, not raw ids).
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
  },
  async commit(ctx, payload, operation) {
    const p = payload as {
      id: string;
      description?: string;
      projectId?: string;
      taskId?: string;
      tagIds?: string[];
      billable?: boolean;
      body: Record<string, unknown>;
    };
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
            return Object.entries(expected).every(([key, value]) => value === undefined || JSON.stringify((row as unknown as Record<string, unknown>)[key]) === JSON.stringify(value)) ? row : undefined;
          },
        });
        entry = result.value;
        return { externalId: result.value.id, effect: { updated: { type: "time_entry", id: p.id } }, detail: { reconciled: result.reconciled } };
      },
      success: () => successReceipt({
        action: "clockify_fix_entry",
        entity: "time_entry",
        ids: { workspaceId: ctx.workspaceId },
        changed: { updated: [{ type: "time_entry", id: p.id, name: entry?.description }] },
      }),
    });
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
