import { z } from "zod";
import { defineAction, type ActionDefinition } from "../action.js";
import { successReceipt } from "../receipts.js";
import { resolveEntityRef } from "./resolve.js";

/**
 * Typed workspace & project-template workflows (goclmcp §2.16–2.17). All reads.
 * `workspace_get` is gated by `workspace_settings`; templates by `work_structure`
 * (they are projects). Creating a template folds into clockify_projects_create
 * with isTemplate — not a new write here.
 */

const getWorkspace = defineAction({
  name: "clockify_workspace_get",
  description: "Get the current workspace's settings and info.",
  featureGroup: "workspace_settings",
  risks: ["read"],
  schema: z.object({}),
  async handler(ctx) {
    const workspace = await ctx.clockify.getWorkspace();
    return { kind: "receipt", receipt: successReceipt({ action: "clockify_workspace_get", entity: "workspace", ids: { workspaceId: ctx.workspaceId }, data: { workspace } }) };
  },
});

const listTemplates = defineAction({
  name: "clockify_templates_list",
  description: "List project templates in the workspace.",
  featureGroup: "work_structure",
  risks: ["read"],
  schema: z.object({}),
  async handler(ctx) {
    const items = await ctx.clockify.listTemplates();
    return { kind: "receipt", receipt: successReceipt({ action: "clockify_templates_list", entity: "template", ids: { workspaceId: ctx.workspaceId }, data: { count: items.length, items } }) };
  },
});

const getTemplate = defineAction({
  name: "clockify_templates_get",
  description: "Fetch a single project template by id, or by its exact `name` (resolved server-side).",
  featureGroup: "work_structure",
  risks: ["read"],
  schema: z
    .object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
    .refine((v) => v.id !== undefined || v.name !== undefined, {
      message: "Provide the template id or its exact name.",
    }),
  async handler(ctx, args) {
    const resolved = await resolveEntityRef(args, {
      noun: "template",
      verb: "fetch",
      list: () => ctx.clockify.listTemplates(),
    });
    if (!resolved.ok) {
      return { kind: "clarify", message: resolved.clarify.clarify, options: resolved.clarify.options };
    }
    const entity = await ctx.clockify.getTemplate(resolved.id);
    return { kind: "receipt", receipt: successReceipt({ action: "clockify_templates_get", entity: "template", ids: { workspaceId: ctx.workspaceId }, data: { entity } }) };
  },
});

export const WORKSPACE_ACTIONS: ActionDefinition[] = [getWorkspace, listTemplates, getTemplate];
