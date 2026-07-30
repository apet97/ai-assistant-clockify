import { z } from "zod";
import { defineAction, defineRiskyAction, type ActionDefinition } from "../action.js";
import type { ApiAccess, ApiActionMetadataCarrier, ApiMethod, MaterialFieldMetadata } from "../api-operation.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import { defineDurableSafeWriteAction } from "../durable-safe-write.js";
import type { TimeEntrySummary } from "../../clockify/client.js";
import { listReceipt, successReceipt } from "../receipts.js";
import {
  resolveUserFilter,
} from "./resolve.js";
import { DAY_MS, SEVEN_DAYS_MS, nowIso } from "../../durations.js";
import { captureStructureSnapshot, defineStructureDurableSafeWriteAction, dispatchWithReconciliation, mutationPlan, requireFreshSnapshots, snapshot } from "./structure-durable.js";
import {
  TIME_ENTRY_BILLABLE_LITERAL_ALIASES,
  DATE_CLARIFY,
  dispatchEntriesCreate,
  dispatchEntriesStart,
  entriesCreateGenericSchema,
  entriesStartGenericSchema,
  entriesUpdateGenericSchema,
  prepareEntriesCreate,
  prepareEntriesCreateDispatch,
  prepareEntriesStart,
  previewEntriesUpdate,
  commitEntriesUpdate,
  resolveDay,
  resolveEntryTagsUnbounded,
} from "./entry-action-shared.js";
import {
  TIME_ENTRY_ADAPTER_ENDPOINTS,
  buildTimeEntryApiMetadata,
  buildTimeEntryInternalMetadata,
  timeEntryValueField,
} from "./entry-api-metadata.js";

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

const endpoint = Object.freeze({
  ...TIME_ENTRY_ADAPTER_ENDPOINTS,
});

function apiMetadata(input: {
  actionName: Extract<TimeTrackingActionName, "clockify_stop_timer">;
  operationId: string;
  method: ApiMethod;
  path: string;
  access: ApiAccess;
  primary: string;
  support: readonly string[];
  materialFields: readonly MaterialFieldMetadata[];
}) {
  return buildTimeEntryApiMetadata(input);
}

function internalMetadata(input: {
  exposure: "composite" | "generic";
  reason: string;
  primary: readonly string[];
  support: readonly string[];
}) {
  return buildTimeEntryInternalMetadata(input);
}

const TIME_TRACKING_API_METADATA = Object.freeze({
  clockify_status: internalMetadata({
    exposure: "composite",
    reason: "Filters the running-timer list response and enriches it with a project name lookup, so it is not one exact Clockify read operation.",
    primary: [endpoint.timeEntries.list],
    support: [endpoint.projects.get],
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
      timeEntryValueField("/userId", "User", "entity", true),
      timeEntryValueField("/end", "Stop time", "text", true),
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
    reason: "Superseded on MODEL_API by clockify_entries_update, which bounds tagIds for material expansion; retained for legacy planner paths.",
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

const BILLABLE_LITERAL_ALIASES = TIME_ENTRY_BILLABLE_LITERAL_ALIASES;

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
  schema: entriesStartGenericSchema,
  async prepare(ctx, args) {
    const tags = await resolveEntryTagsUnbounded(ctx, args);
    if (!tags.ok) return { kind: "clarify", clarify: tags.message, options: tags.options };
    const { tagNames: _tagNames, ...startArgs } = args;
    return prepareEntriesStart(ctx, { ...startArgs, tagIds: tags.tagIds }, { planStepId: "start-timer" });
  },
  dispatch: (ctx, operation) => dispatchEntriesStart(ctx, operation, "clockify_start_timer"),
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
      // Deliberate no-op: ok + warning with NO `data` and NO `changed` is the
      // exact shape `result-view-service.ts` presents as "No change needed"
      // (readiness A5 / D-3). Adding a `data` payload here would silently
      // reclassify this receipt as a plain success — don't.
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

const logWorkDefinition = defineStructureDurableSafeWriteAction({
  ...TIME_TRACKING_API_METADATA.clockify_log_work,
  name: "clockify_log_work",
  description:
    "Log a completed time entry. Resolves project/task by name. `description` is OPTIONAL — never invent one. Use exactly one shape: `start+end`, `start+durationHours|durationMinutes`, or `date|dayOffset + durationHours|durationMinutes`. Explicit datetimes require Z or a numeric offset. Duration is capped at 168 hours.",
  group: "time_tracking",
  stepName: "Log time entry",
  mutationContract: durableMutationContract({ source: "safe", targeting: { mode: "snapshots", relations: ["parent"] }, strategies: ["create"] }),
  semanticLiteralAliases: BILLABLE_LITERAL_ALIASES,
  schema: entriesCreateGenericSchema,
  async prepare(ctx, args) {
    const tags = await resolveEntryTagsUnbounded(ctx, args);
    if (!tags.ok) return { kind: "clarify", clarify: tags.message, options: tags.options };
    const { tagNames: _tagNames, ...createArgs } = args;
    return prepareEntriesCreate(ctx, { ...createArgs, tagIds: tags.tagIds }, { planStepId: "log-time-entry" });
  },
  prepareDispatch: prepareEntriesCreateDispatch,
  dispatch: (ctx, operation, state) => dispatchEntriesCreate(ctx, operation, state, "clockify_log_work"),
});

const logWork = Object.freeze({
  ...logWorkDefinition,
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
  schema: entriesUpdateGenericSchema,
  preview: (ctx, args) => previewEntriesUpdate(ctx, args, { boundedTags: false }),
  commit: (ctx, payload, operation) => commitEntriesUpdate(ctx, payload, operation, "clockify_fix_entry"),
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
