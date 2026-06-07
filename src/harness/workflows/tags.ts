import { z } from "zod";
import { defineAction, type ActionDefinition } from "../action.js";
import { successReceipt } from "../receipts.js";

/**
 * Typed tag workflows (goclmcp §2.5). Reads + create execute immediately;
 * update/delete are risky and preview→commit. All gated by `work_structure`.
 */

const WORK = "work_structure" as const;

const listTags = defineAction({
  name: "clockify_tags_list",
  description: "List tags (optional name / archived filter).",
  featureGroup: WORK,
  risks: ["read"],
  schema: z.object({ name: z.string().optional(), archived: z.boolean().optional() }),
  async handler(ctx, args) {
    const items = await ctx.clockify.listTags(args);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_tags_list",
        entity: "tag",
        ids: { workspaceId: ctx.workspaceId },
        data: { count: items.length, items },
      }),
    };
  },
});

const getTag = defineAction({
  name: "clockify_tags_get",
  description: "Fetch a single tag by id.",
  featureGroup: WORK,
  risks: ["read"],
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const entity = await ctx.clockify.getTag(args.id);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_tags_get",
        entity: "tag",
        ids: { workspaceId: ctx.workspaceId },
        data: { entity },
      }),
    };
  },
});

const createTag = defineAction({
  name: "clockify_tags_create",
  description: "Create a tag. Safe write — executes immediately when policy allows.",
  featureGroup: WORK,
  risks: ["safe_write"],
  schema: z.object({ name: z.string().min(1) }),
  async handler(ctx, args) {
    const tag = await ctx.clockify.createTag({ name: args.name });
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_tags_create",
        entity: "tag",
        ids: { workspaceId: ctx.workspaceId },
        changed: { created: [{ type: "tag", id: tag.id, name: tag.name }] },
      }),
    };
  },
});

const updateTag = defineAction({
  name: "clockify_tags_update",
  description:
    "Update a tag (rename, archived). Elevated write — previews and requires confirmation.",
  featureGroup: WORK,
  risks: ["high_risk_write"],
  schema: z
    .object({
      id: z.string().min(1),
      name: z.string().optional(),
      archived: z.boolean().optional(),
    })
    .refine((v) => v.name !== undefined || v.archived !== undefined, {
      message: "Provide at least one field to change.",
    }),
  async handler(ctx, args) {
    const patch: Record<string, unknown> = {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.archived !== undefined ? { archived: args.archived } : {}),
    };
    return {
      kind: "preview",
      preview: {
        actionLabel: "Update tag",
        featureGroup: WORK,
        riskLabels: ["high_risk_write"],
        targets: [{ type: "tag", id: args.id, name: args.name }],
        expectedChanges: Object.keys(patch).map((k) => `set ${k}`),
        reversibility: "You can update the tag again to revert most fields.",
        warnings: ["Updating a tag changes live workspace data."],
      },
      operation: {
        actionName: "clockify_tags_update",
        featureGroup: WORK,
        risks: ["high_risk_write"],
        payload: { id: args.id, patch },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { id: string; patch: Record<string, unknown> };
    const updated = await ctx.clockify.updateTag(payload.id, payload.patch);
    return successReceipt({
      action: "clockify_tags_update",
      entity: "tag",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "tag", id: updated.id, name: updated.name }] },
    });
  },
});

const deleteTag = defineAction({
  name: "clockify_tags_delete",
  description: "Delete a tag. Previews and requires confirmation.",
  featureGroup: WORK,
  risks: ["destructive"],
  schema: z.object({ id: z.string().min(1), name: z.string().optional() }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: "Delete tag",
        featureGroup: WORK,
        riskLabels: ["destructive"],
        targets: [{ type: "tag", id: args.id, name: args.name }],
        expectedChanges: [`Delete tag ${args.name ?? args.id}`],
        reversibility: "This cannot be undone.",
        warnings: ["Deleting a tag is permanent and removes it from tagged entries."],
      },
      operation: {
        actionName: "clockify_tags_delete",
        featureGroup: WORK,
        risks: ["destructive"],
        payload: { id: args.id, name: args.name },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { id: string; name?: string };
    await ctx.clockify.deleteTag(payload.id);
    return successReceipt({
      action: "clockify_tags_delete",
      entity: "tag",
      ids: { workspaceId: ctx.workspaceId },
      changed: { deleted: [{ type: "tag", id: payload.id, name: payload.name }] },
    });
  },
});

export const TAG_ACTIONS: ActionDefinition[] = [listTags, getTag, createTag, updateTag, deleteTag];
