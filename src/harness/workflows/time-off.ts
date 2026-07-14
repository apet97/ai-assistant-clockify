import { z } from "zod";
import { zNumberLike, zStringList } from "../arg-shapes.js";
import {
  clarifyResult,
  defineAction,
  defineReadAction,
  defineRiskyAction,
  type ActionDefinition,
} from "../action.js";
import { nowDate } from "../../durations.js";
import { successReceipt } from "../receipts.js";
import { describePatch, resolveEntityRef, resolvePeriod, resolveRelativeDay, resolveScopeRefs, resolveUserFilter, resolveUserRefs, zonedDayTimeInstant } from "./resolve.js";

/** Step a YYYY-MM-DD day forward by n calendar days. */
function addCalendarDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Sat/Sun are not workdays. */
function isWorkday(day: string): boolean {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6;
}

/** The first workday on or after `day`. */
function nextWorkday(day: string): string {
  let d = day;
  while (!isWorkday(d)) d = addCalendarDays(d, 1);
  return d;
}

/** The day reached after `extra` additional workdays beyond `day` (weekends skipped). */
function addWorkdays(day: string, extra: number): string {
  let d = day;
  for (let i = 0; i < extra; i += 1) d = nextWorkday(addCalendarDays(d, 1));
  return d;
}

/**
 * Typed time-off workflows (goclmcp §2.9 — policies, requests, balances). Reads
 * execute immediately; writes run preview→commit. Risk classes: policy
 * create/update + balance update = `high_risk_write`; policy archive + request
 * delete = `destructive`; request create + approve/deny = `external_side_effect`
 * (they notify the requester/approver). All gated by `time_off_approvals` — these
 * are real Clockify writes, so they use high_risk_write / external_side_effect
 * (both keep the policy gate), NEVER `permission_change` (which would bypass it).
 * Approve/deny supersede the generic `clockify_manage_time_off`.
 */

const TOA = "time_off_approvals" as const;

// ── Policies ────────────────────────────────────────────────────────────────

const listPolicies = defineReadAction({
  name: "clockify_time_off_policies_list",
  description: "List time-off policies.",
  group: TOA,
  schema: z.object({}),
  async handler(ctx) {
    const items = await ctx.clockify.listTimeOffPolicies();
    return successReceipt({
      action: "clockify_time_off_policies_list",
      entity: "time_off_policy",
      ids: { workspaceId: ctx.workspaceId },
      data: { count: items.length, items },
    });
  },
});

const getPolicy = defineAction({
  name: "clockify_time_off_policies_get",
  description: "Fetch a single time-off policy by id, or by its exact `name` (resolved server-side).",
  featureGroup: TOA,
  risks: ["read"],
  schema: z
    .object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
    .refine((v) => v.id !== undefined || v.name !== undefined, {
      message: "Provide the policy id or its exact name.",
    }),
  async handler(ctx, args) {
    const resolved = await resolveEntityRef(args, {
      noun: "time-off policy",
      verb: "fetch",
      list: () => ctx.clockify.listTimeOffPolicies(),
    });
    if (!resolved.ok) return clarifyResult(resolved.clarify);
    const entity = await ctx.clockify.getTimeOffPolicy(resolved.id);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_time_off_policies_get",
        entity: "time_off_policy",
        ids: { workspaceId: ctx.workspaceId },
        data: { entity },
      }),
    };
  },
});

const createPolicy = defineRiskyAction({
  name: "clockify_time_off_policies_create",
  description:
    "Create a time-off policy. Scope it with `userIds` and/or `userGroupIds` — each entry an id, exact name, or 'me' (groups by id/exact name), resolved server-side, clarifies on an unknown one; defaults to just you when neither is given. Elevated write — previews and requires confirmation.",
  group: TOA,
  risks: ["high_risk_write"],
  schema: z.object({
    name: z.string().min(1),
    requiresApproval: z.boolean().optional(),
    daysPerYear: zNumberLike(z.number().nonnegative()).optional(),
    negativeBalance: z.boolean().optional(),
    userIds: zStringList().optional(),
    userGroupIds: zStringList().optional(),
  }),
  async preview(ctx, args) {
    const scope = await resolveScopeRefs(ctx, args, { verb: "scope the policy to" });
    if (!scope.ok) return scope.clarify;
    const input = {
      name: args.name,
      ...(args.requiresApproval !== undefined ? { requiresApproval: args.requiresApproval } : {}),
      ...(args.daysPerYear !== undefined ? { daysPerYear: args.daysPerYear } : {}),
      ...(args.negativeBalance !== undefined ? { negativeBalance: args.negativeBalance } : {}),
      ...(scope.userIds?.length ? { userIds: scope.userIds } : {}),
      ...(scope.userGroupIds?.length ? { userGroupIds: scope.userGroupIds } : {}),
    };
    return {
      actionLabel: "Create time-off policy",
      targets: [],
      expectedChanges: [`Create time-off policy "${args.name}" (scoped to ${scope.labels.length ? scope.labels.join(", ") : "you"})`],
      reversibility: "You can archive the policy afterward.",
      warnings: ["This adds a time-off policy to the workspace."],
      payload: { input },
    };
  },
  async commit(ctx, payload) {
    const { input } = payload as { input: { name: string; requiresApproval?: boolean; daysPerYear?: number; negativeBalance?: boolean; userIds?: string[]; userGroupIds?: string[] } };
    const policy = await ctx.clockify.createTimeOffPolicy({ ...input, userId: ctx.adminUserId });
    return successReceipt({
      action: "clockify_time_off_policies_create",
      entity: "time_off_policy",
      ids: { workspaceId: ctx.workspaceId },
      changed: { created: [{ type: "time_off_policy", id: policy.id, name: policy.name }] },
    });
  },
});

const updatePolicy = defineRiskyAction({
  name: "clockify_time_off_policies_update",
  description:
    "Update a time-off policy (name / approval / days per year) or re-scope it with `userIds`/`userGroupIds` (ids, exact names, or 'me'; resolved server-side, clarifies on an unknown one). Elevated write — previews and requires confirmation.",
  group: TOA,
  risks: ["high_risk_write"],
  schema: z
    .object({
      id: z.string().min(1),
      name: z.string().optional(),
      requiresApproval: z.boolean().optional(),
      daysPerYear: zNumberLike(z.number().nonnegative()).optional(),
      userIds: zStringList().optional(),
      userGroupIds: zStringList().optional(),
    })
    .refine(
      (v) =>
        v.name !== undefined ||
        v.requiresApproval !== undefined ||
        v.daysPerYear !== undefined ||
        v.userIds !== undefined ||
        v.userGroupIds !== undefined,
      { message: "Provide at least one field to change." },
    ),
  async preview(ctx, args) {
    const scope = await resolveScopeRefs(ctx, args, { verb: "scope the policy to" });
    if (!scope.ok) return scope.clarify;
    const patch = {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.requiresApproval !== undefined ? { requiresApproval: args.requiresApproval } : {}),
      ...(args.daysPerYear !== undefined ? { daysPerYear: args.daysPerYear } : {}),
      ...(scope.userIds?.length ? { userIds: scope.userIds } : {}),
      ...(scope.userGroupIds?.length ? { userGroupIds: scope.userGroupIds } : {}),
    };
    const changes = describePatch({
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.requiresApproval !== undefined ? { requiresApproval: args.requiresApproval } : {}),
      ...(args.daysPerYear !== undefined ? { daysPerYear: args.daysPerYear } : {}),
    });
    if (scope.labels.length) changes.push(`scope policy to ${scope.labels.join(", ")}`);
    return {
      actionLabel: "Update time-off policy",
      targets: [{ type: "time_off_policy", id: args.id, ...(args.name !== undefined ? { name: args.name } : {}) }],
      expectedChanges: changes,
      reversibility: "You can update the policy again to revert most fields.",
      warnings: ["This changes a workspace time-off policy."],
      payload: { id: args.id, patch },
    };
  },
  async commit(ctx, payload) {
    const { id, patch } = payload as { id: string; patch: { name?: string; requiresApproval?: boolean; daysPerYear?: number; userIds?: string[]; userGroupIds?: string[] } };
    const updated = await ctx.clockify.updateTimeOffPolicy(id, patch);
    return successReceipt({
      action: "clockify_time_off_policies_update",
      entity: "time_off_policy",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "time_off_policy", id: updated.id, name: updated.name }] },
    });
  },
});

const archivePolicy = defineRiskyAction({
  name: "clockify_time_off_policies_archive",
  description:
    "Archive (or unarchive) a time-off policy. Destructive — previews and requires confirmation.",
  group: TOA,
  risks: ["destructive"],
  schema: z.object({ id: z.string().min(1), name: z.string().optional(), archived: z.boolean().default(true) }),
  async preview(_ctx, args) {
    return {
      actionLabel: args.archived ? "Archive time-off policy" : "Unarchive time-off policy",
      targets: [{ type: "time_off_policy", id: args.id, ...(args.name !== undefined ? { name: args.name } : {}) }],
      expectedChanges: [`${args.archived ? "Archive" : "Unarchive"} policy ${args.name ?? args.id}`],
      reversibility: "You can unarchive the policy to restore it.",
      warnings: [
        args.archived
          ? "Archiving a policy stops new requests against it."
          : "Unarchiving re-enables new requests against this policy.",
      ],
      payload: { id: args.id, name: args.name, archived: args.archived },
    };
  },
  async commit(ctx, payload) {
    const { id, name, archived } = payload as { id: string; name?: string; archived: boolean };
    await ctx.clockify.archiveTimeOffPolicy(id, archived);
    return successReceipt({
      action: "clockify_time_off_policies_archive",
      entity: "time_off_policy",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "time_off_policy", id, name }] },
    });
  },
});

// ── Requests ────────────────────────────────────────────────────────────────

const listRequests = defineAction({
  name: "clockify_time_off_requests_list",
  description:
    "List time-off requests (optional status / user filter; `userId` accepts a user id, exact name, or 'me').",
  featureGroup: TOA,
  risks: ["read"],
  schema: z.object({ status: z.string().optional(), userId: z.string().optional() }),
  async handler(ctx, args) {
    // The user filter resolves id/name/'me'; absent = all users (no default).
    const user = await resolveUserFilter(args.userId, {
      verb: "list time-off requests for",
      adminUserId: ctx.adminUserId,
      listUsers: () => ctx.clockify.listUsers(),
    });
    if (!user.ok) return clarifyResult(user.clarify);
    const items = await ctx.clockify.listTimeOffRequests({ status: args.status, userId: user.userId });
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_time_off_requests_list",
        entity: "time_off_request",
        ids: { workspaceId: ctx.workspaceId },
        data: { count: items.length, items },
      }),
    };
  },
});

const getRequest = defineReadAction({
  name: "clockify_time_off_requests_get",
  description: "Fetch a single time-off request by id.",
  group: TOA,
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const entity = await ctx.clockify.getTimeOffRequest(args.id);
    return successReceipt({
      action: "clockify_time_off_requests_get",
      entity: "time_off_request",
      ids: { workspaceId: ctx.workspaceId },
      data: { entity },
    });
  },
});

const createRequest = defineRiskyAction({
  name: "clockify_time_off_requests_create",
  description:
    "Submit a time-off request under a policy — pass `policyId` or the exact `policyName` (resolved server-side; do NOT list policies first — an unknown name clarifies with the real options). `start`/`end` accept YYYY-MM-DD or a relative day (tomorrow/next monday…). For 'N days off next/this week' you do NOT need exact dates — pass `days` + `week` and the harness picks the first N workdays (shown in the preview). Never ask which days when a week was given. For an HOUR-based policy, pass the day in `start` plus `hours` (the harness builds the hour window). External side effect (notifies approvers) — previews and requires confirmation.",
  group: TOA,
  risks: ["external_side_effect"],
  schema: z
    .object({
      policyId: z.string().min(1).optional(),
      /** The policy's exact name, resolved to an id server-side. */
      policyName: z.string().min(1).optional(),
      start: z.string().min(1).optional(),
      end: z.string().min(1).optional(),
      /** 'N days off next week' — the harness anchors to the first N workdays. */
      week: z.enum(["this_week", "next_week"]).optional(),
      days: zNumberLike(z.number().positive()).optional(),
      /** For HOUR-based policies: the number of hours off on `start` (the day). */
      hours: zNumberLike(z.number().positive()).optional(),
      halfDay: z.boolean().optional(),
      note: z.string().optional(),
    })
    .refine((v) => v.policyId !== undefined || v.policyName !== undefined, {
      message: "Provide the time-off policy id or its exact name.",
    })
    .refine(
      (v) =>
        (v.start !== undefined && v.end !== undefined) ||
        v.week !== undefined ||
        (v.start !== undefined && v.hours !== undefined),
      {
        message:
          "Provide start+end dates, a week ('this_week'/'next_week') with days, or — for an hour-based policy — a start day + hours.",
      },
    ),
  async preview(ctx, args) {
    // List ONCE; reuse the list for resolution AND the timeUnit read so a time-off
    // request preview makes a single policies round-trip (PERF-01). The policy ref
    // resolves by name in either slot (balance_update precedent) — a bogus policy
    // clarifies with the real list, never a doomed commit.
    const policies = await ctx.clockify.listTimeOffPolicies();
    const policy = await resolveEntityRef(
      { id: args.policyId, name: args.policyName },
      { noun: "time-off policy", verb: "request time off under", list: () => Promise.resolve(policies) },
    );
    if (!policy.ok) return policy.clarify;
    const now = nowDate(ctx);
    // Time-off request bodies are policy-unit-specific: the DAYS path below builds
    // `period.days` from bare dates; an HOURS policy wants ISO datetime instants
    // (live-verified). Read the unit from the already-fetched list — an unknown
    // unit falls through to the DAYS path, exactly as before.
    const policyUnit = policies.find((p) => p.id === policy.id)?.timeUnit;
    if (policyUnit === "HOURS") {
      // HOURS request = a server-resolved DAY + a number of hours (the model never
      // computes calendar dates). Build 09:00 → 09:00+N ISO instants for the wire.
      const day = resolveRelativeDay(now, { date: args.start }, ctx.timeZone);
      if (day === undefined) {
        return {
          clarify: `For the hour-based policy "${policy.name ?? policy.id}", tell me the day (e.g. "next monday" or 2026-07-06) and how many hours.`,
        };
      }
      const hours = args.hours;
      if (hours === undefined || hours <= 0) {
        return { clarify: `How many hours of time off on ${day} under "${policy.name ?? policy.id}"?` };
      }
      const startInstant = zonedDayTimeInstant(day, 9, 0, ctx.timeZone ?? "UTC");
      if (startInstant === undefined) {
        return { clarify: `I couldn't resolve 09:00 on ${day} in the workspace time zone.` };
      }
      const startMs = Date.parse(startInstant);
      const isoNoMillis = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
      const startIso = isoNoMillis(startMs);
      const endIso = isoNoMillis(startMs + hours * 3_600_000);
      const warnings = ["This submits a request that notifies approvers."];
      try {
        const balances = await ctx.clockify.getTimeOffBalance(ctx.adminUserId);
        const bal = balances.find((b) => b.policyId === policy.id)?.balance;
        if (bal !== undefined && hours > bal) {
          warnings.push(`This requests ${hours}h but the policy balance is ${bal}h — Clockify will likely reject it.`);
        }
      } catch {
        // Balance unavailable — submit anyway; Clockify itself remains the gate.
      }
      return {
        actionLabel: "Request time off",
        targets: [],
        expectedChanges: [`Request ${hours}h off on ${day} under "${policy.name ?? policy.id}"`],
        reversibility: "Cancel or have the request denied in Clockify.",
        warnings,
        payload: {
          policyId: policy.id,
          input: { start: startIso, end: endIso, timeUnit: "HOURS", ...(args.note !== undefined ? { note: args.note } : {}) },
        },
      };
    }
    if (policyUnit !== undefined && policyUnit !== "DAYS") {
      const unit = policyUnit.toLowerCase();
      return {
        clarify: `The policy "${policy.name ?? policy.id}" is measured in ${unit}, which isn't supported here yet — please submit it directly in Clockify.`,
      };
    }
    // 'N days next week' anchors deterministically to the first N WORKDAYS of
    // that week (the resolveLogTimes pattern: the harness defaults, the preview
    // shows the chosen dates, the admin confirms). Explicit start/end wins.
    let startRef = args.start;
    let endRef = args.end;
    if ((startRef === undefined || endRef === undefined) && args.week) {
      const dayCount = Math.max(1, Math.round(args.days ?? 1));
      const monday = resolvePeriod(now, args.week, ctx.timeZone, ctx.weekStartsOn).dateRangeStart.slice(0, 10);
      const today = resolveRelativeDay(now, { date: "today" }, ctx.timeZone) ?? now.toISOString().slice(0, 10);
      const anchor = nextWorkday(args.week === "this_week" && today > monday ? today : monday);
      if (args.week === "this_week" && anchor > addCalendarDays(monday, 6)) {
        return {
          clarify: "There are no workdays left this week — should I request the days for next week instead?",
        };
      }
      startRef = anchor;
      endRef = addWorkdays(anchor, dayCount - 1);
    }
    // The wire wants bare YYYY-MM-DD days; the live loop sent the literal
    // string "next Monday". Resolve here, clarify on anything unparseable.
    const start = resolveRelativeDay(now, { date: startRef }, ctx.timeZone);
    const end = resolveRelativeDay(now, { date: endRef }, ctx.timeZone);
    const bad = [start === undefined ? startRef : undefined, end === undefined ? endRef : undefined].filter(
      (value): value is string => value !== undefined,
    );
    if (bad.length || start === undefined || end === undefined) {
      return {
        clarify: `I couldn't make sense of the date${bad.length > 1 ? "s" : ""} ${bad.map((b) => `"${b}"`).join(" and ")} — give me a calendar date (YYYY-MM-DD) or something like tomorrow or next monday.`,
      };
    }
    if (start > end) {
      return { clarify: "The time-off start date must be on or before the end date." };
    }
    const input = {
      start,
      end,
      ...(args.days !== undefined ? { days: args.days } : {}),
      ...(args.halfDay !== undefined ? { halfDay: args.halfDay } : {}),
      ...(args.note !== undefined ? { note: args.note } : {}),
    };
    // Surface a short balance before confirm: Clockify rejects an over-balance
    // request with the misleading "Value for number of days is not allowed", so
    // the constraint must be visible in the PREVIEW (Phase 4 discipline). The
    // balance read is best-effort — a failure never blocks the request.
    const requestedDays =
      args.days ??
      (args.halfDay ? 0.5 : Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1);
    const warnings = ["This submits a request that notifies approvers."];
    try {
      const balances = await ctx.clockify.getTimeOffBalance(ctx.adminUserId);
      const policyBalance = balances.find((b) => b.policyId === policy.id)?.balance;
      if (policyBalance !== undefined && requestedDays > policyBalance) {
        warnings.push(
          `This requests ${requestedDays} day(s) but the policy balance is ${policyBalance} — Clockify will likely reject it (its error reads "Value for number of days is not allowed"). Top up the balance or shorten the request.`,
        );
      }
    } catch {
      // Balance unavailable — submit as before; Clockify itself remains the gate.
    }
    // Truthful preview: state how many days will be DEDUCTED (the wire `days`),
    // not just the calendar range — they can differ (an explicit days override, or
    // a half day). What the admin confirms must equal what Clockify charges.
    const dayCountLabel = args.halfDay
      ? "a half day"
      : `${requestedDays} day${requestedDays === 1 ? "" : "s"}`;
    return {
      actionLabel: "Submit time-off request",
      targets: [{ type: "time_off_policy", id: policy.id, name: policy.name }],
      expectedChanges: [`Request ${dayCountLabel} off ${start} → ${end} under policy ${policy.name ?? policy.id}`],
      reversibility: "You can delete the request afterward.",
      warnings,
      payload: { policyId: policy.id, input },
    };
  },
  async commit(ctx, payload) {
    const { policyId, input } = payload as { policyId: string; input: Parameters<typeof ctx.clockify.createTimeOffRequest>[1] };
    const req = await ctx.clockify.createTimeOffRequest(policyId, input);
    return successReceipt({
      action: "clockify_time_off_requests_create",
      entity: "time_off_request",
      ids: { workspaceId: ctx.workspaceId },
      changed: { created: [{ type: "time_off_request", id: req.id }] },
    });
  },
});

const deleteRequest = defineRiskyAction({
  name: "clockify_time_off_requests_delete",
  description: "Delete a time-off request. Destructive — previews and requires confirmation.",
  group: TOA,
  risks: ["destructive"],
  schema: z.object({ policyId: z.string().min(1), requestId: z.string().min(1) }),
  async preview(_ctx, args) {
    return {
      actionLabel: "Delete time-off request",
      targets: [{ type: "time_off_request", id: args.requestId }],
      expectedChanges: [`Delete time-off request ${args.requestId}`],
      reversibility: "This cannot be undone.",
      warnings: ["Deleting a time-off request is permanent."],
      payload: { policyId: args.policyId, requestId: args.requestId },
    };
  },
  async commit(ctx, payload) {
    const { policyId, requestId } = payload as { policyId: string; requestId: string };
    await ctx.clockify.deleteTimeOffRequest(policyId, requestId);
    return successReceipt({
      action: "clockify_time_off_requests_delete",
      entity: "time_off_request",
      ids: { workspaceId: ctx.workspaceId },
      changed: { deleted: [{ type: "time_off_request", id: requestId }] },
    });
  },
});

/** Build an approve/deny action (both PATCH the request status; supersede manage_time_off). */
function decisionAction(decision: "approve" | "deny"): ActionDefinition {
  const statusType = decision === "approve" ? "APPROVED" : "REJECTED";
  return defineRiskyAction({
    name: `clockify_time_off_${decision}`,
    description: `${decision === "approve" ? "Approve" : "Deny"} a time-off request. External side effect (notifies the requester) — previews and requires confirmation.`,
    group: TOA,
    risks: ["external_side_effect"],
    schema: z.object({ policyId: z.string().min(1), requestId: z.string().min(1), note: z.string().optional() }),
    async preview(_ctx, args) {
      return {
        actionLabel: `${decision} time-off request`,
        targets: [{ type: "time_off_request", id: args.requestId }],
        expectedChanges: [`${decision} time-off request ${args.requestId} (policy ${args.policyId})`],
        reversibility: "Approval decisions notify the requester and may be hard to reverse.",
        warnings: ["This notifies the requester and changes their balance/schedule."],
        payload: { policyId: args.policyId, requestId: args.requestId, note: args.note },
      };
    },
    async commit(ctx, payload) {
      const { policyId, requestId, note } = payload as { policyId: string; requestId: string; note?: string };
      const result = await ctx.clockify.setTimeOffRequestStatus(policyId, requestId, statusType, note);
      return successReceipt({
        action: `clockify_time_off_${decision}`,
        entity: "time_off_request",
        ids: { workspaceId: ctx.workspaceId },
        changed: { updated: [{ type: "time_off_request", id: result.id, name: result.name }] },
      });
    },
  });
}

const approveRequest = decisionAction("approve");
const denyRequest = decisionAction("deny");

// ── Balances ────────────────────────────────────────────────────────────────

const getBalance = defineAction({
  name: "clockify_time_off_balance_get",
  description: "Get a user's time-off balances (defaults to you; `userId` accepts a user id, exact name, or 'me').",
  featureGroup: TOA,
  risks: ["read"],
  schema: z.object({ userId: z.string().optional() }),
  async handler(ctx, args) {
    const user = await resolveUserFilter(args.userId, {
      verb: "get the time-off balance for",
      adminUserId: ctx.adminUserId,
      listUsers: () => ctx.clockify.listUsers(),
      defaultTo: ctx.adminUserId,
    });
    if (!user.ok) return clarifyResult(user.clarify);
    const items = await ctx.clockify.getTimeOffBalance(user.userId);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_time_off_balance_get",
        entity: "time_off_balance",
        ids: { workspaceId: ctx.workspaceId },
        data: { count: items.length, items },
      }),
    };
  },
});

const updateBalance = defineRiskyAction({
  name: "clockify_time_off_balance_update",
  description:
    "Adjust users' time-off balance for a policy. Pass the policy by id or exact name, and `userIds` as ids/exact names/'me' — resolved server-side, clarifies on an unknown one. Elevated write — previews and requires confirmation.",
  group: TOA,
  risks: ["high_risk_write"],
  schema: z.object({
    policyId: z.string().min(1),
    userIds: zStringList(z.array(z.string().min(1)).min(1)),
    value: zNumberLike(z.number()),
    note: z.string().optional(),
  }),
  async preview(ctx, args) {
    const policy = await resolveEntityRef(
      { id: args.policyId },
      { noun: "time-off policy", verb: "adjust the balance on", list: () => ctx.clockify.listTimeOffPolicies() },
    );
    if (!policy.ok) return policy.clarify;
    const members = await resolveUserRefs(args.userIds, {
      verb: "adjust the balance for",
      adminUserId: ctx.adminUserId,
      listUsers: () => ctx.clockify.listUsers(),
      verifyIds: true,
    });
    if (!members.ok) return members.clarify;
    return {
      actionLabel: "Adjust time-off balance",
      targets: [{ type: "time_off_policy", id: policy.id, name: policy.name }],
      expectedChanges: [`Adjust balance by ${args.value} for ${members.labels.join(", ")} on policy "${policy.name ?? policy.id}"`],
      reversibility: "You can adjust the balance again to revert.",
      warnings: ["This changes users' accrued time-off balance."],
      payload: { policyId: policy.id, userIds: members.userIds, value: args.value, note: args.note },
    };
  },
  async commit(ctx, payload) {
    const { policyId, userIds, value, note } = payload as { policyId: string; userIds: string[]; value: number; note?: string };
    await ctx.clockify.updateTimeOffBalance(policyId, {
      userIds,
      value,
      ...(note !== undefined ? { note } : {}),
    });
    return successReceipt({
      action: "clockify_time_off_balance_update",
      entity: "time_off_balance",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "time_off_policy", id: policyId }] },
    });
  },
});

export const TIME_OFF_ACTIONS: ActionDefinition[] = [
  listPolicies,
  getPolicy,
  createPolicy,
  updatePolicy,
  archivePolicy,
  listRequests,
  getRequest,
  createRequest,
  deleteRequest,
  approveRequest,
  denyRequest,
  getBalance,
  updateBalance,
];
