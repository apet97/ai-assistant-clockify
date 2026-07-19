import { z } from "zod";
import { zStringList } from "../arg-shapes.js";
import {
  defineAction,
  defineRiskyAction,
  type CommitResult,
  type ActionDefinition,
  type SemanticLiteralAlias,
} from "../action.js";
import { successReceipt, errorReceipt } from "../receipts.js";
import { matchByName, REPORT_PERIODS, resolvePeriod } from "./resolve.js";
import { DAY_MS, nowDate } from "../../durations.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import { executeDurableRiskyStep } from "../durable-risky-write.js";
import { captureTargetSnapshot, verifyTargetSnapshots } from "../target-snapshots.js";
import { dispatchWithReconciliation, reconcileCreate } from "./structure-durable.js";
import { dynamicMutationPlan, fetchCompositeSnapshot, groupProjection } from "./composite-durable.js";
import { DefinitiveWriteFailure } from "../../clockify/write-outcome.js";
import { ONBOARD_GROUP_BATCH_MAX } from "../safety-limits.js";

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
    let range = resolvePeriod(nowDate(ctx), args.period, ctx.timeZone, ctx.weekStartsOn);
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
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({
    source: "confirmed",
    targeting: { mode: "snapshots", relations: ["parent"] },
    strategies: ["create", "update"],
  }),
  semanticLiteralAliases: Object.freeze([
    { path: "sendEmail", value: false, authoredPhrases: Object.freeze(["do not send email", "don't send email", "without email", "no email"]) },
    { path: "sendEmail", value: true, authoredPhrases: Object.freeze(["send email", "send an email"]) },
  ] satisfies readonly SemanticLiteralAlias[]),
  schema: z.object({
    email: z.string().min(1),
    groups: zStringList(z.array(z.string().min(1)).max(ONBOARD_GROUP_BATCH_MAX)).optional(),
    sendEmail: z.boolean().optional(),
  }),
  async preview(ctx, args) {
    const requested = [...new Map((args.groups ?? []).map((value) => [
      value.normalize("NFKC").trim().toLocaleLowerCase("en-US"),
      value,
    ])).values()];
    // Resolve group names at PREVIEW (one listGroups, like the per-area resolvers)
    // so the card matches exactly what the commit will do. A best-effort group-add
    // must never be PROMISED for a group that doesn't exist: resolvable groups go
    // into the payload as verified ids; unresolvable/ambiguous names are shown as
    // "will be skipped" instead of being silently dropped at commit time.
    const groupList = requested.length
      ? await ctx.clockify.listGroups()
      : { rows: [], truncated: false };
    if (groupList.truncated) {
      return {
        clarify:
          "Clockify returned an incomplete user group list, so I can't prove the requested groups are unique or absent. Provide exact group ids or narrow the group filter.",
      };
    }
    const resolvedGroups: Array<{ id: string; name: string }> = [];
    const resolvedGroupIds = new Set<string>();
    const skipped: Array<{ name: string; reason: string }> = [];
    for (const name of requested) {
      const direct = groupList.rows.find((candidate) => candidate.id === name);
      const match = direct ? { kind: "one" as const, entity: direct } : matchByName(groupList.rows, name);
      if (match.kind === "one") {
        if (!resolvedGroupIds.has(match.entity.id)) {
          resolvedGroupIds.add(match.entity.id);
          resolvedGroups.push({ id: match.entity.id, name: match.entity.name });
        }
      }
      else skipped.push({ name, reason: match.kind === "many" ? "ambiguous" : "not found" });
    }
    const userBaseline = await ctx.clockify.listUsers();
    if (userBaseline.truncated) {
      return { clarify: "Clockify returned an incomplete user list, so I can't safely invite or reconcile this address." };
    }
    if (userBaseline.rows.some((row) => row.email?.toLocaleLowerCase("en-US") === args.email.toLocaleLowerCase("en-US"))) {
      return { clarify: `${args.email} is already present in this workspace.` };
    }
    const targetSnapshots = resolvedGroups.map((group) => {
      const row = groupList.rows.find((candidate) => candidate.id === group.id)!;
      return captureTargetSnapshot("parent", { type: "group", id: group.id, name: group.name }, groupProjection(row));
    });
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
      payload: {
        email: args.email,
        groups: resolvedGroups,
        sendEmail: args.sendEmail ?? true,
        baselineUserIds: userBaseline.rows.map((row) => row.id).sort(),
      },
      targetSnapshots,
      mutationPlan: dynamicMutationPlan([
        { id: "invite-user", strategy: "create" },
        ...resolvedGroups.map((group, index) => ({
          id: `add-user-to-group-${index}`,
          strategy: "update" as const,
          targetFingerprint: targetSnapshots[index]!.fingerprint,
        })),
      ]),
    };
  },
  async commit(ctx, payload, operation): Promise<CommitResult> {
    const p = payload as {
      email: string;
      groups: Array<{ id: string; name: string }>;
      sendEmail: boolean;
      baselineUserIds: string[];
    };
    const immediate = await ctx.clockify.listUsers();
    if (immediate.truncated || JSON.stringify(immediate.rows.map((row) => row.id).sort()) !== JSON.stringify(p.baselineUserIds)) {
      return errorReceipt({
        action: "clockify_onboard_user",
        code: "stale_target",
        message: "The workspace user list changed after preview. No invitation was sent.",
        recovery: { hint: "Create a fresh preview.", retryable: true },
      });
    }
    let invited: Awaited<ReturnType<typeof ctx.clockify.inviteUserAtomic>> | undefined;
    let inviteReconciled = false;
    const invite = await executeDurableRiskyStep({
      ctx,
      operation,
      planStepId: "invite-user",
      index: 0,
      name: "Invite user",
      preparedDetail: { email: p.email, sendEmail: p.sendEmail, baselineUserIds: p.baselineUserIds },
      dispatch: async () => {
        const dispatched = await dispatchWithReconciliation({
          dispatch: () => ctx.clockify.inviteUserAtomic(p.email, p.sendEmail),
          reconcile: () => reconcileCreate({
            beforeIds: p.baselineUserIds,
            list: () => ctx.clockify.listUsers(),
            matches: (row) => row.email?.toLocaleLowerCase("en-US") === p.email.toLocaleLowerCase("en-US"),
          }),
        });
        inviteReconciled = dispatched.reconciled;
        invited = dispatched.value;
        return {
          externalId: invited.id,
          effect: { created: { type: "user", id: invited.id, name: invited.name } },
          detail: { reconciled: dispatched.reconciled },
        };
      },
    });
    if (invite.status === "outcome_unknown") {
      return errorReceipt({
        action: "clockify_onboard_user",
        code: "commit_outcome_unknown",
        message: "The invitation may or may not have applied. No group membership was changed.",
        recovery: { hint: "Verify the user list before retrying.", retryable: false },
      });
    }
    if (invite.status !== "succeeded" || !invited) {
      return errorReceipt({ action: "clockify_onboard_user", code: "onboard_failed", message: `Couldn't invite ${p.email}.` });
    }
    const created = { type: "user", id: invited.id, name: invited.name };
    if (inviteReconciled && p.groups.length > 0) {
      return onboardPartial(
        created,
        0,
        p.groups.length,
        "The invitation was proven successful after an ambiguous response, so no group mutation was sent.",
      );
    }
    for (let index = 0; index < p.groups.length; index += 1) {
      const group = p.groups[index]!;
      const snapshot = operation.targetSnapshots?.[index];
      if (!snapshot) return onboardPartial(created, index, p.groups.length, "The saved group evidence is incomplete.");
      const groupEvidence = await ctx.clockify.listGroups();
      if (groupEvidence.truncated) return onboardPartial(created, index, p.groups.length, "Clockify returned incomplete group evidence.");
      const current = groupEvidence.rows.find((row) => row.id === group.id);
      if (!current) return onboardPartial(created, index, p.groups.length, `Group "${group.name}" no longer exists.`);
      const expectedUserIds = [...new Set([...(current.userIds ?? []), invited.id])].sort();
      let membershipReconciled = false;
      const membership = await executeDurableRiskyStep({
        ctx,
        operation,
        planStepId: `add-user-to-group-${index}`,
        index: index + 1,
        name: `Add user to ${group.name}`,
        preparedDetail: { groupId: group.id, userId: invited.id, expectedUserIds },
        dispatch: async () => {
          const verified = await verifyTargetSnapshots([snapshot], (stored) => fetchCompositeSnapshot(ctx, stored));
          if (!verified.ok) throw new DefinitiveWriteFailure("VERIFY", group.id, verified.code);
          const dispatched = await dispatchWithReconciliation({
            dispatch: async () => { await ctx.clockify.addUserToGroupAtomic(group.id, invited!.id); return true as const; },
            reconcile: async () => {
              const listed = await ctx.clockify.listGroups();
              if (listed.truncated) return undefined;
              const row = listed.rows.find((candidate) => candidate.id === group.id);
              return row && JSON.stringify([...(row.userIds ?? [])].sort()) === JSON.stringify(expectedUserIds)
                ? true as const
                : undefined;
            },
          });
          membershipReconciled = dispatched.reconciled;
          return { externalId: invited!.id, effect: { groupId: group.id, userId: invited!.id }, detail: { reconciled: dispatched.reconciled } };
        },
      });
      if (membership.status !== "succeeded") {
        return onboardPartial(created, index, p.groups.length, `Adding the user to "${group.name}" did not complete definitively.`);
      }
      if (membershipReconciled && index + 1 < p.groups.length) {
        return onboardPartial(
          created,
          index + 1,
          p.groups.length,
          `Adding the user to "${group.name}" was proven successful after an ambiguous response, so no later group mutation was sent.`,
        );
      }
    }
    return successReceipt({
      action: "clockify_onboard_user",
      entity: "user",
      ids: { workspaceId: ctx.workspaceId },
      changed: { created: [created] },
    });
  },
});

function onboardPartial(
  created: { type: string; id: string; name?: string },
  completedGroups: number,
  totalGroups: number,
  reason: string,
): Extract<CommitResult, { kind: "partial" }> {
  return {
    kind: "partial",
    receipt: successReceipt({ action: "clockify_onboard_user", entity: "user", changed: { created: [created] } }),
    message: `The user was invited, but only ${completedGroups} of ${totalGroups} group additions completed. ${reason}`,
    recovery: { hint: "Review group membership manually before continuing.", retryable: false },
  };
}

export const CURATED_ACTIONS: ActionDefinition[] = [periodReport, onboardUser];
