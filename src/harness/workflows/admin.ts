import { z } from "zod";
import { defineAction, type ActionDefinition } from "../action.js";
import { successReceipt, errorReceipt } from "../receipts.js";
import { applyPolicyPatch, FEATURE_GROUPS, permissionLevelSchema } from "../permissions.js";
import type { FeatureGroup } from "../permissions.js";

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

const deleteEntity = defineAction({
  name: "clockify_delete_entity",
  description: "Delete a Clockify entity. Always previews first and requires confirmation.",
  featureGroup: "work_structure",
  risks: ["destructive"],
  schema: z.object({
    entityType: z.enum(DELETABLE_ENTITY_TYPES),
    id: z.string().min(1),
    name: z.string().optional(),
  }),
  resolveFeatureGroup: (args) => ENTITY_GROUP[args.entityType],
  async handler(ctx, args) {
    const group = ENTITY_GROUP[args.entityType];
    return {
      kind: "preview",
      preview: {
        actionLabel: `Delete ${args.entityType}`,
        featureGroup: group,
        riskLabels: ["destructive"],
        targets: [{ type: args.entityType, id: args.id, name: args.name }],
        expectedChanges: [`Delete ${args.entityType} ${args.name ?? args.id}`],
        reversibility: "This cannot be undone.",
        warnings: [`Deleting a ${args.entityType} is permanent.`],
      },
      operation: {
        actionName: "clockify_delete_entity",
        featureGroup: group,
        risks: ["destructive"],
        payload: { entityType: args.entityType, id: args.id, name: args.name },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { entityType: string; id: string; name?: string };
    if (!ctx.clockify.deleteEntity) {
      return errorReceipt({
        action: "clockify_delete_entity",
        code: "unsupported",
        message: "Delete is not supported by the configured Clockify client.",
      });
    }
    await ctx.clockify.deleteEntity({ entityType: payload.entityType, id: payload.id });
    return successReceipt({
      action: "clockify_delete_entity",
      entity: payload.entityType,
      ids: { workspaceId: ctx.workspaceId },
      changed: { deleted: [{ type: payload.entityType, id: payload.id, name: payload.name }] },
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

const updatePermissions = defineAction({
  name: "assistant_update_permissions",
  description:
    "Change the admin's OWN assistant access to a feature group — set a group to off, read, or read_write. Use this whenever the admin asks to grant/raise/lower/remove their own access, e.g. 'give me full (read_write) access to reports', 'set invoices to read-only', or 'turn off webhooks'. Not a Clockify write; needs a button save, no Clockify dry-run.",
  featureGroup: "workspace_settings",
  risks: ["permission_change"],
  schema: z.preprocess(
    normalizePermissionArgs,
    z.object({
      groups: z
        .record(z.enum(FEATURE_GROUPS as [FeatureGroup, ...FeatureGroup[]]), permissionLevelSchema)
        .refine((g) => Object.keys(g).length > 0, { message: "Specify at least one group to change." }),
    }),
  ),
  async handler(ctx, args) {
    // Compute the diff for the preview without touching Clockify.
    const changes = Object.entries(args.groups).map(
      ([group, level]) => `${group}: ${ctx.policy.groups[group as FeatureGroup]} → ${level}`,
    );
    return {
      kind: "preview",
      preview: {
        actionLabel: "Update assistant permissions",
        featureGroup: "workspace_settings",
        riskLabels: ["permission_change"],
        targets: [],
        expectedChanges: changes,
        reversibility: "You can change your permissions again at any time.",
        warnings: [],
      },
      operation: {
        actionName: "assistant_update_permissions",
        featureGroup: "workspace_settings",
        risks: ["permission_change"],
        payload: { groups: args.groups },
      },
    };
  },
  async commit(ctx, operation) {
    // Applies the patch and returns the new policy. Persistence is the route's
    // responsibility (it owns the store); this keeps policy math in one place.
    const payload = operation.payload as { groups: Partial<Record<FeatureGroup, never>> };
    const nextPolicy = applyPolicyPatch(ctx.policy, { groups: payload.groups });
    return successReceipt({
      action: "assistant_update_permissions",
      entity: "assistant_policy",
      data: { policy: nextPolicy },
      ids: { workspaceId: ctx.workspaceId },
    });
  },
});

const updateEntity = defineAction({
  name: "clockify_update_entity",
  description:
    "Update an entity's fields (rename, reassign, change role/billing). Elevated write — always previews and requires confirmation.",
  featureGroup: "work_structure",
  risks: ["high_risk_write"],
  schema: z.object({
    entityType: z.enum(DELETABLE_ENTITY_TYPES),
    id: z.string().min(1),
    name: z.string().optional(),
    fields: z.record(z.string(), z.unknown()).optional(),
  }),
  resolveFeatureGroup: (args) => ENTITY_GROUP[args.entityType],
  async handler(ctx, args) {
    const group = ENTITY_GROUP[args.entityType];
    const fields = { ...(args.name ? { name: args.name } : {}), ...(args.fields ?? {}) };
    return {
      kind: "preview",
      preview: {
        actionLabel: `Update ${args.entityType}`,
        featureGroup: group,
        riskLabels: ["high_risk_write"],
        targets: [{ type: args.entityType, id: args.id, name: args.name }],
        expectedChanges: Object.keys(fields).map((key) => `set ${key}`),
        reversibility: "You can update the entity again to revert most fields.",
        warnings: ["Updating an entity changes live workspace data."],
      },
      operation: {
        actionName: "clockify_update_entity",
        featureGroup: group,
        risks: ["high_risk_write"],
        payload: { entityType: args.entityType, id: args.id, fields },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as {
      entityType: string;
      id: string;
      fields?: Record<string, unknown>;
    };
    if (!ctx.clockify.updateEntity) {
      return errorReceipt({
        action: "clockify_update_entity",
        code: "unsupported",
        message: "Entity update is not supported by the configured Clockify client.",
      });
    }
    const updated = await ctx.clockify.updateEntity({
      entityType: payload.entityType,
      id: payload.id,
      fields: payload.fields,
    });
    return successReceipt({
      action: "clockify_update_entity",
      entity: payload.entityType,
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: payload.entityType, id: updated.id, name: updated.name }] },
    });
  },
});

const showPermissions = defineAction({
  name: "assistant_show_permissions",
  description: "Show the caller's own assistant permissions for this workspace. Read-only.",
  featureGroup: "workspace_settings",
  risks: ["read"],
  schema: z.object({}).strip(),
  async handler(ctx) {
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "assistant_show_permissions",
        entity: "assistant_policy",
        ids: { workspaceId: ctx.workspaceId },
        data: { policy: ctx.policy },
      }),
    };
  },
});

export const ADMIN_ACTIONS: ActionDefinition[] = [
  deleteEntity,
  updatePermissions,
  updateEntity,
  showPermissions,
];
