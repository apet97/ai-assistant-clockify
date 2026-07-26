import { z } from "zod";
import { zStringList } from "../arg-shapes.js";
import {
  clarifyResult,
  defineAction,
  defineReadAction,
  defineRiskyAction,
  type ActionContext,
  type ActionDefinition,
  type RiskyClarifyResult,
  type SemanticLiteralAlias,
  type TargetSnapshot,
} from "../action.js";
import { defineDurableSafeWriteAction } from "../durable-safe-write.js";
import { nowDate } from "../../durations.js";
import { listReceipt, successReceipt } from "../receipts.js";
import { resolveDateRange, resolveEntityRef, resolveRelativeDay, resolveScopeRefs, resolveUserFilter } from "./resolve.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import { commitSingleDurableRiskyStep } from "../durable-risky-write.js";
import { HOLIDAY_SCOPE_GROUP_BATCH_MAX, HOLIDAY_SCOPE_USER_BATCH_MAX } from "../safety-limits.js";
import { captureTargetSnapshot } from "../target-snapshots.js";
import { dispatchWithReconciliation, reconcileCreate, reconcileDelete } from "./structure-durable.js";
import type { CreateHolidayInput, HolidaySummary, PreparedHolidayUpdateInput } from "../../clockify/ports/holidays.js";
import type {
  ApiAccess,
  ApiActionMetadataCarrier,
  ApiMethod,
  AvailabilityByAuthClass,
  MaterialFieldMetadata,
} from "../api-operation.js";

const HOLIDAY_RECURRENCE_LITERAL_ALIASES = Object.freeze([
  { path: "occursAnnually", value: false, authoredPhrases: Object.freeze(["one-time", "one time", "does not repeat"]) },
  { path: "occursAnnually", value: true, authoredPhrases: Object.freeze(["annually", "annual", "yearly", "every year"]) },
] satisfies readonly SemanticLiteralAlias[]);

/**
 * Resolve a holiday's `startDate`/`endDate` server-side (CLAUDE.md "dates
 * server-side" invariant) — the model must never compute a calendar date. Each
 * provided value resolves to a real YYYY-MM-DD via resolveRelativeDay (absolute
 * dates pass through, relative days like "next monday" resolve, a real-day check
 * rejects 2026-02-30); an unparseable/fabricated value clarifies instead of
 * sending a string the wire would reject (or silently mis-date). Undefined inputs
 * stay undefined (update may change neither). Returns a native
 * {@link RiskyClarifyResult} so the risky-preview returns it directly; the
 * safe-write handler wraps it with {@link clarifyResult}.
 */
function resolveHolidayDates(
  ctx: ActionContext,
  startDate: string | undefined,
  endDate: string | undefined,
): { ok: true; startDate?: string; endDate?: string } | { ok: false; clarify: RiskyClarifyResult } {
  const now = nowDate(ctx);
  const bad: string[] = [];
  const resolvedStart = startDate !== undefined ? resolveRelativeDay(now, { date: startDate }, ctx.timeZone) : undefined;
  if (startDate !== undefined && resolvedStart === undefined) bad.push(`start date "${startDate}"`);
  const resolvedEnd = endDate !== undefined ? resolveRelativeDay(now, { date: endDate }, ctx.timeZone) : undefined;
  if (endDate !== undefined && resolvedEnd === undefined) bad.push(`end date "${endDate}"`);
  if (bad.length) {
    return {
      ok: false,
      clarify: {
        clarify: `I couldn't make sense of the ${bad.join(" or ")}. Use a real date like 2026-12-25 or a relative day like "next monday".`,
      },
    };
  }
  return { ok: true, startDate: resolvedStart, endDate: resolvedEnd };
}

/**
 * Typed holiday workflows (goclmcp §2.9 — holidays). Reads (list/get/in-period)
 * and create/update execute immediately (safe_write, matching how named
 * work-structure resources are created); delete is destructive (preview→commit).
 * All gated by `time_off_approvals`. Clockify rejects a holiday with no
 * assignment, so create requires at least one user or user group.
 */

const TOA = "time_off_approvals" as const;

type HolidayActionName =
  | "clockify_holidays_list"
  | "clockify_holidays_get"
  | "clockify_holidays_in_period"
  | "clockify_holidays_create"
  | "clockify_holidays_update"
  | "clockify_holidays_delete";

const HOLIDAY_AVAILABILITY: AvailabilityByAuthClass = Object.freeze({
  addon: Object.freeze({ available: true }),
  api_key: Object.freeze({ available: true }),
});

function holidayEndpointKey(
  access: ApiAccess,
  method: ApiMethod,
  path: string,
  sourceModule = "holidays.ts",
): string {
  return [access, "api", method, path, sourceModule].join("\0");
}

function holidayValueField(
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

function holidayApiMetadata(input: {
  actionName: HolidayActionName;
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
    availabilityByAuthClass: HOLIDAY_AVAILABILITY,
    boundedArgumentDictionaries: Object.freeze([]),
    materialFields: Object.freeze([...input.materialFields]),
    presentation: Object.freeze({ presenterId: input.actionName, version: 1 }),
  });
}

function holidayInternalMetadata(input: {
  exposure: "composite" | "generic";
  reason: string;
  primary: string;
  support: readonly string[];
}): ApiActionMetadataCarrier {
  return Object.freeze({
    apiExposure: input.exposure,
    apiExposureReason: input.reason,
    adapterEndpoints: Object.freeze({
      primary: Object.freeze([input.primary]),
      support: Object.freeze([...input.support]),
    }),
    availabilityByAuthClass: HOLIDAY_AVAILABILITY,
    boundedArgumentDictionaries: Object.freeze([]),
  });
}

const holidayEndpoint = Object.freeze({
  list: holidayEndpointKey("read", "GET", "/workspaces/{workspaceId}/holidays"),
  inPeriod: holidayEndpointKey("read", "GET", "/workspaces/{workspaceId}/holidays/in-period"),
  create: holidayEndpointKey("write", "POST", "/workspaces/{workspaceId}/holidays"),
  update: holidayEndpointKey("write", "PUT", "/workspaces/{workspaceId}/holidays/{id}"),
  delete: holidayEndpointKey("write", "DELETE", "/workspaces/{workspaceId}/holidays/{id}"),
  users: holidayEndpointKey("read", "GET", "/workspaces/{workspaceId}/users", "users.ts"),
  groups: holidayEndpointKey("read", "GET", "/workspaces/{workspaceId}/user-groups", "users.ts"),
});

const HOLIDAY_API_METADATA = Object.freeze({
  clockify_holidays_list: holidayApiMetadata({
    actionName: "clockify_holidays_list",
    operationId: "getHolidays",
    method: "GET",
    path: "/workspaces/{workspaceId}/holidays",
    access: "read",
    primary: holidayEndpoint.list,
    support: [],
    materialFields: [],
  }),
  clockify_holidays_get: holidayInternalMetadata({
    exposure: "composite",
    reason: "Finds one holiday by scanning the holidays list because Clockify exposes no GET /holidays/{id}; it is not a fabricated get-one operation.",
    primary: holidayEndpoint.list,
    support: [],
  }),
  clockify_holidays_in_period: holidayApiMetadata({
    actionName: "clockify_holidays_in_period",
    operationId: "getHolidaysInPeriod",
    method: "GET",
    path: "/workspaces/{workspaceId}/holidays/in-period",
    access: "read",
    primary: holidayEndpoint.inPeriod,
    support: [holidayEndpoint.users],
    materialFields: [],
  }),
  clockify_holidays_create: holidayApiMetadata({
    actionName: "clockify_holidays_create",
    operationId: "createHoliday",
    method: "POST",
    path: "/workspaces/{workspaceId}/holidays",
    access: "write",
    primary: holidayEndpoint.create,
    support: [holidayEndpoint.list, holidayEndpoint.users, holidayEndpoint.groups],
    materialFields: [
      holidayValueField("/name", "Holiday name", "text", true),
      holidayValueField("/startDate", "Start date", "text", true),
      holidayValueField("/endDate", "End date", "text", false),
      holidayValueField("/occursAnnually", "Recurs annually", "boolean", false),
      {
        kind: "array_item",
        containerPath: "/userIds",
        itemPath: "/userId",
        labelTemplate: "User {index}",
        maxItems: HOLIDAY_SCOPE_USER_BATCH_MAX,
        formatterId: "entity",
        formatterVersion: 1,
        requiredInPreview: false,
      },
      {
        kind: "array_item",
        containerPath: "/userGroupIds",
        itemPath: "/groupId",
        labelTemplate: "Group {index}",
        maxItems: HOLIDAY_SCOPE_GROUP_BATCH_MAX,
        formatterId: "entity",
        formatterVersion: 1,
        requiredInPreview: false,
      },
    ],
  }),
  clockify_holidays_update: holidayApiMetadata({
    actionName: "clockify_holidays_update",
    operationId: "updateHoliday",
    method: "PUT",
    path: "/workspaces/{workspaceId}/holidays/{id}",
    access: "write",
    primary: holidayEndpoint.update,
    support: [holidayEndpoint.list, holidayEndpoint.users, holidayEndpoint.groups],
    materialFields: [
      holidayValueField("/id", "Holiday", "entity", true),
      holidayValueField("/name", "Holiday name", "text", false),
      holidayValueField("/startDate", "Start date", "text", false),
      holidayValueField("/endDate", "End date", "text", false),
      holidayValueField("/occursAnnually", "Recurs annually", "boolean", false),
      {
        kind: "array_item",
        containerPath: "/userIds",
        itemPath: "/userId",
        labelTemplate: "User {index}",
        maxItems: HOLIDAY_SCOPE_USER_BATCH_MAX,
        formatterId: "entity",
        formatterVersion: 1,
        requiredInPreview: false,
      },
      {
        kind: "array_item",
        containerPath: "/userGroupIds",
        itemPath: "/groupId",
        labelTemplate: "Group {index}",
        maxItems: HOLIDAY_SCOPE_GROUP_BATCH_MAX,
        formatterId: "entity",
        formatterVersion: 1,
        requiredInPreview: false,
      },
    ],
  }),
  clockify_holidays_delete: holidayApiMetadata({
    actionName: "clockify_holidays_delete",
    operationId: "deleteHoliday",
    method: "DELETE",
    path: "/workspaces/{workspaceId}/holidays/{id}",
    access: "write",
    primary: holidayEndpoint.delete,
    support: [holidayEndpoint.list],
    materialFields: [
      holidayValueField("/id", "Holiday", "entity", true),
      holidayValueField("/name", "Holiday name", "text", false),
    ],
  }),
} satisfies Readonly<Record<HolidayActionName, ApiActionMetadataCarrier>>);

const holidayTargetContract = (strategy: "update" | "delete") => durableMutationContract({
  source: "confirmed", targeting: { mode: "snapshots", relations: ["target"] }, strategies: [strategy],
});
const holidayCreateContract = durableMutationContract({
  source: "safe", targeting: { mode: "create_no_target" }, strategies: ["create"],
});

async function holidaySnapshot(ctx: ActionContext, id: string): Promise<TargetSnapshot | undefined> {
  const holiday = await ctx.clockify.getHoliday(id);
  return holiday ? captureTargetSnapshot("target", { type: "holiday", id: holiday.id, name: holiday.name }, holiday) : undefined;
}

function fetchHolidaySnapshot(ctx: ActionContext, snapshot: TargetSnapshot) {
  return ctx.clockify.getHolidayMutationState(snapshot.ref.id).then((holiday) => holiday
    ? { ref: { type: "holiday", id: holiday.id, name: holiday.name }, projection: holiday, truncated: false }
    : undefined);
}

function sameHoliday(row: HolidaySummary, expected: CreateHolidayInput | PreparedHolidayUpdateInput): boolean {
  if (row.name !== expected.name || row.startDate !== expected.startDate) return false;
  if (row.endDate !== (expected.endDate ?? expected.startDate)) return false;
  return (row.occursAnnually ?? false) === (expected.occursAnnually ?? false) &&
    JSON.stringify([...(row.userIds ?? [])].sort()) === JSON.stringify([...(expected.userIds ?? [])].sort()) &&
    JSON.stringify([...(row.userGroupIds ?? [])].sort()) === JSON.stringify([...(expected.userGroupIds ?? [])].sort()) &&
    (row.everyoneIncludingNew ?? false) === ("everyoneIncludingNew" in expected ? expected.everyoneIncludingNew ?? false : false);
}

const listHolidays = defineReadAction({
  name: "clockify_holidays_list",
  ...HOLIDAY_API_METADATA.clockify_holidays_list,
  description: "List the workspace holidays.",
  group: TOA,
  schema: z.object({}),
  async handler(ctx) {
    const { rows, truncated } = await ctx.clockify.listHolidays();
    return listReceipt({
      action: "clockify_holidays_list",
      entity: "holiday",
      ids: { workspaceId: ctx.workspaceId },
      rows,
      truncated,
    });
  },
});

const getHoliday = defineAction({
  name: "clockify_holidays_get",
  ...HOLIDAY_API_METADATA.clockify_holidays_get,
  description: "Fetch a single holiday by id, or by its exact `name` (resolved server-side).",
  featureGroup: TOA,
  risks: ["read"],
  schema: z
    .object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
    .refine((v) => v.id !== undefined || v.name !== undefined, {
      message: "Provide the holiday id or its exact name.",
    }),
  async handler(ctx, args) {
    const resolved = await resolveEntityRef(args, {
      noun: "holiday",
      verb: "fetch",
      list: () => ctx.clockify.listHolidays(),
    });
    if (!resolved.ok) return clarifyResult(resolved.clarify);
    const entity = await ctx.clockify.getHoliday(resolved.id);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_holidays_get",
        entity: "holiday",
        ids: { workspaceId: ctx.workspaceId },
        data: { entity },
      }),
    };
  },
});

const listInPeriod = defineAction({
  name: "clockify_holidays_in_period",
  ...HOLIDAY_API_METADATA.clockify_holidays_in_period,
  description:
    "List holidays assigned to a user across a date period (defaults to you; `assignedTo` accepts a user id, exact name, or 'me'). `start`/`end` accept YYYY-MM-DD or a relative day/period (today, next month…), resolved server-side.",
  featureGroup: TOA,
  risks: ["read"],
  schema: z.object({ assignedTo: z.string().optional(), start: z.string().min(1), end: z.string().min(1) }),
  async handler(ctx, args) {
    // The user slot resolves id/name/'me' (the user-sweep missed this one);
    // the dates resolve server-side — a relative word must never reach the wire.
    const user = await resolveUserFilter(args.assignedTo, {
      verb: "list holidays for",
      adminUserId: ctx.adminUserId,
      listUsers: () => ctx.clockify.listUsers(),
      defaultTo: ctx.adminUserId,
    });
    if (!user.ok) return clarifyResult(user.clarify, "assignedTo");
    const dates = resolveDateRange(nowDate(ctx), {
      start: { raw: args.start },
      end: { raw: args.end },
      exampleHint: "today, next monday, or next month",
      timeZone: ctx.timeZone,
    });
    if (!dates.ok) return { kind: "clarify", message: dates.message };
    // The schema requires both edges; this also guards a whitespace-only value.
    if (dates.start === undefined || dates.end === undefined) {
      return {
        kind: "clarify",
        message:
          "I couldn't make sense of the date — give me a calendar date (YYYY-MM-DD) or something like today, next monday, or next month.",
      };
    }
    const { rows, truncated } = await ctx.clockify.listHolidaysInPeriod({ assignedTo: user.userId, start: dates.start, end: dates.end });
    return {
      kind: "receipt",
      receipt: listReceipt({
        action: "clockify_holidays_in_period",
        entity: "holiday",
        ids: { workspaceId: ctx.workspaceId },
        rows,
        truncated,
      }),
    };
  },
});

const createHoliday = defineDurableSafeWriteAction({
  name: "clockify_holidays_create",
  ...HOLIDAY_API_METADATA.clockify_holidays_create,
  description:
    "Create a workspace holiday. Assign it with up to 8 `userIds` and/or 8 `userGroupIds` — each entry is an id, an exact name, or 'me' (groups by id or exact name); the harness resolves names server-side and clarifies on an unknown one. Safe write — executes immediately when policy allows. Requires at least one user or user group assignment.",
  group: TOA,
  stepName: "Create holiday",
  mutationContract: holidayCreateContract,
  semanticLiteralAliases: HOLIDAY_RECURRENCE_LITERAL_ALIASES,
  schema: z
    .object({
      name: z.string().min(1),
      startDate: z.string().min(1), // YYYY-MM-DD
      endDate: z.string().optional(),
      occursAnnually: z.boolean().optional(),
      userIds: zStringList(z.array(z.string().min(1)).max(HOLIDAY_SCOPE_USER_BATCH_MAX)).optional(),
      userGroupIds: zStringList(z.array(z.string().min(1)).max(HOLIDAY_SCOPE_GROUP_BATCH_MAX)).optional(),
    })
    .refine((v) => (v.userIds?.length ?? 0) > 0 || (v.userGroupIds?.length ?? 0) > 0, {
      message: "A holiday needs at least one userIds or userGroupIds assignment.",
    }),
  async prepare(ctx, args) {
    const assign = await resolveScopeRefs(ctx, args, { verb: "assign the holiday to" });
    if (!assign.ok) {
      return {
        kind: "clarify" as const,
        clarify: assign.clarify.clarify,
        ...(assign.clarify.options ? { options: assign.clarify.options } : {}),
      };
    }
    // Dates server-side (CLAUDE.md invariant): the model never computes calendar
    // dates. Resolve relative/absolute days to a real YYYY-MM-DD; an unparseable
    // value clarifies rather than fabricating a date the wire would reject.
    const dates = resolveHolidayDates(ctx, args.startDate, args.endDate);
    if (!dates.ok) {
      return {
        kind: "clarify" as const,
        clarify: dates.clarify.clarify,
        ...(dates.clarify.options ? { options: dates.clarify.options } : {}),
      };
    }
    if (dates.startDate === undefined) {
      // The schema requires startDate; this also guards a whitespace-only value.
      return { kind: "clarify" as const, clarify: 'A holiday needs a start date like 2026-12-25 or "next monday".' };
    }
    const baseline = await ctx.clockify.listHolidays();
    if (baseline.truncated) return { kind: "clarify" as const, clarify: "Clockify returned an incomplete holiday baseline. Retry after it can be read completely." };
    return {
      operation: {
        body: {
          name: args.name,
          startDate: dates.startDate,
          ...(dates.endDate !== undefined ? { endDate: dates.endDate } : {}),
          ...(args.occursAnnually !== undefined ? { occursAnnually: args.occursAnnually } : {}),
          ...(assign.userIds?.length ? { userIds: assign.userIds } : {}),
          ...(assign.userGroupIds?.length ? { userGroupIds: assign.userGroupIds } : {}),
        },
        baselineIds: baseline.rows.map((row) => row.id),
      },
      mutationPlan: {
        mode: "single" as const,
        steps: [{ id: "create-holiday", kind: "primary" as const, reconciliationStrategy: "create" as const }],
      },
    };
  },
  async dispatch(ctx, operation) {
    const { body, baselineIds } = operation as { body: CreateHolidayInput; baselineIds: string[] };
    const dispatch = await dispatchWithReconciliation({
      dispatch: () => ctx.clockify.createHolidayAtomic(body),
      reconcile: () => reconcileCreate({ beforeIds: baselineIds, list: () => ctx.clockify.listHolidays(), matches: (row) => sameHoliday(row, body) }),
    });
    const holiday = dispatch.value;
    const created = { type: "holiday", id: holiday.id, name: holiday.name };
    return {
      result: successReceipt({
        action: "clockify_holidays_create",
        entity: "holiday",
        ids: { workspaceId: ctx.workspaceId },
        changed: { created: [created] },
      }),
      externalId: holiday.id,
      effect: { created },
      detail: { reconciled: dispatch.reconciled },
    };
  },
});

const updateHoliday = defineRiskyAction({
  name: "clockify_holidays_update",
  ...HOLIDAY_API_METADATA.clockify_holidays_update,
  description:
    "Update a workspace holiday (name, dates, recurrence, or who it applies to). Up to 8 `userIds` and/or 8 `userGroupIds` entries may be ids, exact names, or 'me' — resolved server-side, clarifies on an unknown one. Editing overwrites live workspace data, so it previews and requires confirmation.",
  group: TOA,
  // Editing an existing holiday overwrites live data for everyone assigned and has no
  // undo — same class as every other *_update, so preview→button-confirm (was wrongly
  // shipping as safe_write / immediate; enterprise-audit safety fix).
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: holidayTargetContract("update"),
  semanticLiteralAliases: HOLIDAY_RECURRENCE_LITERAL_ALIASES,
  schema: z
    .object({
      id: z.string().min(1),
      name: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      occursAnnually: z.boolean().optional(),
      userIds: zStringList(z.array(z.string().min(1)).max(HOLIDAY_SCOPE_USER_BATCH_MAX)).optional(),
      userGroupIds: zStringList(z.array(z.string().min(1)).max(HOLIDAY_SCOPE_GROUP_BATCH_MAX)).optional(),
    })
    .refine(
      (v) =>
        v.name !== undefined ||
        v.startDate !== undefined ||
        v.endDate !== undefined ||
        v.occursAnnually !== undefined ||
        v.userIds !== undefined ||
        v.userGroupIds !== undefined,
      { message: "Provide at least one field to change." },
    ),
  async preview(ctx, args) {
    const assign = await resolveScopeRefs(ctx, args, { verb: "assign the holiday to" });
    if (!assign.ok) return assign.clarify;
    // Dates server-side: resolve a relative/absolute change to a real day; an
    // unparseable value clarifies (never reaches the wire as-is).
    const dates = resolveHolidayDates(ctx, args.startDate, args.endDate);
    if (!dates.ok) return dates.clarify;
    const { id, userIds: _userIds, userGroupIds: _userGroupIds, startDate: _startDate, endDate: _endDate, ...rest } = args;
    const body: Record<string, unknown> = {
      ...rest,
      ...(dates.startDate !== undefined ? { startDate: dates.startDate } : {}),
      ...(dates.endDate !== undefined ? { endDate: dates.endDate } : {}),
      ...(assign.userIds?.length ? { userIds: assign.userIds } : {}),
      ...(assign.userGroupIds?.length ? { userGroupIds: assign.userGroupIds } : {}),
    };
    const changes: string[] = [];
    if (rest.name !== undefined) changes.push(`Rename to "${rest.name}"`);
    if (dates.startDate !== undefined) changes.push(`Start date → ${dates.startDate}`);
    if (dates.endDate !== undefined) changes.push(`End date → ${dates.endDate}`);
    if (rest.occursAnnually !== undefined) changes.push(`Recurs annually → ${rest.occursAnnually}`);
    if (assign.userIds?.length || assign.userGroupIds?.length) {
      changes.push(`Reassign to ${assign.userIds?.length ?? 0} user(s) + ${assign.userGroupIds?.length ?? 0} group(s)`);
    }
    let updateBody: Awaited<ReturnType<typeof ctx.clockify.prepareHolidayUpdate>>;
    try { updateBody = await ctx.clockify.prepareHolidayUpdate(id, body); }
    catch { return { clarify: "The current holiday could not be prepared safely. Refresh it and preview again." }; }
    const target = captureTargetSnapshot("target", { type: "holiday", id, name: updateBody.source.name }, updateBody.source);
    return {
      actionLabel: "Update holiday",
      targets: [{ type: "holiday", id, ...(args.name !== undefined ? { name: args.name } : {}) }],
      expectedChanges: changes.length ? changes : ["Update holiday"],
      reversibility: "Editing overwrites the holiday's current values; there is no undo.",
      warnings: ["This affects everyone assigned to the holiday."],
      payload: { id, body, updateBody },
      targetSnapshots: [target],
      mutationPlan: { mode: "single", steps: [{ id: "update-holiday", kind: "primary", targetFingerprint: target.fingerprint, reconciliationStrategy: "update" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { id, updateBody } = payload as { id: string; updateBody: Awaited<ReturnType<typeof ctx.clockify.prepareHolidayUpdate>> };
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "update-holiday", name: "Update holiday",
      verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (snapshot) => fetchHolidaySnapshot(ctx, snapshot) },
      dispatch: async () => {
        const result = await dispatchWithReconciliation({ dispatch: () => ctx.clockify.updateHolidayAtomic(id, updateBody), reconcile: async () => { const row = await ctx.clockify.getHoliday(id); return row && sameHoliday(row, updateBody) ? row : undefined; } });
        const holiday = result.value;
        return { externalId: holiday.id, effect: { updated: { type: "holiday", id: holiday.id, name: holiday.name } }, detail: { reconciled: result.reconciled } };
      },
      success: (step) => successReceipt({ action: "clockify_holidays_update", entity: "holiday", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "holiday", id: step.externalId ?? id }] } }),
    });
  },
});

const deleteHoliday = defineRiskyAction({
  name: "clockify_holidays_delete",
  ...HOLIDAY_API_METADATA.clockify_holidays_delete,
  description: "Delete a workspace holiday. Destructive — previews and requires confirmation.",
  group: TOA,
  risks: ["destructive"],
  mutationWorkflow: "durable",
  mutationContract: holidayTargetContract("delete"),
  schema: z.object({ id: z.string().min(1), name: z.string().optional() }),
  async preview(ctx, args) {
    const target = await holidaySnapshot(ctx, args.id);
    if (!target) return { clarify: `Holiday ${args.id} could not be verified.` };
    return {
      actionLabel: "Delete holiday",
      targets: [{ type: "holiday", id: args.id, ...(args.name !== undefined ? { name: args.name } : {}) }],
      expectedChanges: [`Delete holiday ${args.name ?? args.id}`],
      reversibility: "This cannot be undone.",
      warnings: ["Deleting a holiday affects everyone assigned to it."],
      payload: { id: args.id, ...(args.name !== undefined ? { name: args.name } : {}) },
      targetSnapshots: [target],
      mutationPlan: { mode: "single", steps: [{ id: "delete-holiday", kind: "primary", targetFingerprint: target.fingerprint, reconciliationStrategy: "delete" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { id, name } = payload as { id: string; name?: string };
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "delete-holiday", name: "Delete holiday",
      verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (snapshot) => fetchHolidaySnapshot(ctx, snapshot) },
      dispatch: async () => {
        const result = await dispatchWithReconciliation({ dispatch: async () => { await ctx.clockify.deleteHolidayAtomic(id); return true as const; }, reconcile: () => reconcileDelete(() => ctx.clockify.getHoliday(id)) });
        return { effect: { deleted: { type: "holiday", id, name } }, detail: { reconciled: result.reconciled } };
      },
      success: () => successReceipt({ action: "clockify_holidays_delete", entity: "holiday", ids: { workspaceId: ctx.workspaceId }, changed: { deleted: [{ type: "holiday", id, name }] } }),
    });
  },
});

export const HOLIDAY_ACTIONS: ActionDefinition[] = [
  listHolidays,
  getHoliday,
  listInPeriod,
  createHoliday,
  updateHoliday,
  deleteHoliday,
];
