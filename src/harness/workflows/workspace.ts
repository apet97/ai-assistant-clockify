import { z } from "zod";
import { defineAction, type ActionDefinition } from "../action.js";
import { successReceipt } from "../receipts.js";

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
  description: "Fetch a single project template by id.",
  featureGroup: "work_structure",
  risks: ["read"],
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const entity = await ctx.clockify.getTemplate(args.id);
    return { kind: "receipt", receipt: successReceipt({ action: "clockify_templates_get", entity: "template", ids: { workspaceId: ctx.workspaceId }, data: { entity } }) };
  },
});

export const WORKSPACE_ACTIONS: ActionDefinition[] = [getWorkspace, listTemplates, getTemplate];
