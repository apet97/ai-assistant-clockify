import { z } from "zod";
import {
  defineRiskyAction,
  type ActionContext,
  type ActionDefinition,
  type CommitResult,
  type RiskyPreviewResult,
  type SemanticLiteralAlias,
  type TargetSnapshot,
} from "../action.js";
import { canWrite } from "../permissions.js";
import { successReceipt, errorReceipt } from "../receipts.js";
import { resolveEntityRef, resolveUserRef, resolveUserRefs } from "./resolve.js";
import { fromMinor, toMinor } from "../money.js";
import { zNumberLike, zStringList } from "../arg-shapes.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import { executeDurableRiskyStep } from "../durable-risky-write.js";
import { sanitizedFingerprint } from "../safe-json.js";
import { captureTargetSnapshot, verifyTargetSnapshots } from "../target-snapshots.js";
import { dispatchWithReconciliation, reconcileCreate } from "./structure-durable.js";
import { dynamicMutationPlan, fetchCompositeSnapshot, userProjection } from "./composite-durable.js";
import { DefinitiveWriteFailure } from "../../clockify/write-outcome.js";
import {
  estimateSetupProjectHostCalls,
  SETUP_PROJECT_MEMBER_BATCH_MAX,
  SETUP_PROJECT_RATE_BATCH_MAX,
  CONFIRMED_REQUEST_PRE_RESERVATION_HOST_CALLS,
  TURN_HOST_CALL_LIMIT,
} from "../safety-limits.js";

/**
 * `clockify_setup_project` — the single-approval composite. A request like
 * "create a project, add me, make it private, set the project rate to 50, set my
 * member rate to 25" becomes ONE preview listing every change → ONE button Confirm
 * → an atomic composition, instead of a separate confirm per risky write.
 *
 * It mirrors `clockify_onboard_user` (curated.ts): the `handler` resolves every
 * identity + amount and returns a PREVIEW that lists all changes; the `commit`
 * builds ordered `CompositionStep`s (create → add members → set rates, sharing the
 * created project id via a closure) and runs them via `runComposition`, so a
 * required-step failure reverse-rolls-back (deleting the new project undoes
 * everything) and the whole intent has a single undo handle.
 *
 * Risk: editing access + billable rates → `["high_risk_write","billing"]` (always
 * previews + confirms). The outer policy gate is `work_structure` (the always-
 * present create); `users_groups` (members) and `invoices` (rates) are pre-checked
 * at preview AND re-checked defensively inside their steps at commit.
 */

const rateKindEnum = z.enum(["hourly", "cost"]);

type RateKind = z.infer<typeof rateKindEnum>;
type ResolvedRate = { userId: string; amountMinor: number; kind: RateKind };

// The resolved composition payload, persisted to the pending confirmation and read back
// at commit/idempotency time. A Zod schema (not just a cast) so a stored-shape drift —
// e.g. a pending preview that spans a deploy which changed this shape — fails LOUDLY at
// commit instead of a silent wrong-field cast. z.infer keeps the type in sync.
const setupPayloadSchema = z.object({
  name: z.string(),
  isPublic: z.boolean().optional(),
  clientId: z.string().optional(),
  addUserIds: z.array(z.string()),
  projectRate: z.object({ amountMinor: z.number(), kind: rateKindEnum }).optional(),
  memberRates: z.array(z.object({ userId: z.string(), amountMinor: z.number(), kind: rateKindEnum })),
});
type SetupPayload = z.infer<typeof setupPayloadSchema>;

/** "$50.00" — keeps the "$" prefix at the call site, fromMinor owns the ×100. */
function major(amountMinor: number): string {
  return `$${fromMinor(amountMinor)}`;
}

const setupProject = defineRiskyAction({
  name: "clockify_setup_project",
  description:
    'Create a NEW project AND set it up in one step — optionally make it private, add members (names or "me"), set the project\'s default billable/cost rate, and set per-member rates — as ONE preview and ONE Confirm. Use this for "create a project and add me / make it private / set the rate". For just creating a bare project with nothing else, use clockify_projects_create.',
  group: "work_structure",
  risks: ["high_risk_write", "billing"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({
    source: "confirmed",
    targeting: { mode: "snapshots", relations: ["parent"] },
    strategies: ["create", "update"],
  }),
  semanticLiteralAliases: Object.freeze([
    { path: "isPublic", value: false, authoredPhrases: Object.freeze(["private", "not public", "non-public"]) },
    { path: "isPublic", value: true, authoredPhrases: Object.freeze(["public", "not private"]) },
    { path: "private", value: false, authoredPhrases: Object.freeze(["public", "not private"]) },
    { path: "private", value: true, authoredPhrases: Object.freeze(["private", "not public", "non-public"]) },
    {
      path: "memberRates[].kind",
      value: "hourly",
      authoredPhrases: Object.freeze(["project member", "project member rate", "member rate", "hourly rate"]),
    },
    {
      path: "memberRates[].kind",
      value: "cost",
      authoredPhrases: Object.freeze(["project member cost rate", "member cost rate", "cost rate"]),
    },
  ] satisfies readonly SemanticLiteralAlias[]),
  schema: z.object({
    name: z.string().min(1),
    isPublic: z.boolean().optional(),
    /** Alias the planner emits for "make it private"; folded into isPublic. */
    private: z.boolean().optional(),
    clientId: z.string().optional(),
    clientName: z.string().optional(),
    /** Members to ADD (names or "me"). */
    members: zStringList(z.array(z.string().min(1)).max(SETUP_PROJECT_MEMBER_BATCH_MAX)).optional(),
    /** Project DEFAULT rate amount (set in the project create body — not a separate endpoint). */
    projectRate: zNumberLike(z.number().nonnegative()).optional(),
    projectRateKind: rateKindEnum.default("hourly"),
    /** Per-member rates; a rate for a member who isn't in `members` adds them too. */
    memberRates: z
      .array(
        z.object({
          member: z.string().min(1),
          amount: zNumberLike(z.number().nonnegative()),
          kind: rateKindEnum.default("hourly"),
        }),
      )
      .max(SETUP_PROJECT_RATE_BATCH_MAX)
      .optional(),
    /** `major` (e.g. 50.00) is converted ×100 to the minor units Clockify wants. */
    rateUnit: z.enum(["major", "minor"]).default("major"),
  }).superRefine((value, ctx) => {
    // A rate implies membership. Before name resolution, treat every supplied
    // member/rate as distinct so the advertised shape is safe in the worst case.
    const memberCount = (value.members?.length ?? 0) + (value.memberRates?.length ?? 0);
    const maxHostCalls = estimateSetupProjectHostCalls({
      memberCount,
      rateCount: value.memberRates?.length ?? 0,
      hasClient: value.clientId !== undefined || value.clientName !== undefined,
    });
    // Cold route auth plus the two forced confirmation checks run before the
    // mutation scope can atomically reserve its remaining operation cost.
    if (CONFIRMED_REQUEST_PRE_RESERVATION_HOST_CALLS + maxHostCalls > TURN_HOST_CALL_LIMIT) {
      ctx.addIssue({
        code: "custom",
        message: `Combined members and rates require up to ${CONFIRMED_REQUEST_PRE_RESERVATION_HOST_CALLS + maxHostCalls} host calls including authentication and confirmation checks; maximum is ${TURN_HOST_CALL_LIMIT}.`,
      });
    }
  }),
  async preview(ctx, args) {
    const unit = args.rateUnit ?? "major";
    const isPublic = args.isPublic ?? (args.private !== undefined ? !args.private : undefined);

    // 1. Client (optional) — resolve before any write so confirm can't fail on it.
    let clientId: string | undefined;
    let clientLabel: string | undefined;
    if (args.clientId?.trim() || args.clientName?.trim()) {
      const client = await resolveEntityRef(
        { id: args.clientId, name: args.clientName },
        {
          noun: "client",
          verb: "assign the new project to",
          list: (f) => ctx.clockify.listClients(f),
          notFoundHint: "Or should I create the client first?",
          verifyId: true,
        },
      );
      if (!client.ok) return client.clarify;
      clientId = client.id;
      clientLabel = client.name ?? args.clientName;
    }

    // 2. Members to add — resolved (id/name/"me"); a rate implies membership, so
    // member-rate targets are folded into this same ordered, deduped set.
    const labelByUserId = new Map<string, string>();
    const orderedUserIds: string[] = [];
    const addMember = (userId: string, label: string): void => {
      if (!labelByUserId.has(userId)) {
        labelByUserId.set(userId, label);
        orderedUserIds.push(userId);
      }
    };
    // The workspace user list is identical for member resolution AND every
    // per-member rate. Fetch it at most once (lazy single-flight) instead of
    // 1 + N times — mirrors clockify_onboard_user's getGroups (curated.ts).
    let usersPromise: ReturnType<ActionContext["clockify"]["listUsers"]> | undefined;
    const listUsers = (): ReturnType<ActionContext["clockify"]["listUsers"]> =>
      (usersPromise ??= ctx.clockify.listUsers());

    if (args.members?.length) {
      const m = await resolveUserRefs(args.members, {
        verb: "add to the project",
        adminUserId: ctx.adminUserId,
        listUsers,
        verifyIds: true,
      });
      if (!m.ok) return m.clarify;
      m.userIds.forEach((id, i) => addMember(id, m.labels[i]));
    }

    // 3. Per-member rates — resolve each member (folds into the add set).
    const resolvedRates: Array<ResolvedRate & { label: string }> = [];
    for (const r of args.memberRates ?? []) {
      const member = await resolveUserRef(
        { id: r.member, name: r.member },
        { verb: "set a rate for", adminUserId: ctx.adminUserId, listUsers },
      );
      if (!member.ok) return member.clarify;
      addMember(member.userId, member.label);
      resolvedRates.push({ userId: member.userId, label: member.label, amountMinor: toMinor(r.amount, unit), kind: r.kind });
    }

    // 4. Pre-check the sub-group write policies the outer work_structure gate does
    //    NOT cover, so we never create a project the admin can't finish setting up.
    if (orderedUserIds.length && !canWrite(ctx.policy, "users_groups")) {
      return {
        clarify:
          "I can't add members because write access to users_groups is disabled in your assistant permissions. Enable it (or drop the members) and try again.",
      };
    }
    if (resolvedRates.length && !canWrite(ctx.policy, "invoices")) {
      return {
        clarify:
          "I can't set rates because write access to invoices is disabled in your assistant permissions. Enable it (or drop the rates) and try again.",
      };
    }

    // 5. Project default rate (create-body) + the change list (resolved + MAJOR).
    const projectRate = args.projectRate !== undefined ? { amountMinor: toMinor(args.projectRate, unit), kind: args.projectRateKind } : undefined;
    const expectedChanges: string[] = [];
    expectedChanges.push(
      `Create project "${args.name}"${isPublic === false ? " (private)" : isPublic === true ? " (public)" : ""}${clientLabel ? ` for client "${clientLabel}"` : ""}`,
    );
    for (const userId of orderedUserIds) {
      const label = labelByUserId.get(userId) as string;
      expectedChanges.push(label === "you" ? "Add you as a member" : `Add "${label}" as a member`);
    }
    if (projectRate) expectedChanges.push(`Set project ${projectRate.kind} rate to ${major(projectRate.amountMinor)}`);
    for (const r of resolvedRates) {
      expectedChanges.push(`Set ${r.label === "you" ? "your" : `${r.label}'s`} member ${r.kind} rate to ${major(r.amountMinor)}`);
    }

    const payload: SetupPayload = {
      name: args.name,
      ...(isPublic !== undefined ? { isPublic } : {}),
      ...(clientId ? { clientId } : {}),
      addUserIds: orderedUserIds,
      ...(projectRate ? { projectRate } : {}),
      memberRates: resolvedRates.map((r) => ({ userId: r.userId, amountMinor: r.amountMinor, kind: r.kind })),
    };

    const targetSnapshots: TargetSnapshot[] = [];
    if (clientId) {
      const client = await ctx.clockify.getClient(clientId);
      if (!client) return { clarify: "The selected client no longer exists. Refresh and try again." };
      const state = await ctx.clockify.getClientMutationState(clientId);
      if (!state) return { clarify: "The selected client could not be verified. Refresh and try again." };
      targetSnapshots.push(captureTargetSnapshot("parent", { type: "client", id: client.id, name: client.name }, state));
    }
    if (orderedUserIds.length) {
      const users = await listUsers();
      if (users.truncated) return { clarify: "Clockify returned an incomplete user list. Narrow the request or use exact user IDs." };
      for (const userId of orderedUserIds) {
        const user = users.rows.find((candidate) => candidate.id === userId);
        if (!user) return { clarify: `User ${userId} could not be verified. Refresh and try again.` };
        targetSnapshots.push(captureTargetSnapshot("parent", { type: "user", id: user.id, name: user.name }, userProjection(user)));
      }
    }
    const planFingerprint = targetSnapshots.length
      ? sanitizedFingerprint(targetSnapshots.map(({ relation, ref, fingerprint }) => ({ relation, ref, fingerprint })))
      : undefined;
    const planSteps: Parameters<typeof dynamicMutationPlan>[0] = [
      { id: "create-project", strategy: "create", ...(planFingerprint ? { targetFingerprint: planFingerprint } : {}) },
    ];
    if (orderedUserIds.length) planSteps.push({ id: "add-project-members", strategy: "update", ...(planFingerprint ? { targetFingerprint: planFingerprint } : {}) });
    resolvedRates.forEach((_rate, index) => planSteps.push({ id: `set-project-rate-${index}`, strategy: "update", ...(planFingerprint ? { targetFingerprint: planFingerprint } : {}) }));

    const result: RiskyPreviewResult = {
      actionLabel: "Set up project",
      targets: [],
      expectedChanges,
      reversibility: "Undo removes the new project entirely (with its members and rates); you can also delete it later.",
      warnings: ["This creates a project, changes who can access it, and sets billable rates."],
      payload: payload as unknown as Record<string, unknown>,
      targetSnapshots,
      mutationPlan: dynamicMutationPlan(planSteps),
    };
    return result;
  },
  async commit(ctx, payload, operation): Promise<CommitResult> {
    const parsed = setupPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return errorReceipt({
        action: "clockify_setup_project",
        code: "invalid_payload",
        message:
          "The saved project-setup details no longer match the expected shape — nothing was changed. Please re-issue the request.",
      });
    }
    const p = parsed.data;
    if ((operation.targetSnapshots?.length ?? 0) > 0) {
      const verified = await verifyTargetSnapshots(
        operation.targetSnapshots ?? [],
        (snapshot) => fetchCompositeSnapshot(ctx, snapshot),
      );
      if (!verified.ok) {
        return errorReceipt({
          action: operation.actionName,
          code: verified.code,
          message: "A selected client or member changed before dispatch. No project was created.",
          recovery: { hint: "Refresh the request and create a new preview.", retryable: true },
        });
      }
    }
    const body = {
      name: p.name,
      ...(p.clientId ? { clientId: p.clientId } : {}),
      ...(p.isPublic !== undefined ? { isPublic: p.isPublic } : {}),
      ...(p.projectRate
        ? { [p.projectRate.kind === "cost" ? "costRate" : "hourlyRate"]: { amount: p.projectRate.amountMinor } }
        : {}),
    };
    const before = await ctx.clockify.listProjects({ archived: false });
    if (before.truncated) {
      return errorReceipt({ action: operation.actionName, code: "list_truncated", message: "Clockify returned an incomplete project baseline. No project was created." });
    }
    let created: { id: string; name: string } | undefined;
    let createReconciled = false;
    const createStep = await executeDurableRiskyStep({
      ctx,
      operation,
      planStepId: "create-project",
      index: 0,
      name: "Create project",
      preparedDetail: { beforeIds: before.rows.map((row) => row.id), body },
      dispatch: async () => {
        const dispatched = await dispatchWithReconciliation({
          dispatch: () => ctx.clockify.createProjectAtomic(body),
          reconcile: async () => {
            const candidate = await reconcileCreate({
              beforeIds: before.rows.map((row) => row.id),
              list: () => ctx.clockify.listProjects({ archived: false }),
              matches: (row) => row.name === p.name,
            });
            if (!candidate) return undefined;
            const state = await ctx.clockify.getProjectMutationState(candidate.id);
            return state && projectMatchesCreateBody(state, body) ? candidate : undefined;
          },
        });
        createReconciled = dispatched.reconciled;
        created = dispatched.value;
        return { externalId: dispatched.value.id, effect: { created: { type: "project", id: dispatched.value.id, name: dispatched.value.name } }, detail: { reconciled: dispatched.reconciled } };
      },
    });
    if (createStep.status === "outcome_unknown") {
      return errorReceipt({ action: operation.actionName, code: "commit_outcome_unknown", message: "The project create outcome is unknown; no setup steps were sent.", recovery: { hint: "Inspect Clockify for the exact project before retrying.", retryable: false } });
    }
    if (createStep.status !== "succeeded" || !created) {
      return errorReceipt({ action: operation.actionName, code: "write_failed", message: "Clockify rejected the project create; no setup steps were sent." });
    }
    if (createReconciled && (p.addUserIds.length > 0 || p.memberRates.length > 0)) {
      return setupProjectPartial(created, "The project create was proven successful after an ambiguous response, so no membership or rate mutation was sent.");
    }

    let planIndex = 1;
    if (p.addUserIds.length) {
      if (!canWrite(ctx.policy, "users_groups")) return setupProjectPartial(created, "The project was created, but member write access is no longer available.");
      const memberships = await ctx.clockify.getProjectMemberships(created.id);
      if (memberships.truncated) return setupProjectPartial(created, "The project was created, but its membership baseline was incomplete; no membership write was sent.");
      const have = new Set(memberships.rows.map((row) => String(row.userId)));
      const expectedRows = [...memberships.rows, ...p.addUserIds.filter((id) => !have.has(id)).map((userId) => ({ userId }))];
      const expectedFingerprint = membershipFingerprint(expectedRows);
      let membershipReconciled = false;
      const memberStep = await executeDurableRiskyStep({
        ctx, operation, planStepId: "add-project-members", index: planIndex++, name: "Add project members",
        preparedDetail: { projectId: created.id, memberships: expectedRows },
        dispatch: async () => {
          const parents = await verifyTargetSnapshots(
            operation.targetSnapshots ?? [],
            (snapshot) => fetchCompositeSnapshot(ctx, snapshot),
          );
          if (!parents.ok) throw new DefinitiveWriteFailure("VERIFY", "add-project-members", parents.code);
          const dispatched = await dispatchWithReconciliation({
            dispatch: async () => { await ctx.clockify.updateProjectMembershipsAtomic(created!.id, { memberships: expectedRows }); return true as const; },
            reconcile: async () => {
              const current = await ctx.clockify.getProjectMemberships(created!.id);
              return !current.truncated && membershipFingerprint(current.rows) === expectedFingerprint ? true as const : undefined;
            },
          });
          membershipReconciled = dispatched.reconciled;
          return { externalId: created!.id, effect: { membersUpdated: p.addUserIds }, detail: { reconciled: dispatched.reconciled } };
        },
      });
      if (memberStep.status !== "succeeded") return setupProjectPartial(created, memberStep.status === "outcome_unknown" ? "The project was created, but the membership update outcome is unknown; rate steps were not sent." : "The project was created, but Clockify rejected the membership update; rate steps were not sent.");
      if (membershipReconciled && p.memberRates.length > 0) {
        return setupProjectPartial(created, "The membership update was proven successful after an ambiguous response, so no rate mutation was sent.");
      }
    }

    for (let rateIndex = 0; rateIndex < p.memberRates.length; rateIndex += 1) {
      const rate = p.memberRates[rateIndex]!;
      if (!canWrite(ctx.policy, "invoices")) return setupProjectPartial(created, "The project was created, but rate write access is no longer available.");
      const current = await ctx.clockify.getProjectMemberships(created.id);
      if (current.truncated) return setupProjectPartial(created, "The project was created, but the member-rate baseline was incomplete; no rate write was sent.");
      const member = current.rows.find((row) => String(row.userId) === rate.userId);
      if (!member) return setupProjectPartial(created, `The project was created, but member ${rate.userId} could not be verified; no rate write was sent.`);
      const key = rate.kind === "cost" ? "costRate" : "hourlyRate";
      const expectedMember = { ...member, [key]: { amount: rate.amountMinor } };
      let rateReconciled = false;
      const rateStep = await executeDurableRiskyStep({
        ctx, operation, planStepId: `set-project-rate-${rateIndex}`, index: planIndex++, name: `Set ${rate.kind} member rate`,
        preparedDetail: { projectId: created.id, userId: rate.userId, amountMinor: rate.amountMinor, kind: rate.kind, expectedMember },
        dispatch: async () => {
          const parents = await verifyTargetSnapshots(
            operation.targetSnapshots ?? [],
            (snapshot) => fetchCompositeSnapshot(ctx, snapshot),
          );
          if (!parents.ok) throw new DefinitiveWriteFailure("VERIFY", `set-project-rate-${rateIndex}`, parents.code);
          const dispatched = await dispatchWithReconciliation({
            dispatch: async () => { await ctx.clockify.updateProjectRateAtomic({ projectId: created!.id, userId: rate.userId, rateKind: rate.kind === "cost" ? "COST" : "HOURLY", amountMinor: rate.amountMinor }); return true as const; },
            reconcile: async () => {
              const after = await ctx.clockify.getProjectMemberships(created!.id);
              if (after.truncated) return undefined;
              const row = after.rows.find((candidate) => String(candidate.userId) === rate.userId);
              return row && sanitizedFingerprint(row) === sanitizedFingerprint(expectedMember) ? true as const : undefined;
            },
          });
          rateReconciled = dispatched.reconciled;
          return { externalId: created!.id, effect: { rateUpdated: { userId: rate.userId, kind: rate.kind, amountMinor: rate.amountMinor } }, detail: { reconciled: dispatched.reconciled } };
        },
      });
      if (rateStep.status !== "succeeded") return setupProjectPartial(created, rateStep.status === "outcome_unknown" ? "The project and earlier setup changes remain, but a member-rate outcome is unknown; later rates were not sent." : "The project and earlier setup changes remain, but Clockify rejected a member rate; later rates were not sent.");
      if (rateReconciled && rateIndex + 1 < p.memberRates.length) {
        return setupProjectPartial(created, "A member rate was proven successful after an ambiguous response, so no later rate mutation was sent.");
      }
    }

    return successReceipt({
      action: "clockify_setup_project",
      entity: "project",
      ids: { workspaceId: ctx.workspaceId },
      changed: { created: [{ type: "project", id: created.id, name: created.name }] },
    });
  },
  idempotencyKey(payload) {
    // A drifted payload must not throw here (this runs BEFORE commit, to claim the
    // dedup key); a stable raw key keeps dedup deterministic, and commit then surfaces
    // the honest invalid_payload receipt.
    const parsed = setupPayloadSchema.safeParse(payload);
    if (!parsed.success) return JSON.stringify(payload);
    const p = parsed.data;
    return JSON.stringify({
      name: p.name,
      isPublic: p.isPublic ?? null,
      clientId: p.clientId ?? null,
      addUserIds: [...p.addUserIds].sort(),
      projectRate: p.projectRate ?? null,
      memberRates: [...p.memberRates]
        .map((r) => ({ userId: r.userId, amountMinor: r.amountMinor, kind: r.kind }))
        .sort((a, b) => a.userId.localeCompare(b.userId)),
    });
  },
});

function projectMatchesCreateBody(current: Record<string, unknown>, body: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(body)) {
    if (sanitizedFingerprint(current[key]) !== sanitizedFingerprint(expected)) return false;
  }
  return true;
}

function membershipFingerprint(rows: readonly Record<string, unknown>[]): string {
  return sanitizedFingerprint(
    rows
      .map((row) => ({ ...row, userId: String(row.userId) }))
      .sort((a, b) => String(a.userId).localeCompare(String(b.userId))),
  );
}

function setupProjectPartial(
  created: { id: string; name: string },
  message: string,
): Extract<CommitResult, { kind: "partial" }> {
  return {
    kind: "partial",
    receipt: successReceipt({
      action: "clockify_setup_project",
      entity: "project",
      changed: { created: [{ type: "project", id: created.id, name: created.name }] },
    }),
    message,
    recovery: { hint: "Inspect the retained project before previewing only the unfinished changes.", retryable: false },
  };
}

export const SETUP_PROJECT_ACTIONS: ActionDefinition[] = [setupProject];
