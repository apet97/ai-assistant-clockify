import { z } from "zod";
import { zStringList } from "../arg-shapes.js";
import {
  defineAction,
  defineRiskyAction,
  type ActionDefinition,
} from "../action.js";
import { successReceipt, errorReceipt } from "../receipts.js";
import { leftBehindNote, runComposition, type CompositionStep } from "../compose.js";
import { matchByName, REPORT_PERIODS, resolvePeriod } from "./resolve.js";
import { DAY_MS, nowDate } from "../../durations.js";

/**
 * Curated, intent-shaped actions (Phase 6). High-level "jobs to be done" that
 * compose primitives so the model reaches for one clear verb instead of
 * scrambling ~115 primitives — and so the harness owns the parts the model is bad
 * at (date math, multi-step ordering). Primitives remain available for power use.
 *
 * `period_report` is a read that resolves a PERIOD keyword to a date range
 * server-side. `onboard_user` is a risky job that bundles invite + group-adds into
 * ONE preview, committed atomically via the composition layer (invite required,
 * group adds best-effort).
 */

const periodReport = defineAction({
  name: "clockify_period_report",
  description:
    'Run a time report for a named PERIOD (today/yesterday/this_week/last_week/this_month/last_month/last_7_days/last_30_days/this_quarter/last_quarter/this_year/last_year) — the harness resolves the calendar dates, so you never need to know or compute them. Use this for "report for last month", "what did the team do this week". type defaults to summary.',
  featureGroup: "reports",
  risks: ["read"],
  schema: z.object({
    period: z.enum(REPORT_PERIODS).default("last_7_days"),
    type: z.enum(["summary", "detailed", "weekly"]).default("summary"),
    groups: z.array(z.enum(["PROJECT", "CLIENT", "TASK", "TAG", "USER", "DATE"])).optional(),
  }),
  async handler(ctx, args) {
    let range = resolvePeriod(nowDate(ctx), args.period);
    let weeklyClamped = false;
    if (args.type === "weekly") {
      // Clockify's weekly report REJECTS any range that isn't exactly 7 days
      // ("Please select date range of exactly 7 days") — the live loop routed a
      // month into it. Clamp to the LAST 7 calendar days of the resolved period.
      const endDay = range.dateRangeEnd.slice(0, 10);
      const startDay = new Date(Date.parse(`${endDay}T00:00:00.000Z`) - 6 * DAY_MS)
        .toISOString()
        .slice(0, 10);
      const clamped = {
        dateRangeStart: `${startDay}T00:00:00.000Z`,
        dateRangeEnd: `${endDay}T23:59:59.999Z`,
      };
      weeklyClamped = clamped.dateRangeStart !== range.dateRangeStart || clamped.dateRangeEnd !== range.dateRangeEnd;
      range = clamped;
    }
    const report =
      args.type === "detailed"
        ? await ctx.clockify.detailedReport(range)
        : args.type === "weekly"
          ? await ctx.clockify.weeklyReport(range)
          : await ctx.clockify.summaryReport(range, args.groups);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_period_report",
        entity: "report",
        ids: { workspaceId: ctx.workspaceId },
        data: { period: args.period, type: args.type, range, report },
        warnings: weeklyClamped
          ? [
              {
                code: "weekly_range_clamped",
                message: `The weekly report only accepts an exact 7-day range, so it covers the last 7 days of ${args.period} (${range.dateRangeStart.slice(0, 10)} → ${range.dateRangeEnd.slice(0, 10)}). Use type "summary" or "detailed" for the full period.`,
              },
            ]
          : undefined,
      }),
    };
  },
});

const onboardUser = defineRiskyAction({
  name: "clockify_onboard_user",
  description:
    'Onboard a teammate: invite them by email AND add them to one or more groups (by name) in one step. Use this for "invite ada@acme.com and add her to Engineering". Sends a real invitation email — previews and requires confirmation.',
  group: "users_groups",
  risks: ["external_side_effect"],
  schema: z.object({
    email: z.string().min(1),
    groups: zStringList().optional(),
    sendEmail: z.boolean().optional(),
  }),
  async preview(ctx, args) {
    const requested = args.groups ?? [];
    // Resolve group names at PREVIEW (one listGroups, like the per-area resolvers)
    // so the card matches exactly what the commit will do. A best-effort group-add
    // must never be PROMISED for a group that doesn't exist: resolvable groups go
    // into the payload as verified ids; unresolvable/ambiguous names are shown as
    // "will be skipped" instead of being silently dropped at commit time.
    const groupList = requested.length ? await ctx.clockify.listGroups() : [];
    const resolvedGroups: Array<{ id: string; name: string }> = [];
    const skipped: Array<{ name: string; reason: string }> = [];
    for (const name of requested) {
      const match = matchByName(groupList, name);
      if (match.kind === "one") resolvedGroups.push({ id: match.entity.id, name: match.entity.name });
      else skipped.push({ name, reason: match.kind === "many" ? "ambiguous" : "not found" });
    }
    return {
      actionLabel: "Onboard user",
      targets: [],
      expectedChanges: [
        `Invite ${args.email}${args.sendEmail === false ? " (without sending an email)" : ""}`,
        ...resolvedGroups.map((g) => `Add ${args.email} to group "${g.name}"`),
        ...skipped.map((s) => `Add ${args.email} to group "${s.name}" — ${s.reason}, will be skipped`),
      ],
      reversibility: "An invited user can be deactivated; group membership can be removed.",
      warnings: [
        args.sendEmail === false
          ? "The user is added without an invitation email."
          : "This sends a real invitation.",
        ...(skipped.length
          ? [`${skipped.length} group${skipped.length > 1 ? "s" : ""} couldn't be resolved and will be skipped: ${skipped.map((s) => `"${s.name}"`).join(", ")}.`]
          : []),
      ],
      payload: { email: args.email, groups: resolvedGroups, sendEmail: args.sendEmail ?? true },
    };
  },
  async commit(ctx, payload) {
    const p = payload as { email: string; groups: Array<{ id: string; name: string }>; sendEmail: boolean };
    const ids: { userId?: string } = {};
    const steps: CompositionStep[] = [
      {
        label: "invite",
        required: true,
        run: async () => {
          const user = await ctx.clockify.inviteUser(p.email, p.sendEmail);
          ids.userId = user.id;
          return { kind: "done", created: [{ type: "user", id: user.id, name: user.name }] };
        },
      },
    ];
    // Group names were resolved + shown at preview time; the payload carries only
    // verified group ids, so commit just adds to them (best-effort: a group failure
    // must not undo the required invite).
    for (const group of p.groups) {
      steps.push({
        label: `group:${group.name}`,
        required: false,
        run: async () => {
          await ctx.clockify.addUserToGroup(group.id, ids.userId as string);
          return { kind: "done" };
        },
      });
    }

    const outcome = await runComposition(steps);
    if (outcome.status.kind === "failed") {
      return errorReceipt({
        action: "clockify_onboard_user",
        code: "onboard_failed",
        message: `Couldn't invite ${p.email}: ${outcome.status.message}. ${leftBehindNote(outcome.status.rollbackWarnings)}`,
        recovery: { hint: "Try again.", retryable: true },
      });
    }
    return successReceipt({
      action: "clockify_onboard_user",
      entity: "user",
      ids: { workspaceId: ctx.workspaceId },
      changed: { created: outcome.created },
      warnings: outcome.warnings.length ? outcome.warnings : undefined,
    });
  },
});

export const CURATED_ACTIONS: ActionDefinition[] = [periodReport, onboardUser];
