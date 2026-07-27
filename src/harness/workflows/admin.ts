import { z } from "zod";
import {
  defineReadAction,
  defineRiskyAction,
  type ActionContext,
  type ActionDefinition,
  type CommitResult,
  type TargetSnapshot,
} from "../action.js";
import { successReceipt, errorReceipt } from "../receipts.js";
import { applyPolicyPatch, FEATURE_GROUPS, permissionLevelSchema } from "../permissions.js";
import type { FeatureGroup } from "../permissions.js";
import { describePatch, resolveEntityRef, type ArchivedFilter } from "./resolve.js";
import { buildMetrics } from "../../metrics/metrics.js";
import type { ListResult } from "../../clockify/types.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import { commitSingleDurableRiskyStep, executeDurableRiskyStep } from "../durable-risky-write.js";
import { executeCompensationStep } from "../mutation-workflow.js";
import { DefinitiveWriteFailure } from "../../clockify/write-outcome.js";
import { captureTargetSnapshot, verifyTargetSnapshots } from "../target-snapshots.js";
import { sanitizedFingerprint } from "../safe-json.js";
import { captureStructureSnapshot, dispatchWithReconciliation, reconcileDelete } from "./structure-durable.js";
import { captureGroupSnapshot, dynamicMutationPlan, fetchCompositeSnapshot } from "./composite-durable.js";
import type {
  ApiAccess,
  ApiActionMetadataCarrier,
  ApiExposure,
  ApiMethod,
  AvailabilityByAuthClass,
} from "../api-operation.js";

/**
 * Risky workflows (SPEC "Risky Writes"). Each handler builds a dry-run preview
 * and a stored operation but NEVER mutates Clockify; the mutation happens only
 * in `commit`, which the harness runs after a button confirmation. Permission
 * changes are not Clockify writes — they use a button save and no dry-run.
 */

const DELETABLE_ENTITY_TYPES = [
  "project",
  "client",
  "task",
  "tag",
  "time_entry",
  "invoice",
  "expense",
  "webhook",
  "user",
  "group",
] as const;

type AdminActionName =
  | "clockify_delete_entity"
  | "assistant_update_permissions"
  | "clockify_update_entity"
  | "assistant_show_permissions"
  | "assistant_recent_outcomes";

const ADMIN_AVAILABILITY: AvailabilityByAuthClass = Object.freeze({
  addon: Object.freeze({ available: true }),
  api_key: Object.freeze({ available: true }),
});

const ADMIN_API_KEY_ONLY: AvailabilityByAuthClass = Object.freeze({
  addon: Object.freeze({ available: false, reason: "unsupported_auth_class" }),
  api_key: Object.freeze({ available: true }),
});

function adminEndpointKey(
  access: ApiAccess,
  method: ApiMethod,
  path: string,
  sourceModule: string,
): string {
  return [access, "api", method, path, sourceModule].join("\0");
}

function adminInternalMetadata(input: {
  exposure: Exclude<ApiExposure, "api" | "local">;
  reason: string;
  primary: readonly string[];
  support: readonly string[];
  availability: AvailabilityByAuthClass;
}): ApiActionMetadataCarrier {
  return Object.freeze({
    apiExposure: input.exposure,
    apiExposureReason: input.reason,
    adapterEndpoints: Object.freeze({
      primary: Object.freeze([...input.primary]),
      support: Object.freeze([...input.support]),
    }),
    availabilityByAuthClass: input.availability,
    boundedArgumentDictionaries: Object.freeze([]),
  });
}

function adminLocalMetadata(reason: string): ApiActionMetadataCarrier {
  return Object.freeze({
    apiExposure: "local",
    apiExposureReason: reason,
    availabilityByAuthClass: ADMIN_AVAILABILITY,
    boundedArgumentDictionaries: Object.freeze([]),
  });
}

const adminEndpoint = Object.freeze({
  projectsList: adminEndpointKey("read", "GET", "/workspaces/{workspaceId}/projects", "projects.ts"),
  projectsGet: adminEndpointKey("read", "GET", "/workspaces/{workspaceId}/projects/{id}", "projects.ts"),
  projectsUpdate: adminEndpointKey("write", "PUT", "/workspaces/{workspaceId}/projects/{id}", "projects.ts"),
  projectsDelete: adminEndpointKey("write", "DELETE", "/workspaces/{workspaceId}/projects/{projectId}", "projects.ts"),
  clientsList: adminEndpointKey("read", "GET", "/workspaces/{workspaceId}/clients", "clients.ts"),
  clientsGet: adminEndpointKey("read", "GET", "/workspaces/{workspaceId}/clients/{id}", "clients.ts"),
  clientsUpdate: adminEndpointKey("write", "PUT", "/workspaces/{workspaceId}/clients/{id}", "clients.ts"),
  clientsDelete: adminEndpointKey("write", "DELETE", "/workspaces/{workspaceId}/clients/{id}", "clients.ts"),
  tagsList: adminEndpointKey("read", "GET", "/workspaces/{workspaceId}/tags", "tags.ts"),
  tagsGet: adminEndpointKey("read", "GET", "/workspaces/{workspaceId}/tags/{id}", "tags.ts"),
  tagsUpdate: adminEndpointKey("write", "PUT", "/workspaces/{workspaceId}/tags/{id}", "tags.ts"),
  tagsDelete: adminEndpointKey("write", "DELETE", "/workspaces/{workspaceId}/tags/{id}", "tags.ts"),
  timeEntriesGet: adminEndpointKey("read", "GET", "/workspaces/{workspaceId}/time-entries/{id}", "time-entries.ts"),
  timeEntriesDelete: adminEndpointKey("write", "DELETE", "/workspaces/{workspaceId}/time-entries/{id}", "time-entries.ts"),
  invoicesList: adminEndpointKey("read", "GET", "/workspaces/{workspaceId}/invoices", "invoices.ts"),
  invoicesGet: adminEndpointKey("read", "GET", "/workspaces/{workspaceId}/invoices/{id}", "invoices.ts"),
  invoicesDelete: adminEndpointKey("write", "DELETE", "/workspaces/{workspaceId}/invoices/{id}", "invoices.ts"),
  expensesGet: adminEndpointKey("read", "GET", "/workspaces/{workspaceId}/expenses/{id}", "expenses.ts"),
  expensesDelete: adminEndpointKey("write", "DELETE", "/workspaces/{workspaceId}/expenses/{id}", "expenses.ts"),
  webhooksGet: adminEndpointKey("read", "GET", "/workspaces/{workspaceId}/webhooks/{id}", "webhooks.ts"),
  webhooksDelete: adminEndpointKey("write", "DELETE", "/workspaces/{workspaceId}/webhooks/{id}", "webhooks.ts"),
  groupsList: adminEndpointKey("read", "GET", "/workspaces/{workspaceId}/user-groups", "users.ts"),
  groupsDelete: adminEndpointKey("write", "DELETE", "/workspaces/{workspaceId}/user-groups/{id}", "users.ts"),
});

const ADMIN_API_METADATA = Object.freeze({
  clockify_delete_entity: adminInternalMetadata({
    exposure: "generic",
    reason: "Selects unrelated entity delete endpoints and may archive a project or client before deletion with compensation; Task 6 must use the typed atomic operations.",
    primary: [
      adminEndpoint.projectsUpdate,
      adminEndpoint.projectsDelete,
      adminEndpoint.clientsUpdate,
      adminEndpoint.clientsDelete,
      adminEndpoint.tagsDelete,
      adminEndpoint.timeEntriesDelete,
      adminEndpoint.invoicesDelete,
      adminEndpoint.expensesDelete,
      adminEndpoint.webhooksDelete,
      adminEndpoint.groupsDelete,
    ],
    support: [
      adminEndpoint.projectsList,
      adminEndpoint.projectsGet,
      adminEndpoint.clientsList,
      adminEndpoint.clientsGet,
      adminEndpoint.tagsList,
      adminEndpoint.tagsGet,
      adminEndpoint.timeEntriesGet,
      adminEndpoint.invoicesList,
      adminEndpoint.invoicesGet,
      adminEndpoint.expensesGet,
      adminEndpoint.webhooksGet,
      adminEndpoint.groupsList,
    ],
    availability: ADMIN_API_KEY_ONLY,
  }),
  assistant_update_permissions: adminLocalMetadata(
    "Updates only the caller's persisted assistant policy and performs no Clockify request.",
  ),
  clockify_update_entity: adminInternalMetadata({
    exposure: "generic",
    reason: "Selects the project, client, or tag update endpoint from entityType and accepts an open fields record; Task 6 must use operation-specific closed updates.",
    primary: [adminEndpoint.projectsUpdate, adminEndpoint.clientsUpdate, adminEndpoint.tagsUpdate],
    support: [
      adminEndpoint.projectsList,
      adminEndpoint.projectsGet,
      adminEndpoint.clientsList,
      adminEndpoint.clientsGet,
      adminEndpoint.tagsList,
      adminEndpoint.tagsGet,
    ],
    availability: ADMIN_AVAILABILITY,
  }),
  assistant_show_permissions: adminLocalMetadata(
    "Reads only the caller's in-process assistant policy and performs no Clockify request.",
  ),
  assistant_recent_outcomes: adminLocalMetadata(
    "Reads only locally audited assistant outcomes and performs no Clockify request.",
  ),
} satisfies Readonly<Record<AdminActionName, ApiActionMetadataCarrier>>);

// Tasks require a project-scoped typed delete and users require a typed
// deactivate flow. Neither may be reached through the generic capability.
const GENERIC_DELETE_ENTITY_TYPES = [
  "project",
  "client",
  "tag",
  "time_entry",
  "invoice",
  "expense",
  "webhook",
  "group",
] as const;

const ENTITY_GROUP: Record<(typeof DELETABLE_ENTITY_TYPES)[number], FeatureGroup> = {
  project: "work_structure",
  client: "work_structure",
  task: "work_structure",
  tag: "work_structure",
  time_entry: "time_tracking",
  invoice: "invoices",
  expense: "expenses",
  webhook: "webhooks",
  user: "users_groups",
  group: "users_groups",
};

/**
 * The list call backing name→id resolution for the generic actions' entity
 * types. The planner sometimes reaches for the GENERIC action with a NAME in
 * the id slot (live item 091: a client rename via update_entity failed at
 * commit) — those ids must resolve at preview, exactly like the typed actions.
 * Other types keep their typed actions (which resolve names themselves).
 */
function genericEntityList(
  ctx: ActionContext,
  entityType: string,
): ((filter?: ArchivedFilter) => Promise<ListResult<{ id: string; name: string; archived?: boolean }>>) | undefined {
  switch (entityType) {
    case "project":
      return (filter) => ctx.clockify.listProjects(filter);
    case "client":
      return (filter) => ctx.clockify.listClients(filter);
    case "tag":
      return (filter) => ctx.clockify.listTags(filter);
    default:
      return undefined;
  }
}

type GenericDeleteType = (typeof GENERIC_DELETE_ENTITY_TYPES)[number];
type GenericUpdateType = "project" | "client" | "tag";

async function captureGenericTarget(ctx: ActionContext, entityType: GenericDeleteType, id: string): Promise<TargetSnapshot | undefined> {
  if (entityType === "project") {
    const row = await ctx.clockify.getProject(id);
    return row ? captureStructureSnapshot(ctx, "target", "project", row) : undefined;
  }
  if (entityType === "client") {
    const row = await ctx.clockify.getClient(id);
    return row ? captureStructureSnapshot(ctx, "target", "client", row) : undefined;
  }
  if (entityType === "tag") {
    const row = await ctx.clockify.getTag(id);
    return row ? captureStructureSnapshot(ctx, "target", "tag", row) : undefined;
  }
  if (entityType === "time_entry") {
    const row = await ctx.clockify.getEntry(id);
    return row ? captureStructureSnapshot(ctx, "target", "time_entry", row) : undefined;
  }
  if (entityType === "invoice") {
    const row = await ctx.clockify.getInvoice(id);
    return row ? captureTargetSnapshot("target", { type: entityType, id }, row) : undefined;
  }
  if (entityType === "expense") {
    const row = await ctx.clockify.getExpense(id);
    return row ? captureTargetSnapshot("target", { type: entityType, id, name: row.name }, row) : undefined;
  }
  if (entityType === "webhook") {
    const row = await ctx.clockify.getWebhook(id);
    return row ? captureTargetSnapshot("target", { type: entityType, id, name: row.name }, row) : undefined;
  }
  return captureGroupSnapshot(ctx, "target", id);
}

async function readGenericTarget(ctx: ActionContext, entityType: GenericDeleteType, id: string): Promise<unknown | null | undefined> {
  if (entityType === "project") return ctx.clockify.getProjectMutationState(id);
  if (entityType === "client") return ctx.clockify.getClientMutationState(id);
  if (entityType === "tag") {
    try { return await ctx.clockify.prepareTagUpdate(id, {}); } catch { return null; }
  }
  if (entityType === "time_entry") {
    try { return await ctx.clockify.prepareTimeEntryUpdate({ id }); } catch { return null; }
  }
  if (entityType === "invoice") return ctx.clockify.getInvoice(id);
  if (entityType === "expense") return ctx.clockify.getExpense(id);
  if (entityType === "webhook") return ctx.clockify.getWebhook(id);
  const group = await ctx.clockify.getGroup(id);
  return group ? { id: group.id, name: group.name, userIds: [...(group.userIds ?? [])].sort() } : group;
}

async function deleteGenericAtomic(ctx: ActionContext, entityType: GenericDeleteType, id: string): Promise<void> {
  if (entityType === "project") return ctx.clockify.deleteProjectAtomic(id);
  if (entityType === "client") return ctx.clockify.deleteClientAtomic(id);
  if (entityType === "tag") return ctx.clockify.deleteTagAtomic(id);
  if (entityType === "time_entry") return ctx.clockify.deleteTimeEntryAtomic(id);
  if (entityType === "invoice") return ctx.clockify.deleteInvoiceAtomic(id);
  if (entityType === "expense") return ctx.clockify.deleteExpenseAtomic(id);
  if (entityType === "webhook") return ctx.clockify.deleteWebhookAtomic(id);
  return ctx.clockify.deleteGroupAtomic(id);
}

async function replacementState(ctx: ActionContext, entityType: GenericUpdateType, id: string): Promise<Record<string, unknown> | null> {
  if (entityType === "project") return ctx.clockify.getProjectMutationState(id);
  if (entityType === "client") return ctx.clockify.getClientMutationState(id);
  try { return await ctx.clockify.prepareTagUpdate(id, {}); } catch { return null; }
}

const deleteEntity = defineRiskyAction({
  ...ADMIN_API_METADATA.clockify_delete_entity,
  name: "clockify_delete_entity",
  description: "Delete a Clockify entity. Always previews first and requires confirmation.",
  group: "work_structure",
  risks: ["destructive"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({
    source: "confirmed",
    targeting: { mode: "snapshots", relations: ["target"] },
    strategies: ["state-command", "delete", "update"],
  }),
  schema: z.object({
    entityType: z.enum(GENERIC_DELETE_ENTITY_TYPES),
    id: z.string().min(1),
    name: z.string().optional(),
  }),
  resolveFeatureGroup: (args) => ENTITY_GROUP[args.entityType],
  async preview(ctx, args) {
    let { id, name } = args;
    const list = genericEntityList(ctx, args.entityType);
    if (list) {
      const resolved = await resolveEntityRef(
        { id: args.id, name: args.name },
        { noun: args.entityType, verb: "delete", list, includeArchived: true, verifyId: true },
      );
      if (!resolved.ok) return resolved.clarify;
      id = resolved.id;
      name = resolved.name ?? args.name;
    }
    const targetSnapshot = await captureGenericTarget(ctx, args.entityType, id);
    if (!targetSnapshot) return { clarify: `The requested ${args.entityType} no longer exists. Refresh and try again.` };
    const raw = await readGenericTarget(ctx, args.entityType, id) as Record<string, unknown> | null | undefined;
    const needsArchive = (args.entityType === "project" || args.entityType === "client") && raw?.archived !== true;
    const archiveBody = needsArchive ? { ...raw, archived: true } : undefined;
    const restoreBody = needsArchive ? { ...raw, archived: false } : undefined;
    const transitionedFingerprint = archiveBody ? sanitizedFingerprint(archiveBody) : targetSnapshot.fingerprint;
    const mutationPlan = needsArchive
      ? dynamicMutationPlan([
          { id: `archive-${args.entityType}`, strategy: "state-command", targetFingerprint: targetSnapshot.fingerprint },
          { id: `delete-${args.entityType}`, strategy: "delete", targetFingerprint: transitionedFingerprint },
          { id: `restore-${args.entityType}`, kind: "compensation", strategy: "update", targetFingerprint: transitionedFingerprint },
        ])
      : dynamicMutationPlan([{ id: `delete-${args.entityType}`, strategy: "delete", targetFingerprint: targetSnapshot.fingerprint }]);
    return {
      actionLabel: `Delete ${args.entityType}`,
      targets: [{ type: args.entityType, id, name }],
      expectedChanges: [`Delete ${args.entityType} ${name ?? id}`],
      reversibility: "This cannot be undone.",
      warnings: [`Deleting a ${args.entityType} is permanent.`],
      payload: { entityType: args.entityType, id, name, needsArchive, archiveBody, restoreBody, transitionedFingerprint },
      targetSnapshots: [targetSnapshot],
      mutationPlan,
    };
  },
  async commit(ctx, payload, operation): Promise<CommitResult> {
    const { entityType, id, name, needsArchive, archiveBody, restoreBody, transitionedFingerprint } = payload as {
      entityType: GenericDeleteType;
      id: string;
      name?: string;
      needsArchive: boolean;
      archiveBody?: Record<string, unknown>;
      restoreBody?: Record<string, unknown>;
      transitionedFingerprint: string;
    };
    let archiveStep: Awaited<ReturnType<typeof executeDurableRiskyStep>> | undefined;
    let deleteIndex = 0;
    if (needsArchive) {
      archiveStep = await executeDurableRiskyStep({
        ctx, operation, planStepId: `archive-${entityType}`, index: 0, name: `Archive ${entityType}`,
        dispatch: async () => {
          const verified = await verifyTargetSnapshots(
            operation.targetSnapshots ?? [],
            (snapshot) => fetchCompositeSnapshot(ctx, snapshot),
          );
          if (!verified.ok) throw new DefinitiveWriteFailure("VERIFY", id, verified.code);
          const dispatched = await dispatchWithReconciliation({
            dispatch: () => entityType === "project"
              ? ctx.clockify.archiveProjectAtomic(id, archiveBody!)
              : ctx.clockify.updateClientAtomic(id, archiveBody!),
            reconcile: async (): Promise<{ id: string; name: string } | undefined> => {
              const current = await readGenericTarget(ctx, entityType, id) as Record<string, unknown> | null | undefined;
              return current?.archived === true
                ? { id, name: typeof current.name === "string" ? current.name : name ?? id }
                : undefined;
            },
          });
          return { externalId: id, effect: { archived: { type: entityType, id } }, detail: { reconciled: dispatched.reconciled } };
        },
      });
      deleteIndex = 1;
      if (archiveStep.status === "outcome_unknown") return errorReceipt({ action: operation.actionName, code: "commit_outcome_unknown", message: `The ${entityType} archive outcome is unknown; delete was not sent.`, recovery: { hint: "Verify the target before retrying.", retryable: false } });
      if (archiveStep.status !== "succeeded") return errorReceipt({ action: operation.actionName, code: "write_failed", message: `The ${entityType} could not be archived; delete was not sent.` });
    }
    const current = await readGenericTarget(ctx, entityType, id);
    if (!current || sanitizedFingerprint(current) !== transitionedFingerprint) {
      return needsArchive
        ? deletePartial(entityType, id, name, `The ${entityType} changed before delete, so delete was not sent.`)
        : errorReceipt({ action: operation.actionName, code: "stale_target", message: `The ${entityType} changed before delete. No delete was sent.`, recovery: { hint: "Create a fresh preview.", retryable: true } });
    }
    const deleted = await executeDurableRiskyStep({
      ctx, operation, planStepId: `delete-${entityType}`, index: deleteIndex, name: `Delete ${entityType}`,
      dispatch: async () => {
        const dispatched = await dispatchWithReconciliation({
          dispatch: async () => { await deleteGenericAtomic(ctx, entityType, id); return true as const; },
          reconcile: () => reconcileDelete(() => readGenericTarget(ctx, entityType, id)),
        });
        return { effect: { deleted: { type: entityType, id } }, detail: { reconciled: dispatched.reconciled } };
      },
    });
    if (deleted.status !== "succeeded") {
      if (!needsArchive || !archiveStep || !restoreBody) {
        return deleted.status === "outcome_unknown"
          ? errorReceipt({ action: operation.actionName, code: "commit_outcome_unknown", message: `The ${entityType} delete outcome is unknown.`, recovery: { hint: "Verify whether it still exists before retrying.", retryable: false } })
          : errorReceipt({ action: operation.actionName, code: "write_failed", message: `The ${entityType} delete was rejected.` });
      }
      if (!ctx.mutationJournal || deleted.status === "outcome_unknown") {
        return deletePartial(entityType, id, name, `The ${entityType} was archived, but delete did not complete definitively; no compensation was dispatched.`);
      }
      const compensation = await executeCompensationStep({
        journal: ctx.mutationJournal,
        operationId: operation.operationId,
        step: {
          id: `restore-${entityType}`,
          index: 2,
          name: `Restore ${entityType}`,
          kind: "compensation",
          compensatesStepId: archiveStep.id,
          targetFingerprint: transitionedFingerprint,
        },
        dispatch: async () => {
          const beforeRestore = await readGenericTarget(ctx, entityType, id);
          if (!beforeRestore || sanitizedFingerprint(beforeRestore) !== transitionedFingerprint) {
            throw new DefinitiveWriteFailure("VERIFY", id, "stale_target");
          }
          const dispatched = await dispatchWithReconciliation({
            dispatch: () => entityType === "project"
              ? ctx.clockify.updateProjectAtomic(id, restoreBody)
              : ctx.clockify.updateClientAtomic(id, restoreBody),
            reconcile: async () => {
              const restored = await readGenericTarget(ctx, entityType, id);
              return restored && sanitizedFingerprint(restored) === sanitizedFingerprint(restoreBody) ? restored : undefined;
            },
          });
          return { externalId: id, effect: { restored: { type: entityType, id } }, detail: { reconciled: dispatched.reconciled } };
        },
      });
      return compensation.status === "compensated"
        ? errorReceipt({ action: operation.actionName, code: "write_failed", message: `Delete was rejected and the ${entityType} archive state was restored.` })
        : deletePartial(entityType, id, name, `Delete was rejected and restoring the ${entityType} did not complete definitively.`);
    }
    return successReceipt({
      action: "clockify_delete_entity",
      entity: entityType,
      ids: { workspaceId: ctx.workspaceId },
      changed: { deleted: [{ type: entityType, id, name }] },
    });
  },
});

/**
 * Fold the shapes the planner emits into the canonical `{ groups: {...} }`:
 * a single `{ group, level }`, or a flat `{ <featureGroup>: <level> }` map. This
 * keeps "set my invoices permission to read-only" from dead-ending on a missing
 * `groups` wrapper (the planner can't see the schema).
 */
function normalizePermissionArgs(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const r = raw as Record<string, unknown>;
  if (r.groups && typeof r.groups === "object") return r;
  if (typeof r.group === "string" && typeof r.level === "string") {
    return { groups: { [r.group]: r.level } };
  }
  const groups: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if ((FEATURE_GROUPS as string[]).includes(k) && typeof v === "string") groups[k] = v;
  }
  return Object.keys(groups).length > 0 ? { groups } : r;
}

const updatePermissions = defineRiskyAction({
  ...ADMIN_API_METADATA.assistant_update_permissions,
  name: "assistant_update_permissions",
  description:
    "Change the admin's OWN assistant access to a feature group — set a group to off, read, or read_write. Use this whenever the admin asks to grant/raise/lower/remove their own access, e.g. 'give me full (read_write) access to reports', 'set invoices to read-only', or 'turn off webhooks'. Not a Clockify write; needs a button save, no Clockify dry-run.",
  group: "workspace_settings",
  risks: ["permission_change"],
  argumentAliases: ["group", "level", ...FEATURE_GROUPS],
  argumentOpenPaths: ["groups"],
  schema: z.preprocess(
    normalizePermissionArgs,
    z.object({
      groups: z
        .record(z.enum(FEATURE_GROUPS as [FeatureGroup, ...FeatureGroup[]]), permissionLevelSchema)
        .refine((g) => Object.keys(g).length > 0, { message: "Specify at least one group to change." }),
    }),
  ),
  async preview(ctx, args) {
    // Compute the diff for the preview without touching Clockify.
    const changes = Object.entries(args.groups).map(
      ([group, level]) => `${group}: ${ctx.policy.groups[group as FeatureGroup]} → ${level}`,
    );
    return {
      actionLabel: "Update assistant permissions",
      targets: [],
      expectedChanges: changes,
      reversibility: "You can change your permissions again at any time.",
      warnings: [],
      payload: { groups: args.groups },
    };
  },
  async commit(ctx, payload) {
    // Applies the patch and persists it via the capability the route injects
    // (`savePolicy`, which owns the store), so the permission commit is
    // self-contained and routes through `commitConfirmedOperation` like every
    // other risky action. The returned receipt matches the prior shape.
    const { groups } = payload as { groups: Partial<Record<FeatureGroup, never>> };
    const nextPolicy = applyPolicyPatch(ctx.policy, { groups });
    ctx.savePolicy?.(nextPolicy);
    return successReceipt({
      action: "assistant_update_permissions",
      entity: "assistant_policy",
      data: { policy: nextPolicy },
      ids: { workspaceId: ctx.workspaceId },
    });
  },
});

/**
 * Where the generic update redirects each non-listable type. The set of types
 * the generic update can actually write is exactly what `genericEntityList`
 * resolves (project/client/tag) — its single source of truth; every OTHER type
 * has a typed per-area action and the preview redirects there instead of letting
 * a doomed operation reach the Confirm button (live: a confirmed time_entry
 * update died at commit with "update not supported" — a previewed action must
 * never fail that way).
 */
const TYPED_UPDATE_ACTION: Partial<Record<(typeof DELETABLE_ENTITY_TYPES)[number], string>> = {
  task: "clockify_tasks_update",
  time_entry: "clockify_fix_entry (supports description/project/task/tags/billable)",
  invoice: "clockify_invoices_update",
  expense: "clockify_expenses_update",
  webhook: "clockify_webhooks_update",
  user: "clockify_users_role_update (role) or clockify_users_deactivate",
  group: "clockify_groups_update",
};

const updateEntity = defineRiskyAction({
  ...ADMIN_API_METADATA.clockify_update_entity,
  name: "clockify_update_entity",
  description:
    "Update simple fields of a project, client, or tag (rename etc.). For every other type use its typed action instead (tasks_update, fix_entry for time entries, invoices_update, expenses_update, webhooks_update, users_role_update, groups_update). Elevated write — always previews and requires confirmation.",
  group: "work_structure",
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({
    source: "confirmed",
    targeting: { mode: "snapshots", relations: ["target"] },
    strategies: ["update"],
  }),
  argumentOpenPaths: ["fields"],
  schema: z.object({
    entityType: z.enum(DELETABLE_ENTITY_TYPES),
    id: z.string().min(1),
    name: z.string().optional(),
    fields: z.record(z.string(), z.unknown()).optional(),
  }),
  resolveFeatureGroup: (args) => ENTITY_GROUP[args.entityType],
  async preview(ctx, args) {
    // Redirect BEFORE resolving: only the types `genericEntityList` lists
    // (project/client/tag) can be written through the generic path — that list
    // IS the single source of truth. Any other type has a typed per-area action,
    // so redirect there instead of letting a doomed operation reach Confirm.
    const list = genericEntityList(ctx, args.entityType);
    if (!list) {
      const typed = TYPED_UPDATE_ACTION[args.entityType];
      return {
        clarify: `The generic update can't change a ${args.entityType} — use ${typed ?? "the matching typed action"} instead.`,
      };
    }
    const fields: Record<string, unknown> = {
      ...(args.name ? { name: args.name } : {}),
      ...(args.fields ?? {}),
    };
    // The listable types are exactly these — a NAME in the id slot resolves
    // here (item 091), never reaches the wire. Unarchiving may target an
    // archived entity.
    const resolved = await resolveEntityRef(
      { id: args.id },
      {
        noun: args.entityType,
        verb: "update",
        list,
        includeArchived: fields.archived === false,
        verifyId: true,
      },
    );
    if (!resolved.ok) return resolved.clarify;
    const raw = await replacementState(ctx, args.entityType as GenericUpdateType, resolved.id);
    if (!raw) return { clarify: `The requested ${args.entityType} no longer exists. Refresh and try again.` };
    const targetSnapshot = captureTargetSnapshot(
      "target",
      { type: args.entityType, id: resolved.id, name: resolved.name },
      raw,
    );
    const body = { ...raw, ...fields };
    return {
      actionLabel: `Update ${args.entityType}`,
      targets: [{ type: args.entityType, id: resolved.id, name: resolved.name ?? args.name }],
      expectedChanges: describePatch(fields),
      reversibility: "You can update the entity again to revert most fields.",
      warnings: ["Updating an entity changes live workspace data."],
      payload: { entityType: args.entityType, id: resolved.id, fields, body },
      targetSnapshots: [targetSnapshot],
      mutationPlan: dynamicMutationPlan([{ id: `update-${args.entityType}`, strategy: "update", targetFingerprint: targetSnapshot.fingerprint }]),
    };
  },
  async commit(ctx, payload, operation) {
    const { entityType, id, body } = payload as {
      entityType: GenericUpdateType;
      id: string;
      body: Record<string, unknown>;
    };
    let updated: { id: string; name?: string } | undefined;
    return commitSingleDurableRiskyStep({
      ctx,
      operation,
      planStepId: `update-${entityType}`,
      name: `Update ${entityType}`,
      verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (snapshot) => fetchCompositeSnapshot(ctx, snapshot) },
      dispatch: async () => {
        const dispatched = await dispatchWithReconciliation({
          dispatch: () => entityType === "project"
            ? ctx.clockify.updateProjectAtomic(id, body)
            : entityType === "client"
              ? ctx.clockify.updateClientAtomic(id, body)
              : ctx.clockify.updateTagAtomic(id, body),
          reconcile: async () => {
            const current = await replacementState(ctx, entityType, id);
            return current && sanitizedFingerprint(current) === sanitizedFingerprint(body)
              ? { id, name: typeof current.name === "string" ? current.name : undefined }
              : undefined;
          },
        });
        updated = dispatched.value;
        return { externalId: id, effect: { updated: { type: entityType, id } }, detail: { reconciled: dispatched.reconciled } };
      },
      success: () => successReceipt({
        action: "clockify_update_entity",
        entity: entityType,
        ids: { workspaceId: ctx.workspaceId },
        changed: { updated: [{ type: entityType, id, name: updated?.name }] },
      }),
    });
  },
});

function deletePartial(
  entityType: string,
  id: string,
  name: string | undefined,
  message: string,
): Extract<CommitResult, { kind: "partial" }> {
  return {
    kind: "partial",
    receipt: successReceipt({ action: "clockify_delete_entity", entity: entityType, changed: { updated: [{ type: entityType, id, name }] } }),
    message,
    recovery: { hint: "Inspect the target state manually before retrying.", retryable: false },
  };
}

const recentOutcomes = defineReadAction({
  ...ADMIN_API_METADATA.assistant_recent_outcomes,
  name: "assistant_recent_outcomes",
  description:
    "Summarize what the assistant actually DID, from the audited action outcomes: per-action success/failure counts, error codes, and confirm/cancel rates. Use this to answer \"what did you do\", \"what failed (today)\", or \"which actions failed most\" — never answer activity-recap questions from chat memory.",
  group: "workspace_settings",
  schema: z
    .object({
      /** Window in hours (default 24 — \"today\"); resolved server-side from ctx.now. */
      sinceHours: z.number().int().positive().max(24 * 30).optional(),
    })
    .strip(),
  async handler(ctx, args) {
    if (!ctx.recentOutcomes) {
      return errorReceipt({
        action: "assistant_recent_outcomes",
        code: "unsupported",
        message: "Action outcomes are not available in this context.",
      });
    }
    const now = ctx.now?.() ?? new Date();
    const sinceIso = new Date(now.getTime() - (args.sinceHours ?? 24) * 3_600_000).toISOString();
    const { outcomes, confirmationStatuses } = ctx.recentOutcomes(sinceIso);
    return successReceipt({
      action: "assistant_recent_outcomes",
      entity: "action_outcomes",
      ids: { workspaceId: ctx.workspaceId },
      data: { since: sinceIso, metrics: buildMetrics(outcomes, confirmationStatuses, now.toISOString()) },
    });
  },
});

const showPermissions = defineReadAction({
  ...ADMIN_API_METADATA.assistant_show_permissions,
  name: "assistant_show_permissions",
  description: "Show the caller's own assistant permissions for this workspace. Read-only.",
  group: "workspace_settings",
  schema: z.object({}).strip(),
  async handler(ctx) {
    return successReceipt({
      action: "assistant_show_permissions",
      entity: "assistant_policy",
      ids: { workspaceId: ctx.workspaceId },
      data: { policy: ctx.policy },
    });
  },
});

export const ADMIN_ACTIONS: ActionDefinition[] = [
  deleteEntity,
  updatePermissions,
  updateEntity,
  showPermissions,
  recentOutcomes,
];
