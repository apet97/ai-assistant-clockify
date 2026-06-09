import { z } from "zod";
import { defineReadAction, defineRiskyAction, type ActionDefinition } from "../action.js";
import { successReceipt } from "../receipts.js";

/**
 * Typed custom-field workflows (goclmcp §2.8). Reads (list/get) execute
 * immediately; create/update/delete + set-value are risky and run preview→commit.
 * Risk classes: create/update/set-value = `high_risk_write`; delete adds
 * `destructive`. All gated by the `custom_fields` feature group — these are real
 * Clockify admin writes, so they use `high_risk_write` (which keeps BOTH the
 * confirmation and the policy gate), never `permission_change` (which would
 * bypass the gate). `fieldType` is case-sensitive on the wire.
 */

const CF = "custom_fields" as const;

const fieldTypeSchema = z.enum([
  "TXT",
  "NUMBER",
  "DROPDOWN_SINGLE",
  "DROPDOWN_MULTIPLE",
  "CHECKBOX",
  "LINK",
]);

/** A custom-field value the model may set (text/number/checkbox/link/dropdown). */
const valueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

const isDropdown = (t: string): boolean => t === "DROPDOWN_SINGLE" || t === "DROPDOWN_MULTIPLE";

const listCustomFields = defineReadAction({
  name: "clockify_custom_fields_list",
  description: "List the workspace custom fields.",
  group: CF,
  schema: z.object({}),
  async handler(ctx) {
    const items = await ctx.clockify.listCustomFields();
    return successReceipt({
      action: "clockify_custom_fields_list",
      entity: "custom_field",
      ids: { workspaceId: ctx.workspaceId },
      data: { count: items.length, items },
    });
  },
});

const getCustomField = defineReadAction({
  name: "clockify_custom_fields_get",
  description: "Fetch a single custom field by id.",
  group: CF,
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const entity = await ctx.clockify.getCustomField(args.id);
    return successReceipt({
      action: "clockify_custom_fields_get",
      entity: "custom_field",
      ids: { workspaceId: ctx.workspaceId },
      data: { entity },
    });
  },
});

const createCustomField = defineRiskyAction({
  name: "clockify_custom_fields_create",
  description:
    "Create a custom field (TXT/NUMBER/DROPDOWN_SINGLE/DROPDOWN_MULTIPLE/CHECKBOX/LINK). Elevated write — previews and requires confirmation. Dropdowns require allowedValues.",
  group: CF,
  risks: ["high_risk_write"],
  schema: z
    .object({
      name: z.string().min(1),
      fieldType: fieldTypeSchema,
      allowedValues: z.array(z.string().min(1)).optional(),
      required: z.boolean().optional(),
      status: z.string().optional(),
    })
    .refine(
      (v) => !isDropdown(v.fieldType) || (Array.isArray(v.allowedValues) && v.allowedValues.length > 0),
      { message: "allowedValues is required for DROPDOWN_SINGLE / DROPDOWN_MULTIPLE." },
    ),
  async preview(_ctx, args) {
    const input = {
      name: args.name,
      type: args.fieldType,
      ...(args.allowedValues !== undefined ? { allowedValues: args.allowedValues } : {}),
      ...(args.required !== undefined ? { required: args.required } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
    };
    return {
      actionLabel: "Create custom field",
      targets: [],
      expectedChanges: [`Create ${args.fieldType} custom field "${args.name}"`],
      reversibility: "You can update or delete the custom field afterward.",
      warnings: ["This adds a custom field to the workspace."],
      payload: { input },
    };
  },
  async commit(ctx, payload) {
    const { input } = payload as { input: Parameters<typeof ctx.clockify.createCustomField>[0] };
    const field = await ctx.clockify.createCustomField(input);
    return successReceipt({
      action: "clockify_custom_fields_create",
      entity: "custom_field",
      ids: { workspaceId: ctx.workspaceId },
      changed: { created: [{ type: "custom_field", id: field.id, name: field.name }] },
    });
  },
});

const updateCustomField = defineRiskyAction({
  name: "clockify_custom_fields_update",
  description:
    "Update a custom field (name/type/allowedValues/required/status). Elevated write — previews and requires confirmation.",
  group: CF,
  risks: ["high_risk_write"],
  schema: z
    .object({
      id: z.string().min(1),
      name: z.string().optional(),
      fieldType: fieldTypeSchema.optional(),
      allowedValues: z.array(z.string().min(1)).optional(),
      required: z.boolean().optional(),
      status: z.string().optional(),
    })
    .refine(
      (v) =>
        v.name !== undefined ||
        v.fieldType !== undefined ||
        v.allowedValues !== undefined ||
        v.required !== undefined ||
        v.status !== undefined,
      { message: "Provide at least one field to change." },
    ),
  async preview(_ctx, args) {
    const patch = {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.fieldType !== undefined ? { type: args.fieldType } : {}),
      ...(args.allowedValues !== undefined ? { allowedValues: args.allowedValues } : {}),
      ...(args.required !== undefined ? { required: args.required } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
    };
    return {
      actionLabel: "Update custom field",
      targets: [{ type: "custom_field", id: args.id, ...(args.name !== undefined ? { name: args.name } : {}) }],
      expectedChanges: Object.keys(patch).map((k) => `set ${k}`),
      reversibility: "You can update the custom field again to revert most fields.",
      warnings: ["This changes a workspace custom field."],
      payload: { id: args.id, patch },
    };
  },
  async commit(ctx, payload) {
    const { id, patch } = payload as {
      id: string;
      patch: Parameters<typeof ctx.clockify.updateCustomField>[1];
    };
    const updated = await ctx.clockify.updateCustomField(id, patch);
    return successReceipt({
      action: "clockify_custom_fields_update",
      entity: "custom_field",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "custom_field", id: updated.id, name: updated.name }] },
    });
  },
});

const deleteCustomField = defineRiskyAction({
  name: "clockify_custom_fields_delete",
  description: "Delete a custom field. Destructive — previews and requires confirmation.",
  group: CF,
  risks: ["destructive"],
  schema: z.object({ id: z.string().min(1), name: z.string().optional() }),
  async preview(_ctx, args) {
    return {
      actionLabel: "Delete custom field",
      targets: [{ type: "custom_field", id: args.id, name: args.name }],
      expectedChanges: [`Delete custom field ${args.name ?? args.id}`],
      reversibility: "This cannot be undone.",
      warnings: ["Deleting a custom field removes its values from all entities."],
      payload: { id: args.id, name: args.name },
    };
  },
  async commit(ctx, payload) {
    const { id, name } = payload as { id: string; name?: string };
    await ctx.clockify.deleteCustomField(id);
    return successReceipt({
      action: "clockify_custom_fields_delete",
      entity: "custom_field",
      ids: { workspaceId: ctx.workspaceId },
      changed: { deleted: [{ type: "custom_field", id, name }] },
    });
  },
});

const setValueProject = defineRiskyAction({
  name: "clockify_custom_fields_set_value_project",
  description:
    "Set a custom field value on a project. Elevated write — previews and requires confirmation.",
  group: CF,
  risks: ["high_risk_write"],
  schema: z.object({ projectId: z.string().min(1), fieldId: z.string().min(1), value: valueSchema }),
  async preview(_ctx, args) {
    return {
      actionLabel: "Set project custom field value",
      targets: [{ type: "project", id: args.projectId }],
      expectedChanges: [`Set custom field ${args.fieldId} on project ${args.projectId}`],
      reversibility: "You can set a new value at any time.",
      warnings: ["This changes a project's custom field value."],
      payload: { projectId: args.projectId, fieldId: args.fieldId, value: args.value },
    };
  },
  async commit(ctx, payload) {
    const { projectId, fieldId, value } = payload as { projectId: string; fieldId: string; value: unknown };
    await ctx.clockify.setProjectCustomFieldValue(projectId, fieldId, value);
    return successReceipt({
      action: "clockify_custom_fields_set_value_project",
      entity: "project",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "project", id: projectId }] },
    });
  },
});

const setValueEntry = defineRiskyAction({
  name: "clockify_custom_fields_set_value_entry",
  description:
    "Set a custom field value on a time entry. Elevated write — previews and requires confirmation.",
  group: CF,
  risks: ["high_risk_write"],
  schema: z.object({ entryId: z.string().min(1), fieldId: z.string().min(1), value: valueSchema }),
  async preview(_ctx, args) {
    return {
      actionLabel: "Set time-entry custom field value",
      targets: [{ type: "time_entry", id: args.entryId }],
      expectedChanges: [`Set custom field ${args.fieldId} on time entry ${args.entryId}`],
      reversibility: "You can set a new value at any time.",
      warnings: ["This changes a time entry's custom field value."],
      payload: { entryId: args.entryId, fieldId: args.fieldId, value: args.value },
    };
  },
  async commit(ctx, payload) {
    const { entryId, fieldId, value } = payload as { entryId: string; fieldId: string; value: unknown };
    await ctx.clockify.setEntryCustomFieldValue(entryId, fieldId, value);
    return successReceipt({
      action: "clockify_custom_fields_set_value_entry",
      entity: "time_entry",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "time_entry", id: entryId }] },
    });
  },
});

export const CUSTOM_FIELD_ACTIONS: ActionDefinition[] = [
  listCustomFields,
  getCustomField,
  createCustomField,
  updateCustomField,
  deleteCustomField,
  setValueProject,
  setValueEntry,
];
