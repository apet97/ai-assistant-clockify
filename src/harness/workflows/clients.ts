import { z } from "zod";
import {
  defineAction,
  defineReadAction,
  defineRiskyAction,
  type ActionDefinition,
} from "../action.js";
import { successReceipt } from "../receipts.js";

/**
 * Typed client workflows (goclmcp §2.4). Reads + create execute immediately;
 * update/delete are risky and preview→commit. All gated by `work_structure`.
 * `delete` archives then deletes, and surfaces Clockify's error if the client
 * still has active projects.
 */

const WORK = "work_structure" as const;

const listClients = defineReadAction({
  name: "clockify_clients_list",
  description: "List clients (optional name / archived filter).",
  group: WORK,
  schema: z.object({ name: z.string().optional(), archived: z.boolean().optional() }),
  async handler(ctx, args) {
    const items = await ctx.clockify.listClients(args);
    return successReceipt({
      action: "clockify_clients_list",
      entity: "client",
      ids: { workspaceId: ctx.workspaceId },
      data: { count: items.length, items },
    });
  },
});

const getClient = defineReadAction({
  name: "clockify_clients_get",
  description: "Fetch a single client by id.",
  group: WORK,
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const entity = await ctx.clockify.getClient(args.id);
    return successReceipt({
      action: "clockify_clients_get",
      entity: "client",
      ids: { workspaceId: ctx.workspaceId },
      data: { entity },
    });
  },
});

const createClient = defineAction({
  name: "clockify_clients_create",
  description: "Create a client. Safe write — executes immediately when policy allows.",
  featureGroup: WORK,
  risks: ["safe_write"],
  schema: z.object({ name: z.string().min(1) }),
  async handler(ctx, args) {
    const client = await ctx.clockify.createClient({ name: args.name });
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_clients_create",
        entity: "client",
        ids: { workspaceId: ctx.workspaceId },
        changed: { created: [{ type: "client", id: client.id, name: client.name }] },
      }),
    };
  },
});

const updateClient = defineRiskyAction({
  name: "clockify_clients_update",
  description:
    "Update a client (rename, note, archived). Elevated write — previews and requires confirmation.",
  group: WORK,
  risks: ["high_risk_write"],
  schema: z
    .object({
      id: z.string().min(1),
      name: z.string().optional(),
      archived: z.boolean().optional(),
      fields: z.record(z.string(), z.unknown()).optional(),
    })
    .refine((v) => v.name !== undefined || v.archived !== undefined || v.fields !== undefined, {
      message: "Provide at least one field to change.",
    }),
  async preview(_ctx, args) {
    const patch: Record<string, unknown> = {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.archived !== undefined ? { archived: args.archived } : {}),
      ...(args.fields ?? {}),
    };
    return {
      actionLabel: "Update client",
      targets: [{ type: "client", id: args.id, name: args.name }],
      expectedChanges: Object.keys(patch).map((k) => `set ${k}`),
      reversibility: "You can update the client again to revert most fields.",
      warnings: ["Updating a client changes live workspace data."],
      payload: { id: args.id, patch },
    };
  },
  async commit(ctx, payload) {
    const { id, patch } = payload as { id: string; patch: Record<string, unknown> };
    const updated = await ctx.clockify.updateClient(id, patch);
    return successReceipt({
      action: "clockify_clients_update",
      entity: "client",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "client", id: updated.id, name: updated.name }] },
    });
  },
});

const deleteClient = defineRiskyAction({
  name: "clockify_clients_delete",
  description:
    "Delete a client (archives first, then deletes). Fails if the client still has active projects. Previews and requires confirmation.",
  group: WORK,
  risks: ["destructive"],
  schema: z.object({ id: z.string().min(1), name: z.string().optional() }),
  async preview(_ctx, args) {
    return {
      actionLabel: "Delete client",
      targets: [{ type: "client", id: args.id, name: args.name }],
      expectedChanges: [`Delete client ${args.name ?? args.id}`],
      reversibility: "This cannot be undone.",
      warnings: [
        "Deleting a client is permanent.",
        "Clockify rejects this if the client still has active projects.",
      ],
      payload: { id: args.id, name: args.name },
    };
  },
  async commit(ctx, payload) {
    const { id, name } = payload as { id: string; name?: string };
    await ctx.clockify.deleteClient(id);
    return successReceipt({
      action: "clockify_clients_delete",
      entity: "client",
      ids: { workspaceId: ctx.workspaceId },
      changed: { deleted: [{ type: "client", id, name }] },
    });
  },
});

export const CLIENT_ACTIONS: ActionDefinition[] = [
  listClients,
  getClient,
  createClient,
  updateClient,
  deleteClient,
];
