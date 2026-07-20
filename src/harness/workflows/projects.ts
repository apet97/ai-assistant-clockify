import { z } from "zod";
import { zNumberLike } from "../arg-shapes.js";
import {
  clarifyResult,
  defineAction,
  defineReadAction,
  defineRiskyAction,
  type ActionDefinition,
  type CommitResult,
  type SemanticLiteralAlias,
} from "../action.js";
import { listReceipt, successReceipt } from "../receipts.js";
import { fromMinor, toMinor } from "../money.js";
import { describePatch, resolveEntityRef, resolveUserRef } from "./resolve.js";
import { RATE_FIELDS, buildRatePreview } from "./rate.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import { commitSingleDurableRiskyStep, executeDurableRiskyStep } from "../durable-risky-write.js";
import { executeCompensationStep, isJournalDegradedStep } from "../mutation-workflow.js";
import { errorReceipt } from "../receipts.js";
import { DefinitiveWriteFailure } from "../../clockify/write-outcome.js";
import { sanitizedFingerprint } from "../safe-json.js";
import {
  captureStructureSnapshot,
  defineStructureDurableSafeWriteAction,
  dispatchWithReconciliation,
  fetchStructureSnapshot,
  mutationPlan,
  reconcileDelete,
  requireFreshSnapshots,
  snapshot,
} from "./structure-durable.js";
import { STRUCTURE_CREATE_RECONCILIATION_CANDIDATE_MAX } from "../safety-limits.js";

/**
 * Typed project workflows (goclmcp §2.2) — the worked reference area. Reads and
 * safe creates execute immediately; updates/archive/delete/rate/estimate/
 * memberships are risky and return a preview + a stored operation, mutating only
 * in `commit` after a button confirmation. The REST layer does I/O; all risk and
 * policy logic lives here and in the executor.
 */

const PROJECT_GROUP = "work_structure" as const;
const PROJECT_BILLABLE_LITERAL_ALIASES = Object.freeze([
  { path: "billable", value: false, authoredPhrases: Object.freeze(["non-billable", "nonbillable", "non billable", "not billable"]) },
  { path: "billable", value: true, authoredPhrases: Object.freeze(["billable"]) },
] satisfies readonly SemanticLiteralAlias[]);
const PROJECT_VISIBILITY_LITERAL_ALIASES = Object.freeze([
  { path: "isPublic", value: false, authoredPhrases: Object.freeze(["private", "not public", "non-public"]) },
  { path: "isPublic", value: true, authoredPhrases: Object.freeze(["public", "not private"]) },
] satisfies readonly SemanticLiteralAlias[]);
const PROJECT_ARCHIVED_LITERAL_ALIASES = Object.freeze([
  { path: "archived", value: false, authoredPhrases: Object.freeze(["active", "restore", "unarchive", "unarchived"]) },
  { path: "archived", value: true, authoredPhrases: Object.freeze(["archive", "archived"]) },
] satisfies readonly SemanticLiteralAlias[]);

async function reconcileCreatedProject(
  ctx: Parameters<NonNullable<ActionDefinition["handler"]>>[0],
  beforeIds: readonly string[],
  expected: { name?: unknown },
): Promise<Awaited<ReturnType<typeof ctx.clockify.createProjectAtomic>> | undefined> {
  const after = await ctx.clockify.listProjects({ archived: false });
  if (after.truncated) return undefined;
  const before = new Set(beforeIds);
  const candidates = after.rows.filter((row) => !before.has(row.id) && row.name === expected.name);
  if (candidates.length > STRUCTURE_CREATE_RECONCILIATION_CANDIDATE_MAX) return undefined;
  const matches: typeof candidates = [];
  for (const candidate of candidates) {
    const raw = await ctx.clockify.getProjectMutationState(candidate.id);
    if (raw && Object.entries(expected).every(([key, value]) => JSON.stringify(raw[key]) === JSON.stringify(value))) {
      matches.push(candidate);
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

// ── Reads ────────────────────────────────────────────────────────────────────

const listProjects = defineReadAction({
  name: "clockify_projects_list",
  description: "List projects, optionally filtered by name, archived state, or client ids.",
  group: PROJECT_GROUP,
  schema: z.object({
    name: z.string().optional(),
    archived: z.boolean().optional(),
    clientIds: z.array(z.string()).optional(),
  }),
  async handler(ctx, args) {
    const { rows, truncated } = await ctx.clockify.listProjects(args);
    return listReceipt({
      action: "clockify_projects_list",
      entity: "project",
      ids: { workspaceId: ctx.workspaceId },
      rows,
      truncated,
    });
  },
});

const getProject = defineAction({
  name: "clockify_projects_get",
  description: "Fetch a single project by id, or by its exact `name` (resolved server-side).",
  featureGroup: PROJECT_GROUP,
  risks: ["read"],
  schema: z
    .object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
    .refine((v) => v.id !== undefined || v.name !== undefined, {
      message: "Provide the project id or its exact name.",
    }),
  async handler(ctx, args) {
    const resolved = await resolveEntityRef(args, {
      noun: "project",
      verb: "fetch",
      list: () => ctx.clockify.listProjects(),
    });
    if (!resolved.ok) {
      return clarifyResult(resolved.clarify);
    }
    const entity = await ctx.clockify.getProject(resolved.id);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_projects_get",
        entity: "project",
        ids: { workspaceId: ctx.workspaceId },
        data: { entity },
      }),
    };
  },
});

// ── Safe writes ──────────────────────────────────────────────────────────────

const createProject = defineStructureDurableSafeWriteAction({
  name: "clockify_projects_create",
  description:
    "Create a project. Assign a client by `clientId` or its exact `clientName` (resolved server-side — an unknown client clarifies). Optionally set the project's DEFAULT billable/cost rate with `hourlyRate`/`costRate` (a number; `rateUnit` major by default — Clockify's project rate is set here, not via a separate endpoint). Safe write — executes immediately when policy allows.",
  group: PROJECT_GROUP,
  stepName: "Create project",
  mutationContract: durableMutationContract({
    source: "safe",
    targeting: { mode: "snapshots", relations: ["parent"] },
    strategies: ["create"],
  }),
  semanticLiteralAliases: Object.freeze([
    ...PROJECT_BILLABLE_LITERAL_ALIASES,
    ...PROJECT_VISIBILITY_LITERAL_ALIASES,
  ]),
  schema: z.object({
    name: z.string().min(1),
    clientId: z.string().optional(),
    /** The client's exact name, resolved to an id server-side. */
    clientName: z.string().optional(),
    billable: z.boolean().optional(),
    color: z.string().optional(), // hex
    isPublic: z.boolean().optional(),
    /** Project DEFAULT hourly/cost rate amount (the project-wide rate). */
    hourlyRate: zNumberLike(z.number().nonnegative()).optional(),
    costRate: zNumberLike(z.number().nonnegative()).optional(),
    rateUnit: z.enum(["major", "minor"]).default("major"),
  }),
  async prepare(ctx, args) {
    // The client ref resolves BEFORE the write — this executes immediately, so
    // a name in either slot must verify or clarify, never reach the wire.
    let clientId: string | undefined;
    if (args.clientId?.trim() || args.clientName?.trim()) {
      const client = await resolveEntityRef(
        { id: args.clientId, name: args.clientName },
        { noun: "client", verb: "assign the new project to", list: (f) => ctx.clockify.listClients(f), verifyId: true },
      );
      if (!client.ok) {
        return { kind: "clarify", clarify: client.clarify.clarify, options: client.clarify.options };
      }
      clientId = client.id;
    }
    const unit = args.rateUnit ?? "major";
    const body = {
      name: args.name,
      ...(clientId ? { clientId } : {}),
      ...(args.billable !== undefined ? { billable: args.billable } : {}),
      ...(args.color ? { color: args.color } : {}),
      ...(args.isPublic !== undefined ? { isPublic: args.isPublic } : {}),
      ...(args.hourlyRate !== undefined ? { hourlyRate: { amount: toMinor(args.hourlyRate, unit) } } : {}),
      ...(args.costRate !== undefined ? { costRate: { amount: toMinor(args.costRate, unit) } } : {}),
    };
    const targetSnapshots: ReturnType<typeof snapshot>[] = [];
    if (clientId) {
      const client = await ctx.clockify.getClient(clientId);
      if (!client) return { kind: "clarify" as const, clarify: "The selected client no longer exists. Refresh and try again." };
      targetSnapshots.push(await captureStructureSnapshot(ctx, "parent", "client", client));
    }
    return {
      operation: { body, targetSnapshots },
      mutationPlan: mutationPlan([{
        id: "create-project",
        strategy: "create",
        ...(targetSnapshots[0] ? { fingerprint: targetSnapshots[0].fingerprint } : {}),
      }]),
    };
  },
  async prepareDispatch(ctx, operation) {
    const { targetSnapshots } = operation as {
      targetSnapshots: ReturnType<typeof snapshot>[];
    };
    if (targetSnapshots.length) await requireFreshSnapshots(ctx, targetSnapshots);
    const baseline = await ctx.clockify.listProjects({ archived: false });
    if (baseline.truncated) throw new Error("create_baseline_incomplete");
    const beforeIds = baseline.rows.map((row) => row.id);
    return {
      preparedDetail: { preDispatch: { strategy: "project_create_baseline", ids: beforeIds, truncated: false } },
      state: { beforeIds },
    };
  },
  async dispatch(ctx, operation, state) {
    const { body } = operation as { body: Parameters<typeof ctx.clockify.createProjectAtomic>[0] };
    const result = await dispatchWithReconciliation({
      dispatch: () => ctx.clockify.createProjectAtomic(body),
      reconcile: () => reconcileCreatedProject(ctx, state.beforeIds, body),
    });
    const project = result.value;
    const created = { type: "project", id: project.id, name: project.name };
    return {
      result: successReceipt({
        action: "clockify_projects_create",
        entity: "project",
        ids: { workspaceId: ctx.workspaceId },
        changed: { created: [created] },
      }),
      externalId: project.id,
      effect: { created },
      detail: { reconciled: result.reconciled, baselineComplete: true },
    };
  },
});

const createFromTemplate = defineStructureDurableSafeWriteAction({
  name: "clockify_projects_from_template",
  description:
    "Create a project from an existing project template. Pass `templateId` or the exact `templateName` (resolved server-side — an unknown template clarifies with the real list), plus the new project's `name` (required by the API).",
  group: PROJECT_GROUP,
  stepName: "Create project from template",
  mutationContract: durableMutationContract({
    source: "safe",
    targeting: { mode: "snapshots", relations: ["parent"] },
    strategies: ["create"],
  }),
  schema: z
    .object({
      templateId: z.string().min(1).optional(),
      /** The template's exact name, resolved to an id server-side. */
      templateName: z.string().min(1).optional(),
      /** Required by CreateProjectFromTemplateV1 (name + templateProjectId). */
      name: z.string().min(1),
    })
    .refine((v) => v.templateId !== undefined || v.templateName !== undefined, {
      message: "Provide the template id or its exact name.",
    }),
  async prepare(ctx, args) {
    // Executes immediately (safe write) — the template ref must verify or
    // clarify before the wire, like projects_create's client ref.
    const template = await resolveEntityRef(
      { id: args.templateId, name: args.templateName },
      { noun: "project template", verb: "create the project from", list: () => ctx.clockify.listTemplates(), verifyId: true },
    );
    if (!template.ok) {
      return { kind: "clarify", clarify: template.clarify.clarify, options: template.clarify.options };
    }
    const templateProject = await ctx.clockify.getProject(template.id);
    if (!templateProject) return { kind: "clarify" as const, clarify: "The selected project template no longer exists. Refresh and try again." };
    const targetSnapshot = await captureStructureSnapshot(ctx, "parent", "project_template", templateProject);
    const body = {
      templateProjectId: template.id,
      name: args.name,
    };
    return {
      operation: { body, targetSnapshots: [targetSnapshot] },
      mutationPlan: mutationPlan([{ id: "create-project-from-template", strategy: "create", fingerprint: targetSnapshot.fingerprint }]),
    };
  },
  async prepareDispatch(ctx, operation) {
    const { targetSnapshots } = operation as {
      targetSnapshots: ReturnType<typeof snapshot>[];
    };
    await requireFreshSnapshots(ctx, targetSnapshots);
    const baseline = await ctx.clockify.listProjects({ archived: false });
    if (baseline.truncated) throw new Error("create_baseline_incomplete");
    const beforeIds = baseline.rows.map((row) => row.id);
    return {
      preparedDetail: { preDispatch: { strategy: "project_template_create_baseline", ids: beforeIds, truncated: false } },
      state: { beforeIds },
    };
  },
  async dispatch(ctx, operation, state) {
    const { body } = operation as { body: Parameters<typeof ctx.clockify.createProjectFromTemplateAtomic>[0] };
    const result = await dispatchWithReconciliation({
      dispatch: () => ctx.clockify.createProjectFromTemplateAtomic(body),
      reconcile: () => reconcileCreatedProject(ctx, state.beforeIds, { name: body.name }),
    });
    const project = result.value;
    const created = { type: "project", id: project.id, name: project.name };
    return {
      result: successReceipt({
        action: "clockify_projects_from_template",
        entity: "project",
        ids: { workspaceId: ctx.workspaceId },
        changed: { created: [created] },
      }),
      externalId: project.id,
      effect: { created },
      detail: { reconciled: result.reconciled, baselineComplete: true },
    };
  },
});

// ── Risky writes (preview → commit) ──────────────────────────────────────────

const updateProject = defineRiskyAction({
  name: "clockify_projects_update",
  description:
    "Update a project's fields (rename, reassign client, billing, color, visibility). Pass the project's `id`, or its exact `currentName` and the harness resolves it — use this to RENAME (`currentName` + the new `name`) without listing first. Elevated write — previews and requires confirmation.",
  group: PROJECT_GROUP,
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations: ["target", "parent"] }, strategies: ["update"] }),
  semanticLiteralAliases: Object.freeze([
    ...PROJECT_ARCHIVED_LITERAL_ALIASES,
    ...PROJECT_BILLABLE_LITERAL_ALIASES,
    ...PROJECT_VISIBILITY_LITERAL_ALIASES,
  ]),
  schema: z
    .object({
      id: z.string().min(1).optional(),
      /** The project's existing name, resolved to an id server-side (rename-by-name). */
      currentName: z.string().min(1).optional(),
      name: z.string().optional(),
      clientId: z.string().optional(),
      billable: z.boolean().optional(),
      color: z.string().optional(),
      isPublic: z.boolean().optional(),
      archived: z.boolean().optional(),
      /** The project's DEFAULT hourly/cost rate (the project-wide rate, set here). */
      hourlyRate: zNumberLike(z.number().nonnegative()).optional(),
      costRate: zNumberLike(z.number().nonnegative()).optional(),
      rateUnit: z.enum(["major", "minor"]).default("major"),
    })
    .refine((v) => v.id !== undefined || v.currentName !== undefined, {
      message: "Provide the project id or its exact currentName.",
    })
    .refine(
      (v) =>
        v.name !== undefined ||
        v.clientId !== undefined ||
        v.billable !== undefined ||
        v.color !== undefined ||
        v.isPublic !== undefined ||
        v.archived !== undefined ||
        v.hourlyRate !== undefined ||
        v.costRate !== undefined,
      { message: "Provide at least one field to change." },
    ),
  async preview(ctx, args) {
    const resolved = await resolveEntityRef(
      { id: args.id, name: args.currentName },
      {
        noun: "project",
        verb: "update",
        list: (filter) => ctx.clockify.listProjects(filter),
        // Unarchiving targets an entity that is archived by definition.
        includeArchived: args.archived === false,
        verifyId: true,
      },
    );
    if (!resolved.ok) return resolved.clarify;
    // Rates are major numbers in the args but the wire wants { amount: minor }; pull
    // them out (with rateUnit) before the generic patch passthrough.
    const { id: _id, currentName: _currentName, hourlyRate, costRate, rateUnit, ...rest } = args;
    const fields: Record<string, unknown> = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    const rateUnitFinal = rateUnit ?? "major";
    const rateChanges: string[] = [];
    if (hourlyRate !== undefined) {
      const amount = toMinor(hourlyRate, rateUnitFinal);
      fields.hourlyRate = { amount };
      rateChanges.push(`Set the project default hourly rate to ${fromMinor(amount)}`);
    }
    if (costRate !== undefined) {
      const amount = toMinor(costRate, rateUnitFinal);
      fields.costRate = { amount };
      rateChanges.push(`Set the project default cost rate to ${fromMinor(amount)}`);
    }
    // A client NAME in the clientId slot resolves to the real id (live item
    // 096: "assign P4 to client X" previewed the name and failed at commit).
    // An empty clientId is the unassign sentinel and passes through.
    if (typeof fields.clientId === "string" && fields.clientId !== "") {
      const client = await resolveEntityRef(
        { id: fields.clientId },
        { noun: "client", verb: "assign", list: (filter) => ctx.clockify.listClients(filter), verifyId: true },
      );
      if (!client.ok) return client.clarify;
      fields.clientId = client.id;
    }
    const current = await ctx.clockify.getProject(resolved.id);
    if (!current) return { clarify: "The requested project no longer exists. Refresh and try again." };
    const targetSnapshots = [await captureStructureSnapshot(ctx, "target", "project", current)];
    if (typeof fields.clientId === "string" && fields.clientId !== "") {
      const parent = await ctx.clockify.getClient(fields.clientId);
      if (!parent) return { clarify: "The selected client no longer exists. Refresh and try again." };
      targetSnapshots.push(await captureStructureSnapshot(ctx, "parent", "client", parent));
    }
    const body = await ctx.clockify.prepareProjectUpdate(resolved.id, fields);
    return {
      actionLabel: "Update project",
      targets: [{ type: "project", id: resolved.id, name: resolved.name ?? args.name }],
      expectedChanges: [
        ...describePatch(Object.fromEntries(Object.entries(fields).filter(([k]) => k !== "hourlyRate" && k !== "costRate"))),
        ...rateChanges,
      ],
      reversibility: "You can update the project again to revert most fields.",
      warnings: ["Updating a project changes live workspace data."],
      payload: { id: resolved.id, patch: fields, body },
      targetSnapshots,
      mutationPlan: mutationPlan([{ id: "update-project", strategy: "update", fingerprint: targetSnapshots[0]!.fingerprint }]),
    };
  },
  async commit(ctx, payload, operation) {
    const { id, body } = payload as { id: string; body: Record<string, unknown> };
    let updated: Awaited<ReturnType<typeof ctx.clockify.getProject>>;
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "update-project", name: "Update project",
      verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (stored) => fetchStructureSnapshot(ctx, stored) },
      dispatch: async () => {
        const result = await dispatchWithReconciliation({
          dispatch: () => ctx.clockify.updateProjectAtomic(id, body),
          reconcile: async () => {
            const raw = await ctx.clockify.getProjectMutationState(id);
            return raw && sanitizedFingerprint(raw) === sanitizedFingerprint(body)
              ? raw as unknown as Awaited<ReturnType<typeof ctx.clockify.updateProjectAtomic>>
              : undefined;
          },
        });
        updated = result.value;
        return { externalId: result.value.id, effect: { updated: { type: "project", id } }, detail: { reconciled: result.reconciled } };
      },
      success: () => successReceipt({ action: "clockify_projects_update", entity: "project", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "project", id, name: updated?.name }] } }),
    });
  },
});

const archiveProject = defineRiskyAction({
  name: "clockify_projects_archive",
  description:
    "Archive a project (hides it from active lists). Pass the project id, or its exact `name` and the harness resolves it. Previews and requires confirmation.",
  group: PROJECT_GROUP,
  risks: ["destructive"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations: ["target"] }, strategies: ["state-command"] }),
  schema: z
    .object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
    .refine((v) => v.id !== undefined || v.name !== undefined, {
      message: "Provide the project id or its exact name.",
    }),
  async preview(ctx, args) {
    const resolved = await resolveEntityRef(args, {
      noun: "project",
      verb: "archive",
      list: (filter) => ctx.clockify.listProjects(filter),
      includeArchived: true,
      verifyId: true,
    });
    if (!resolved.ok) return resolved.clarify;
    const name = resolved.name ?? args.name;
    const current = await ctx.clockify.getProject(resolved.id);
    if (!current) return { clarify: "The requested project no longer exists. Refresh and try again." };
    const targetSnapshot = await captureStructureSnapshot(ctx, "target", "project", current);
    const body = await ctx.clockify.prepareProjectUpdate(resolved.id, { archived: true });
    return {
      actionLabel: "Archive project",
      targets: [{ type: "project", id: resolved.id, name }],
      expectedChanges: [`Archive project ${name ?? resolved.id}`],
      reversibility: "Archiving is reversible — you can unarchive the project later.",
      warnings: ["Archiving hides the project from active workflows."],
      payload: { id: resolved.id, name, body },
      targetSnapshots: [targetSnapshot],
      mutationPlan: mutationPlan([{ id: "archive-project", strategy: "state-command", fingerprint: targetSnapshot.fingerprint }]),
    };
  },
  async commit(ctx, payload, operation) {
    const { id, body } = payload as { id: string; body: Record<string, unknown> };
    let archived: Awaited<ReturnType<typeof ctx.clockify.getProject>>;
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "archive-project", name: "Archive project",
      verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (stored) => fetchStructureSnapshot(ctx, stored) },
      dispatch: async () => {
        const result = await dispatchWithReconciliation({
          dispatch: () => ctx.clockify.archiveProjectAtomic(id, body),
          reconcile: async () => { const row = await ctx.clockify.getProject(id); return row?.archived === true ? row : undefined; },
        });
        archived = result.value;
        return { externalId: result.value.id, effect: { archived: { type: "project", id } }, detail: { reconciled: result.reconciled } };
      },
      success: () => successReceipt({ action: "clockify_projects_archive", entity: "project", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "project", id, name: archived?.name }] } }),
    });
  },
});

const deleteProject = defineRiskyAction({
  name: "clockify_projects_delete",
  description:
    "Delete a project (archives first, then deletes — Clockify rejects deleting an active project). Pass the project id (preferred — list projects first to get it), or its exact name and the harness resolves it. Previews and requires confirmation.",
  group: PROJECT_GROUP,
  risks: ["destructive"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations: ["target"] }, strategies: ["state-command", "delete", "update"] }),
  schema: z
    .object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
    .refine((v) => v.id !== undefined || v.name !== undefined, {
      message: "Provide the project id or its exact name.",
    }),
  async preview(ctx, args) {
    // Resolve a name → id (including a name passed in the id slot), so a delete
    // never dead-ends or commits a doomed id. Ambiguous identity stops and asks.
    const resolved = await resolveEntityRef(args, {
      noun: "project",
      verb: "delete",
      list: (filter) => ctx.clockify.listProjects(filter),
      // Deleting an ARCHIVED project is valid (delete archives first anyway).
      includeArchived: true,
      verifyId: true,
    });
    if (!resolved.ok) return resolved.clarify;
    const { id } = resolved;
    const name = resolved.name ?? args.name;
    const current = await ctx.clockify.getProject(id);
    if (!current) return { clarify: "The requested project no longer exists. Refresh and try again." };
    const targetSnapshot = await captureStructureSnapshot(ctx, "target", "project", current);
    const changedArchiveState = current.archived !== true;
    const archiveBody = changedArchiveState ? await ctx.clockify.prepareProjectUpdate(id, { archived: true }) : undefined;
    const restoreBody = changedArchiveState ? await ctx.clockify.prepareProjectUpdate(id, { archived: false }) : undefined;
    const transitionedTargetFingerprint = changedArchiveState
      ? snapshot("target", "project", current, archiveBody).fingerprint
      : targetSnapshot.fingerprint;
    const steps = changedArchiveState
      ? [
          { id: "archive-project-for-delete", strategy: "state-command" as const, fingerprint: targetSnapshot.fingerprint },
          { id: "delete-project", strategy: "delete" as const, fingerprint: transitionedTargetFingerprint },
          { id: "restore-project", kind: "compensation" as const, strategy: "update" as const, fingerprint: transitionedTargetFingerprint },
        ]
      : [{ id: "delete-project", strategy: "delete" as const, fingerprint: targetSnapshot.fingerprint }];
    return {
      actionLabel: "Delete project",
      targets: [{ type: "project", id, name }],
      expectedChanges: [`Delete project ${name ?? id} (and its tasks)`],
      reversibility: "This cannot be undone.",
      warnings: ["Deleting a project is permanent and removes its tasks."],
      payload: { id, name, originalArchived: current.archived === true, archiveBody, restoreBody, transitionedTargetFingerprint },
      targetSnapshots: [targetSnapshot],
      mutationPlan: mutationPlan(steps),
    };
  },
  async commit(ctx, payload, operation): Promise<CommitResult> {
    const { id, name, originalArchived, archiveBody, restoreBody, transitionedTargetFingerprint } = payload as { id: string; name?: string; originalArchived: boolean; archiveBody?: Record<string, unknown>; restoreBody?: Record<string, unknown>; transitionedTargetFingerprint: string };
    let archiveStep: Awaited<ReturnType<typeof executeDurableRiskyStep>> | undefined;
    let index = 0;
    if (!originalArchived) {
      archiveStep = await executeDurableRiskyStep({
        ctx, operation, planStepId: "archive-project-for-delete", index, name: "Archive project before delete",
        dispatch: async () => {
          await requireFreshSnapshots(ctx, operation.targetSnapshots ?? []);
          const result = await dispatchWithReconciliation({ dispatch: () => ctx.clockify.archiveProjectAtomic(id, archiveBody!), reconcile: async () => { const row = await ctx.clockify.getProject(id); return row?.archived === true ? row : undefined; } });
          return { externalId: result.value.id, effect: { archived: { type: "project", id } }, detail: { reconciled: result.reconciled } };
        },
      });
      index += 1;
      if (archiveStep.status === "outcome_unknown") return errorReceipt({ action: operation.actionName, code: "commit_outcome_unknown", message: "Project archive outcome is unknown; delete was not dispatched.", recovery: { hint: "Refresh the project before trying again.", retryable: false } });
      if (archiveStep.status === "definitive_failed") return errorReceipt({ action: operation.actionName, code: "write_failed", message: "Clockify rejected the project archive; delete was not dispatched." });
      if (isJournalDegradedStep(archiveStep)) return { kind: "partial", receipt: successReceipt({ action: operation.actionName, entity: "project", changed: { updated: [{ type: "project", id, name }] } }), message: "The project was archived, but local settlement degraded, so delete was not dispatched.", recovery: { hint: "Refresh the project and review it manually.", retryable: false } };
    }
    const beforeDelete = await ctx.clockify.getProject(id);
    if (!beforeDelete || beforeDelete.archived !== true) return errorReceipt({ action: operation.actionName, code: "stale_target", message: "The project was not authoritatively archived immediately before delete. No delete was sent.", recovery: { hint: "Create a fresh preview.", retryable: true } });
    const deleteSnapshot = await captureStructureSnapshot(ctx, "target", "project", beforeDelete);
    if (deleteSnapshot.fingerprint !== transitionedTargetFingerprint) return errorReceipt({ action: operation.actionName, code: "stale_target", message: "The archived project changed before delete. No delete was sent.", recovery: { hint: "Create a fresh preview.", retryable: true } });
    const deleted = await executeDurableRiskyStep({
      ctx, operation, planStepId: "delete-project", index, name: "Delete project",
      dispatch: async () => {
        await requireFreshSnapshots(ctx, [deleteSnapshot]);
        const result = await dispatchWithReconciliation({ dispatch: async () => { await ctx.clockify.deleteProjectAtomic(id); return true as const; }, reconcile: () => reconcileDelete(() => ctx.clockify.getProject(id)) });
        return { effect: { deleted: { type: "project", id } }, detail: { reconciled: result.reconciled } };
      },
    });
    if (deleted.status === "succeeded") return successReceipt({ action: operation.actionName, entity: "project", ids: { workspaceId: ctx.workspaceId }, changed: { deleted: [{ type: "project", id, name }] } });
    if (deleted.status === "outcome_unknown") return errorReceipt({ action: operation.actionName, code: "commit_outcome_unknown", message: "Project delete outcome is unknown. Archive compensation was not attempted.", recovery: { hint: "Verify whether the project exists before any retry.", retryable: false } });
    if (!archiveStep || !restoreBody) return errorReceipt({ action: operation.actionName, code: "write_failed", message: "Clockify rejected deletion of the already-archived project." });
    if (!ctx.mutationJournal) {
      return { kind: "partial", receipt: successReceipt({ action: operation.actionName, entity: "project", changed: { updated: [{ type: "project", id, name }] } }), message: "Project archive succeeded and delete failed; durable compensation was unavailable, so no restore mutation was sent.", recovery: { hint: "Inspect the project archive state manually.", retryable: false } };
    }
    const compensation = await executeCompensationStep({
      journal: ctx.mutationJournal, operationId: operation.operationId,
      step: { id: "restore-project", index: index + 1, name: "Restore project archive state", kind: "compensation", compensatesStepId: archiveStep.id, targetFingerprint: transitionedTargetFingerprint },
      dispatch: async () => {
        const current = await ctx.clockify.getProject(id);
        if (!current || current.archived !== true) throw new Error("project_compensation_target_unknown");
        const currentSnapshot = await captureStructureSnapshot(ctx, "target", "project", current);
        if (currentSnapshot.fingerprint !== transitionedTargetFingerprint) throw new DefinitiveWriteFailure("VERIFY", "stale_target", "Project changed before compensation.");
        const result = await dispatchWithReconciliation({ dispatch: () => ctx.clockify.updateProjectAtomic(id, restoreBody), reconcile: async () => { const row = await ctx.clockify.getProject(id); return row?.archived === false ? row : undefined; } });
        return { externalId: result.value.id, effect: { restoredArchiveState: { type: "project", id } }, detail: { reconciled: result.reconciled } };
      },
    });
    const compensationStatus = compensation.status;
    if (compensationStatus === "compensated") return errorReceipt({ action: operation.actionName, code: "write_failed", message: "Project deletion was rejected; the archive state was restored." });
    return { kind: "partial", receipt: successReceipt({ action: operation.actionName, entity: "project", changed: { updated: [{ type: "project", id, name }] } }), message: "Project archive succeeded and delete failed; restoring the original state did not complete definitively.", recovery: { hint: "Inspect the project archive state manually.", retryable: false } };
  },
});

const rateUpdate = defineRiskyAction({
  name: "clockify_projects_rate_update",
  description:
    'Set a billable hourly or cost rate for a MEMBER of a project (Clockify has no project-wide default rate via the API — it is per member). Pass the project by `projectId` or exact `projectName`, the member by `userId`/`userName` (use "me" for the requesting admin), and `rateKind` as HOURLY or COST. The member must already be on the project. Billing action — previews and requires confirmation.',
  group: "invoices",
  risks: ["billing"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations: ["target"] }, strategies: ["update"] }),
  semanticLiteralAliases: Object.freeze([
    { path: "userId", value: "me", authoredPhrases: Object.freeze(["my", "myself"]) },
    { path: "rateKind", value: "HOURLY", authoredPhrases: Object.freeze([
      "project member", "project member rate", "member rate", "hourly rate",
    ]) },
    { path: "rateKind", value: "COST", authoredPhrases: Object.freeze([
      "project member cost rate", "member cost rate", "cost rate",
    ]) },
  ] satisfies readonly SemanticLiteralAlias[]),
  schema: z
    .object({
      projectId: z.string().min(1).optional(),
      projectName: z.string().min(1).optional(),
      /** A member's user id, exact name (via userName), or "me" (resolved server-side). */
      userId: z.string().min(1).optional(),
      userName: z.string().min(1).optional(),
      ...RATE_FIELDS,
    })
    .refine((v) => v.projectId !== undefined || v.projectName !== undefined, { message: "Provide the project id or its exact name." })
    .refine((v) => v.userId !== undefined || v.userName !== undefined, { message: "Provide the member (id or exact name, or 'me')." }),
  async preview(ctx, args) {
    // Resolve the project.
    const project = await resolveEntityRef(
      { id: args.projectId, name: args.projectName },
      { noun: "project", verb: "set a rate on", list: () => ctx.clockify.listProjects() },
    );
    if (!project.ok) return project.clarify;
    // Resolve the member ("me" -> the admin; a name -> a user id). Clockify's rate
    // endpoint wants a 24-hex user id in the path, not "me".
    const member = await resolveUserRef(
      { id: args.userId, name: args.userName },
      { verb: "set a rate for", adminUserId: ctx.adminUserId, listUsers: () => ctx.clockify.listUsers() },
    );
    if (!member.ok) return member.clarify;
    const userId = member.userId;
    const memberLabel = member.label;
    // VERIFY membership — a member-rate PUT for a non-member 404s ("User membership
    // on project ... not found"), so catch it at preview, never confirm-then-fail.
    const memberships = await ctx.clockify.getProjectMemberships(project.id);
    if (!memberships.rows.some((m) => String(m.userId) === userId)) {
      if (memberships.truncated) {
        return {
          clarify: `Clockify returned an incomplete membership list for "${project.name ?? project.id}", so I can't verify whether ${memberLabel} is already a member. Narrow the membership filter and try again.`,
        };
      }
      const you = memberLabel === "you";
      return {
        clarify: `${you ? "You aren't" : `${memberLabel} isn't`} a member of "${project.name ?? project.id}" yet — Clockify only sets a rate for project members. Add ${you ? "yourself" : "them"} to the project first ("add ${you ? "me" : memberLabel} to ${project.name ?? project.id}"), then set the rate.`,
      };
    }
    const amountMinor = toMinor(args.amount, args.amountUnit);
    const current = await ctx.clockify.getProject(project.id);
    if (!current) return { clarify: "The requested project no longer exists. Refresh and try again." };
    const targetSnapshot = await captureStructureSnapshot(ctx, "target", "project", current);
    return {
      ...buildRatePreview({
        targetType: "project",
        targetId: project.id,
        scopeLabel: `for ${memberLabel} on "${project.name ?? project.id}"`,
        amountMinor,
        rateKind: args.rateKind,
        kindNoun: "project",
      }),
      payload: {
        projectId: project.id,
        userId,
        rateKind: args.rateKind,
        amountMinor,
        ...(args.since !== undefined ? { since: args.since } : {}),
      },
      targetSnapshots: [targetSnapshot],
      mutationPlan: mutationPlan([{ id: "update-project-rate", strategy: "update", fingerprint: targetSnapshot.fingerprint }]),
    };
  },
  async commit(ctx, payload, persistedOperation) {
    const rateInput = payload as {
      projectId: string;
      userId: string;
      rateKind: "HOURLY" | "COST";
      amountMinor: number;
      since?: string;
    };
    return commitSingleDurableRiskyStep({
      ctx, operation: persistedOperation, planStepId: "update-project-rate", name: "Update project rate",
      verification: { snapshots: persistedOperation.targetSnapshots ?? [], fetchSnapshot: (stored) => fetchStructureSnapshot(ctx, stored) },
      dispatch: async () => {
        const result = await dispatchWithReconciliation({
          dispatch: async () => { await ctx.clockify.updateProjectRateAtomic(rateInput); return true as const; },
          reconcile: async () => {
            const row = await ctx.clockify.getProject(rateInput.projectId) as unknown as Record<string, unknown> | null;
            const key = rateInput.rateKind === "COST" ? "costRate" : "hourlyRate";
            return row && (row[key] as { amount?: unknown } | undefined)?.amount === rateInput.amountMinor ? true as const : undefined;
          },
        });
        return { effect: { updatedRate: { projectId: rateInput.projectId, userId: rateInput.userId } }, detail: { reconciled: result.reconciled } };
      },
      success: () => successReceipt({ action: "clockify_projects_rate_update", entity: "project", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "project", id: rateInput.projectId }] } }),
    });
  },
});

const estimateUpdate = defineRiskyAction({
  name: "clockify_projects_estimate_update",
  description:
    "Update a project's time/budget estimate. Elevated write — previews and requires confirmation.",
  group: PROJECT_GROUP,
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations: ["target"] }, strategies: ["update"] }),
  argumentOpenPaths: ["fields"],
  schema: z.object({
    id: z.string().min(1),
    fields: z.record(z.string(), z.unknown()).refine((f) => Object.keys(f).length > 0, {
      message: "Provide at least one estimate field.",
    }),
  }),
  async preview(ctx, args) {
    const current = await ctx.clockify.getProject(args.id);
    if (!current) return { clarify: "The requested project does not exist. Provide a current project id." };
    const targetSnapshot = await captureStructureSnapshot(ctx, "target", "project", current);
    return {
      actionLabel: "Update project estimate",
      targets: [{ type: "project", id: args.id }],
      expectedChanges: Object.keys(args.fields).map((key) => `set estimate ${key}`),
      reversibility: "You can update the estimate again at any time.",
      warnings: ["Changing the estimate affects progress and budget reporting."],
      payload: { id: args.id, fields: args.fields },
      targetSnapshots: [targetSnapshot],
      mutationPlan: mutationPlan([{ id: "update-project-estimate", strategy: "update", fingerprint: targetSnapshot.fingerprint }]),
    };
  },
  async commit(ctx, payload, operation) {
    const { id, fields } = payload as { id: string; fields: Record<string, unknown> };
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "update-project-estimate", name: "Update project estimate",
      verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (stored) => fetchStructureSnapshot(ctx, stored) },
      dispatch: async () => {
        const result = await dispatchWithReconciliation({
          dispatch: async () => { await ctx.clockify.updateProjectEstimateAtomic(id, fields); return true as const; },
          reconcile: async () => {
            const row = await ctx.clockify.getProject(id) as unknown as Record<string, unknown> | null;
            return row && Object.entries(fields).every(([key, value]) => JSON.stringify(row[key]) === JSON.stringify(value)) ? true as const : undefined;
          },
        });
        return { effect: { updatedEstimate: { projectId: id } }, detail: { reconciled: result.reconciled } };
      },
      success: () => successReceipt({ action: "clockify_projects_estimate_update", entity: "project", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "project", id }] } }),
    });
  },
});

const membershipsUpdate = defineRiskyAction({
  name: "clockify_projects_memberships_update",
  description:
    'Update who can access/track a project. To ADD members, pass `addUserIds` — use "me" for the requesting admin (the harness knows who is asking; never ask the admin who they are) — and the harness merges them into the current membership set. Passing `memberships` REPLACES the whole set. Pass the project `id` or its exact `name`. Elevated write — previews and requires confirmation.',
  group: "users_groups",
  // NOTE: this is a real Clockify write, so it must be gated by the `users_groups`
  // feature-group policy. The `permission_change` label is reserved for the
  // assistant's OWN policy management (`assistant_update_permissions`), which the
  // executor intentionally exempts from the Clockify feature-group gate; using it
  // here would BYPASS that gate. `high_risk_write` keeps confirmation AND the gate.
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations: ["target"] }, strategies: ["update"] }),
  argumentOpenPaths: ["memberships[]"],
  schema: z
    .object({
      id: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      memberships: z.array(z.record(z.string(), z.unknown())).min(1).optional(),
      /** User ids to ADD (merged into the current set); "me" = the requesting admin. */
      addUserIds: z.array(z.string().min(1)).min(1).optional(),
    })
    .refine((v) => v.id !== undefined || v.name !== undefined, {
      message: "Provide the project id or its exact name.",
    })
    .refine((v) => v.memberships !== undefined || v.addUserIds !== undefined, {
      message: "Provide memberships to replace, or addUserIds to add.",
    }),
  async preview(ctx, args) {
    const resolved = await resolveEntityRef(
      { id: args.id, name: args.name },
      { noun: "project", verb: "update", list: (filter) => ctx.clockify.listProjects(filter), verifyId: true },
    );
    if (!resolved.ok) return resolved.clarify;
    let memberships = args.memberships ?? [];
    let change: string;
    if (args.addUserIds) {
      // The memberships PATCH REPLACES the set, so an "add" merges into the
      // CURRENT records ("me" = the caller — live item 058 asked "which user
      // are you?" instead of knowing).
      const current = await ctx.clockify.getProjectMemberships(resolved.id);
      if (current.truncated) {
        return {
          clarify: `Clockify returned an incomplete membership list for "${resolved.name ?? resolved.id}", so I can't safely merge members without risking removal. Narrow the membership filter and try again.`,
        };
      }
      const requested = args.addUserIds.map((u) => (u.trim().toLowerCase() === "me" ? ctx.adminUserId : u));
      const have = new Set(current.rows.map((m) => String(m.userId)));
      const additions = [...new Set(requested)].filter((u) => !have.has(u));
      memberships = [...current.rows, ...additions.map((userId) => ({ userId }))];
      change = `Add ${additions.length} member(s) (${current.rows.length} existing kept)`;
    } else {
      change = `Replace membership set (${memberships.length} member(s))`;
    }
    const currentProject = await ctx.clockify.getProject(resolved.id);
    if (!currentProject) return { clarify: "The requested project no longer exists. Refresh and try again." };
    const targetSnapshot = await captureStructureSnapshot(ctx, "target", "project", currentProject);
    return {
      actionLabel: "Update project memberships",
      targets: [{ type: "project", id: resolved.id, name: resolved.name ?? args.name }],
      expectedChanges: [change],
      reversibility: "You can update memberships again to restore prior access.",
      warnings: ["This changes who can access and track time on the project."],
      payload: { id: resolved.id, memberships },
      targetSnapshots: [targetSnapshot],
      mutationPlan: mutationPlan([{ id: "update-project-memberships", strategy: "update", fingerprint: targetSnapshot.fingerprint }]),
    };
  },
  async commit(ctx, payload, operation) {
    const { id, memberships } = payload as {
      id: string;
      memberships: Array<Record<string, unknown>>;
    };
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "update-project-memberships", name: "Update project memberships",
      verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (stored) => fetchStructureSnapshot(ctx, stored) },
      dispatch: async () => {
        const result = await dispatchWithReconciliation({
          dispatch: async () => { await ctx.clockify.updateProjectMembershipsAtomic(id, { memberships }); return true as const; },
          reconcile: async () => {
            const current = await ctx.clockify.getProjectMemberships(id);
            return !current.truncated && JSON.stringify(current.rows) === JSON.stringify(memberships) ? true as const : undefined;
          },
        });
        return { effect: { memberships: memberships.length, projectId: id }, detail: { reconciled: result.reconciled } };
      },
      success: () => successReceipt({ action: "clockify_projects_memberships_update", entity: "project", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "project", id }] } }),
    });
  },
});

export const PROJECT_ACTIONS: ActionDefinition[] = [
  listProjects,
  getProject,
  createProject,
  createFromTemplate,
  updateProject,
  archiveProject,
  deleteProject,
  rateUpdate,
  estimateUpdate,
  membershipsUpdate,
];
