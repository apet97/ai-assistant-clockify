import { z } from "zod";
import {
  defineAction,
  type ActionContext,
  type ActionDefinition,
  type ActionResult,
  type ClarifyOption,
  type ConfirmableOperation,
} from "../action.js";
import { canWrite } from "../permissions.js";
import { successReceipt, errorReceipt } from "../receipts.js";
import { leftBehindNote, runComposition, type CompositionStep } from "../compose.js";
import { resolveEntityRef, resolveUserRef, resolveUserRefs } from "./resolve.js";
import { toMinor } from "../money.js";
import { zNumberLike, zStringList } from "../arg-shapes.js";

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

interface SetupPayload {
  name: string;
  isPublic?: boolean;
  clientId?: string;
  addUserIds: string[];
  projectRate?: { amountMinor: number; kind: RateKind };
  memberRates: ResolvedRate[];
}

function asClarify(c: { clarify: string; options?: ClarifyOption[] }): ActionResult {
  return { kind: "clarify", message: c.clarify, options: c.options };
}

function major(amountMinor: number): string {
  return `$${(amountMinor / 100).toFixed(2)}`;
}

const setupProject = defineAction({
  name: "clockify_setup_project",
  description:
    'Create a NEW project AND set it up in one step — optionally make it private, add members (names or "me"), set the project\'s default billable/cost rate, and set per-member rates — as ONE preview and ONE Confirm. Use this for "create a project and add me / make it private / set the rate". For just creating a bare project with nothing else, use clockify_projects_create.',
  featureGroup: "work_structure",
  risks: ["high_risk_write", "billing"],
  schema: z.object({
    name: z.string().min(1),
    isPublic: z.boolean().optional(),
    /** Alias the planner emits for "make it private"; folded into isPublic. */
    private: z.boolean().optional(),
    clientId: z.string().optional(),
    clientName: z.string().optional(),
    /** Members to ADD (names or "me"). */
    members: zStringList(z.array(z.string().min(1))).optional(),
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
      .optional(),
    /** `major` (e.g. 50.00) is converted ×100 to the minor units Clockify wants. */
    rateUnit: z.enum(["major", "minor"]).default("major"),
  }),
  async handler(ctx, args) {
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
        },
      );
      if (!client.ok) return asClarify(client.clarify);
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
      if (!m.ok) return asClarify(m.clarify);
      m.userIds.forEach((id, i) => addMember(id, m.labels[i]));
    }

    // 3. Per-member rates — resolve each member (folds into the add set).
    const resolvedRates: Array<ResolvedRate & { label: string }> = [];
    for (const r of args.memberRates ?? []) {
      const member = await resolveUserRef(
        { id: r.member, name: r.member },
        { verb: "set a rate for", adminUserId: ctx.adminUserId, listUsers },
      );
      if (!member.ok) return asClarify(member.clarify);
      addMember(member.userId, member.label);
      resolvedRates.push({ userId: member.userId, label: member.label, amountMinor: toMinor(r.amount, unit), kind: r.kind });
    }

    // 4. Pre-check the sub-group write policies the outer work_structure gate does
    //    NOT cover, so we never create a project the admin can't finish setting up.
    if (orderedUserIds.length && !canWrite(ctx.policy, "users_groups")) {
      return {
        kind: "clarify",
        message:
          "I can't add members because write access to users_groups is disabled in your assistant permissions. Enable it (or drop the members) and try again.",
      };
    }
    if (resolvedRates.length && !canWrite(ctx.policy, "invoices")) {
      return {
        kind: "clarify",
        message:
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

    return {
      kind: "preview",
      preview: {
        actionLabel: "Set up project",
        featureGroup: "work_structure",
        riskLabels: ["high_risk_write", "billing"],
        targets: [],
        expectedChanges,
        reversibility: "Undo removes the new project entirely (with its members and rates); you can also delete it later.",
        warnings: ["This creates a project, changes who can access it, and sets billable rates."],
      },
      operation: {
        actionName: "clockify_setup_project",
        featureGroup: "work_structure",
        risks: ["high_risk_write", "billing"],
        payload: payload as unknown as Record<string, unknown>,
      },
    };
  },
  async commit(ctx, operation) {
    const p = operation.payload as unknown as SetupPayload;
    const del = ctx.clockify.deleteEntity?.bind(ctx.clockify);
    const undoFor = (entityType: string, id: string): (() => Promise<void>) | undefined =>
      del ? () => del({ entityType, id }) : undefined;
    const ids: { projectId?: string } = {};
    const steps: CompositionStep[] = [];

    // Step 1 — create the project (visibility + DEFAULT rate live in the create body).
    steps.push({
      label: "project",
      required: true,
      run: async () => {
        const created = await ctx.clockify.createProject({
          name: p.name,
          ...(p.clientId ? { clientId: p.clientId } : {}),
          ...(p.isPublic !== undefined ? { isPublic: p.isPublic } : {}),
          ...(p.projectRate
            ? { [p.projectRate.kind === "cost" ? "costRate" : "hourlyRate"]: { amount: p.projectRate.amountMinor } }
            : {}),
        });
        ids.projectId = created.id;
        return {
          kind: "done",
          created: [{ type: "project", id: created.id, name: created.name }],
          undo: undoFor("project", created.id),
        };
      },
    });

    // Step 2 — add members (the PATCH replaces, so MERGE into the current set).
    if (p.addUserIds.length) {
      steps.push({
        label: "members",
        required: true,
        run: async () => {
          if (!canWrite(ctx.policy, "users_groups")) throw new Error("write access to users_groups is disabled");
          const projectId = ids.projectId as string;
          const current = await ctx.clockify.getProjectMemberships(projectId);
          const have = new Set(current.map((m) => String(m.userId)));
          const additions = p.addUserIds.filter((u) => !have.has(u));
          const memberships = [...current, ...additions.map((userId) => ({ userId }))];
          await ctx.clockify.updateProjectMemberships(projectId, { memberships });
          return { kind: "done" };
        },
      });
    }

    // Step 3..N — per-member rates (the member is on the project from step 2).
    for (const r of p.memberRates) {
      steps.push({
        label: `rate:${r.userId}`,
        required: true,
        run: async () => {
          if (!canWrite(ctx.policy, "invoices")) throw new Error("write access to invoices is disabled");
          await ctx.clockify.updateProjectRate({
            projectId: ids.projectId as string,
            userId: r.userId,
            rateKind: r.kind === "cost" ? "COST" : "HOURLY",
            amountMinor: r.amountMinor,
          });
          return { kind: "done" };
        },
      });
    }

    const outcome = await runComposition(steps);
    if (outcome.status.kind === "failed") {
      const rolled = outcome.status.rolledBack.length
        ? ` Rolled back: ${outcome.status.rolledBack.map((e) => `${e.type} ${e.name ?? e.id}`).join(", ")}.`
        : "";
      return errorReceipt({
        action: "clockify_setup_project",
        code: "setup_failed",
        message: `Couldn't finish setting up "${p.name}": the ${outcome.status.label} step failed (${outcome.status.message}). ${leftBehindNote(outcome.status.rollbackWarnings)}${rolled}`,
        recovery: { hint: "Adjust the request and try again.", retryable: true },
      });
    }
    if (outcome.status.kind === "stopped") {
      // No step returns `stop`, so this is unreachable; fail closed rather than
      // report a half-built setup as success.
      return errorReceipt({
        action: "clockify_setup_project",
        code: "setup_incomplete",
        message: `Setting up "${p.name}" stopped before completing.`,
        recovery: { hint: "Try again.", retryable: true },
      });
    }
    return successReceipt({
      action: "clockify_setup_project",
      entity: "project",
      ids: { workspaceId: ctx.workspaceId },
      changed: { created: outcome.created },
      warnings: outcome.warnings.length ? outcome.warnings : undefined,
    });
  },
  idempotencyKey(operation: ConfirmableOperation) {
    const p = operation.payload as unknown as SetupPayload;
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

export const SETUP_PROJECT_ACTIONS: ActionDefinition[] = [setupProject];
