import { z } from "zod";
import { defineAction, type ActionDefinition } from "../action.js";
import { successReceipt, errorReceipt } from "../receipts.js";
import { applyPolicyPatch, FEATURE_GROUPS, permissionLevelSchema } from "../permissions.js";
import type { FeatureGroup } from "../permissions.js";
import type { RiskLabel } from "../risk.js";

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

const prepareInvoice = defineAction({
  name: "clockify_prepare_invoice",
  description: "Prepare a draft invoice for a client. Billing action — previews first.",
  featureGroup: "invoices",
  risks: ["billing"],
  schema: z.object({
    clientId: z.string().min(1),
    clientName: z.string().optional(),
    title: z.string().optional(),
  }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: "Prepare draft invoice",
        featureGroup: "invoices",
        riskLabels: ["billing"],
        targets: [{ type: "client", id: args.clientId, name: args.clientName }],
        expectedChanges: [`Create a draft invoice for ${args.clientName ?? args.clientId}`],
        reversibility: "You can delete the draft invoice afterward.",
        warnings: ["This creates a billing document."],
      },
      operation: {
        actionName: "clockify_prepare_invoice",
        featureGroup: "invoices",
        risks: ["billing"],
        payload: { clientId: args.clientId, title: args.title },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { clientId: string; title?: string };
    if (!ctx.clockify.createInvoice) {
      return errorReceipt({
        action: "clockify_prepare_invoice",
        code: "unsupported",
        message: "Invoice creation is not supported by the configured Clockify client.",
      });
    }
    const invoice = await ctx.clockify.createInvoice({
      clientId: payload.clientId,
      title: payload.title,
    });
    return successReceipt({
      action: "clockify_prepare_invoice",
      entity: "invoice",
      ids: { workspaceId: ctx.workspaceId },
      changed: { created: [{ type: "invoice", id: invoice.id, name: invoice.name }] },
    });
  },
});

const manageWebhook = defineAction({
  name: "clockify_manage_webhook",
  description: "Create, update, or delete a webhook. External side effect — previews first.",
  featureGroup: "webhooks",
  risks: ["external_side_effect"],
  schema: z.object({
    operation: z.enum(["create", "update", "delete"]),
    id: z.string().optional(),
    name: z.string().optional(),
    url: z.string().optional(),
  }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: `${args.operation} webhook`,
        featureGroup: "webhooks",
        riskLabels: ["external_side_effect"],
        targets: args.id ? [{ type: "webhook", id: args.id, name: args.name }] : [],
        expectedChanges: [`${args.operation} a webhook${args.url ? ` → ${args.url}` : ""}`],
        reversibility: "Webhook changes affect external delivery immediately.",
        warnings: ["This changes outbound webhook delivery."],
      },
      operation: {
        actionName: "clockify_manage_webhook",
        featureGroup: "webhooks",
        risks: ["external_side_effect"],
        payload: { operation: args.operation, id: args.id, name: args.name, url: args.url },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as {
      operation: "create" | "update" | "delete";
      id?: string;
      name?: string;
      url?: string;
    };
    if (!ctx.clockify.manageWebhook) {
      return errorReceipt({
        action: "clockify_manage_webhook",
        code: "unsupported",
        message: "Webhook management is not supported by the configured Clockify client.",
      });
    }
    const result = await ctx.clockify.manageWebhook(payload);
    const ref = result
      ? [{ type: "webhook", id: result.id, name: result.name }]
      : payload.id
        ? [{ type: "webhook", id: payload.id, name: payload.name }]
        : [];
    const bucket = payload.operation === "delete" ? "deleted" : payload.operation === "create" ? "created" : "updated";
    return successReceipt({
      action: "clockify_manage_webhook",
      entity: "webhook",
      ids: { workspaceId: ctx.workspaceId },
      changed: { [bucket]: ref },
    });
  },
});

const updatePermissions = defineAction({
  name: "assistant_update_permissions",
  description:
    "Change the admin's own assistant permissions. Not a Clockify write; needs a button save, no Clockify dry-run.",
  featureGroup: "workspace_settings",
  risks: ["permission_change"],
  schema: z.object({
    groups: z
      .record(z.enum(FEATURE_GROUPS as [FeatureGroup, ...FeatureGroup[]]), permissionLevelSchema)
      .refine((g) => Object.keys(g).length > 0, { message: "Specify at least one group to change." }),
  }),
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

const manageExpense = defineAction({
  name: "clockify_manage_expense",
  description:
    "Create, update, or delete an expense. Elevated/destructive — always previews and requires confirmation.",
  featureGroup: "expenses",
  risks: ["high_risk_write"],
  schema: z.object({
    operation: z.enum(["create", "update", "delete"]),
    id: z.string().optional(),
    name: z.string().optional(),
    amount: z.number().optional(),
  }),
  async handler(ctx, args) {
    const destructive = args.operation === "delete";
    const riskLabels: RiskLabel[] = destructive ? ["destructive"] : ["high_risk_write"];
    return {
      kind: "preview",
      preview: {
        actionLabel: `${args.operation} expense`,
        featureGroup: "expenses",
        riskLabels,
        targets: args.id ? [{ type: "expense", id: args.id, name: args.name }] : [],
        expectedChanges: [`${args.operation} an expense${args.name ? ` "${args.name}"` : ""}`],
        reversibility: destructive
          ? "Deleting an expense cannot be undone."
          : "You can edit or delete the expense afterward.",
        warnings: destructive
          ? ["Deleting an expense is permanent."]
          : ["This changes expense records."],
      },
      operation: {
        actionName: "clockify_manage_expense",
        featureGroup: "expenses",
        risks: riskLabels,
        payload: { operation: args.operation, id: args.id, name: args.name, amount: args.amount },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as {
      operation: "create" | "update" | "delete";
      id?: string;
      name?: string;
      amount?: number;
    };
    if (!ctx.clockify.manageExpense) {
      return errorReceipt({
        action: "clockify_manage_expense",
        code: "unsupported",
        message: "Expense management is not supported by the configured Clockify client.",
      });
    }
    const result = await ctx.clockify.manageExpense(payload);
    const ref = result
      ? [{ type: "expense", id: result.id, name: result.name }]
      : payload.id
        ? [{ type: "expense", id: payload.id, name: payload.name }]
        : [];
    const bucket =
      payload.operation === "delete" ? "deleted" : payload.operation === "create" ? "created" : "updated";
    return successReceipt({
      action: "clockify_manage_expense",
      entity: "expense",
      ids: { workspaceId: ctx.workspaceId },
      changed: { [bucket]: ref },
    });
  },
});

const manageTimeOff = defineAction({
  name: "clockify_manage_time_off",
  description:
    "Approve or deny a time-off request. External side effect — always previews and requires confirmation.",
  featureGroup: "time_off_approvals",
  risks: ["external_side_effect"],
  schema: z.object({
    decision: z.enum(["approve", "deny"]),
    requestId: z.string().min(1),
  }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: `${args.decision} time-off request`,
        featureGroup: "time_off_approvals",
        riskLabels: ["external_side_effect"],
        targets: [{ type: "time_off_request", id: args.requestId }],
        expectedChanges: [`${args.decision} time-off request ${args.requestId}`],
        reversibility: "Approval decisions notify the requester and may be hard to reverse.",
        warnings: ["This notifies the requester and changes their balance/schedule."],
      },
      operation: {
        actionName: "clockify_manage_time_off",
        featureGroup: "time_off_approvals",
        risks: ["external_side_effect"],
        payload: { requestId: args.requestId, decision: args.decision },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { requestId: string; decision: "approve" | "deny" };
    if (!ctx.clockify.manageTimeOff) {
      return errorReceipt({
        action: "clockify_manage_time_off",
        code: "unsupported",
        message: "Time-off management is not supported by the configured Clockify client.",
      });
    }
    const result = await ctx.clockify.manageTimeOff(payload);
    return successReceipt({
      action: "clockify_manage_time_off",
      entity: "time_off_request",
      ids: { workspaceId: ctx.workspaceId },
      changed: {
        updated: result
          ? [{ type: "time_off_request", id: result.id, name: result.name }]
          : [{ type: "time_off_request", id: payload.requestId }],
      },
    });
  },
});

const manageSchedule = defineAction({
  name: "clockify_manage_schedule",
  description: "Publish a schedule. External side effect — always previews and requires confirmation.",
  featureGroup: "scheduling",
  risks: ["external_side_effect"],
  schema: z.object({
    operation: z.enum(["publish"]),
    id: z.string().optional(),
  }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: `${args.operation} schedule`,
        featureGroup: "scheduling",
        riskLabels: ["external_side_effect"],
        targets: args.id ? [{ type: "schedule", id: args.id }] : [],
        expectedChanges: [`${args.operation} the schedule`],
        reversibility: "Publishing notifies assignees; unpublishing may be required to revert.",
        warnings: ["Publishing a schedule notifies assignees."],
      },
      operation: {
        actionName: "clockify_manage_schedule",
        featureGroup: "scheduling",
        risks: ["external_side_effect"],
        payload: { operation: args.operation, id: args.id },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { operation: "publish"; id?: string };
    if (!ctx.clockify.manageSchedule) {
      return errorReceipt({
        action: "clockify_manage_schedule",
        code: "unsupported",
        message: "Schedule management is not supported by the configured Clockify client.",
      });
    }
    const result = await ctx.clockify.manageSchedule(payload);
    return successReceipt({
      action: "clockify_manage_schedule",
      entity: "schedule",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: result ? [{ type: "schedule", id: result.id, name: result.name }] : [] },
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
  prepareInvoice,
  manageWebhook,
  updatePermissions,
  updateEntity,
  manageExpense,
  manageTimeOff,
  manageSchedule,
  showPermissions,
];
