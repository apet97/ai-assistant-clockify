import { z } from "zod";
import {
  defineAction,
  defineReadAction,
  defineRiskyAction,
  defineSafeWriteAction,
  type ActionDefinition,
} from "../action.js";
import { listReceipt, successReceipt } from "../receipts.js";
import { describePatch, resolveEntityRef } from "./resolve.js";

/**
 * Typed tag workflows (goclmcp §2.5). Reads + create execute immediately;
 * update/delete are risky and preview→commit. All gated by `work_structure`.
 */

const WORK = "work_structure" as const;

const listTags = defineReadAction({
  name: "clockify_tags_list",
  description: "List tags (optional name / archived filter).",
  group: WORK,
  schema: z.object({ name: z.string().optional(), archived: z.boolean().optional() }),
  async handler(ctx, args) {
    const { rows, truncated } = await ctx.clockify.listTags(args);
    return listReceipt({
      action: "clockify_tags_list",
      entity: "tag",
      ids: { workspaceId: ctx.workspaceId },
      rows,
      truncated,
    });
  },
});

const getTag = defineAction({
  name: "clockify_tags_get",
  description: "Fetch a single tag by id, or by its exact `name` (resolved server-side).",
  featureGroup: WORK,
  risks: ["read"],
  schema: z
    .object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
    .refine((v) => v.id !== undefined || v.name !== undefined, {
      message: "Provide the tag id or its exact name.",
    }),
  async handler(ctx, args) {
    const resolved = await resolveEntityRef(args, {
      noun: "tag",
      verb: "fetch",
      list: () => ctx.clockify.listTags(),
    });
    if (!resolved.ok) {
      return { kind: "clarify", message: resolved.clarify.clarify, options: resolved.clarify.options };
    }
    const entity = await ctx.clockify.getTag(resolved.id);
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

const createTag = defineSafeWriteAction({
  name: "clockify_tags_create",
  description: "Create a tag. Safe write — executes immediately when policy allows.",
  group: WORK,
  schema: z.object({ name: z.string().trim().min(1) }),
  prepare(_ctx, args) {
    return {
      operation: { body: { name: args.name } },
      mutationPlan: { mode: "single", steps: [{ id: "create-tag", kind: "primary" }] },
    };
  },
  async execute(ctx, operation) {
    const { body } = operation as { body: { name: string } };
    const tag = await ctx.clockify.createTag(body);
    return successReceipt({
      action: "clockify_tags_create",
      entity: "tag",
      ids: { workspaceId: ctx.workspaceId },
      changed: { created: [{ type: "tag", id: tag.id, name: tag.name }] },
    });
  },
});

const updateTag = defineRiskyAction({
  name: "clockify_tags_update",
  description:
    "Update a tag (rename, archived). Pass the tag's `id`, or its exact `currentName` and the harness resolves it — use this to RENAME (`currentName` + the new `name`) without listing first. Elevated write — previews and requires confirmation.",
  group: WORK,
  risks: ["high_risk_write"],
  schema: z
    .object({
      id: z.string().min(1).optional(),
      /** The tag's existing name, resolved to an id server-side (rename-by-name). */
      currentName: z.string().min(1).optional(),
      name: z.string().optional(),
      archived: z.boolean().optional(),
    })
    .refine((v) => v.id !== undefined || v.currentName !== undefined, {
      message: "Provide the tag id or its exact currentName.",
    })
    .refine((v) => v.name !== undefined || v.archived !== undefined, {
      message: "Provide at least one field to change.",
    }),
  async preview(ctx, args) {
    // Resolve currentName → id (the delete-by-name pattern, including a name
    // passed in the id slot) so a rename never dead-ends on a missing id.
    // Ambiguous identity stops and asks.
    const resolved = await resolveEntityRef(
      { id: args.id, name: args.currentName },
      {
        noun: "tag",
        verb: "update",
        list: (filter) => ctx.clockify.listTags(filter),
        // Unarchiving targets an entity that is archived by definition.
        includeArchived: args.archived === false,
      },
    );
    if (!resolved.ok) return resolved.clarify;
    const id = resolved.id;
    const targetName = resolved.name ?? args.currentName;
    const patch: Record<string, unknown> = {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.archived !== undefined ? { archived: args.archived } : {}),
    };
    return {
      actionLabel: "Update tag",
      targets: [{ type: "tag", id, name: targetName ?? args.name }],
      expectedChanges: describePatch(patch),
      reversibility: "You can update the tag again to revert most fields.",
      warnings: ["Updating a tag changes live workspace data."],
      payload: { id, patch },
    };
  },
  async commit(ctx, payload) {
    const { id, patch } = payload as { id: string; patch: Record<string, unknown> };
    const updated = await ctx.clockify.updateTag(id, patch);
    return successReceipt({
      action: "clockify_tags_update",
      entity: "tag",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "tag", id: updated.id, name: updated.name }] },
    });
  },
});

const deleteTag = defineRiskyAction({
  name: "clockify_tags_delete",
  description:
    "Delete a tag. Pass the tag's id (preferred — list tags first to get it), or its exact name and the harness resolves it to an id. Previews and requires confirmation.",
  group: WORK,
  risks: ["destructive"],
  schema: z
    .object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
    .refine((v) => v.id !== undefined || v.name !== undefined, {
      message: "Provide the tag id or its exact name.",
    }),
  async preview(ctx, args) {
    // Resolve a name → id (including a name passed in the id slot), so a delete
    // never dead-ends or commits a doomed id. Ambiguous identity stops and asks.
    const resolved = await resolveEntityRef(args, {
      noun: "tag",
      verb: "delete",
      list: (filter) => ctx.clockify.listTags(filter),
      // Deleting an ARCHIVED tag is valid.
      includeArchived: true,
    });
    if (!resolved.ok) return resolved.clarify;
    const { id } = resolved;
    const name = resolved.name ?? args.name;
    return {
      actionLabel: "Delete tag",
      targets: [{ type: "tag", id, name }],
      expectedChanges: [`Delete tag ${name ?? id}`],
      reversibility: "This cannot be undone.",
      warnings: ["Deleting a tag is permanent and removes it from tagged entries."],
      payload: { id, name },
    };
  },
  async commit(ctx, payload) {
    const { id, name } = payload as { id: string; name?: string };
    await ctx.clockify.deleteTag(id);
    return successReceipt({
      action: "clockify_tags_delete",
      entity: "tag",
      ids: { workspaceId: ctx.workspaceId },
      changed: { deleted: [{ type: "tag", id, name }] },
    });
  },
});

export const TAG_ACTIONS: ActionDefinition[] = [listTags, getTag, createTag, updateTag, deleteTag];
