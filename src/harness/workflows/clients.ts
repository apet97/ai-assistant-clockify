import { z } from "zod";
import { defineAction, type ActionDefinition } from "../action.js";
import { successReceipt } from "../receipts.js";

/**
 * Typed client workflows (goclmcp §2.4). Reads + create execute immediately;
 * update/delete are risky and preview→commit. All gated by `work_structure`.
 * `delete` archives then deletes, and surfaces Clockify's error if the client
 * still has active projects.
 */

const WORK = "work_structure" as const;

const listClients = defineAction({
  name: "clockify_clients_list",
  description: "List clients (optional name / archived filter).",
  featureGroup: WORK,
  risks: ["read"],
  schema: z.object({ name: z.string().optional(), archived: z.boolean().optional() }),
  async handler(ctx, args) {
    const items = await ctx.clockify.listClients(args);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_clients_list",
        entity: "client",
        ids: { workspaceId: ctx.workspaceId },
        data: { count: items.length, items },
      }),
    };
  },
});

const getClient = defineAction({
  name: "clockify_clients_get",
  description: "Fetch a single client by id.",
  featureGroup: WORK,
  risks: ["read"],
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const entity = await ctx.clockify.getClient(args.id);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_clients_get",
        entity: "client",
        ids: { workspaceId: ctx.workspaceId },
        data: { entity },
      }),
    };
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

const updateClient = defineAction({
  name: "clockify_clients_update",
  description:
    "Update a client (rename, note, archived). Elevated write — previews and requires confirmation.",
  featureGroup: WORK,
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
  async handler(ctx, args) {
    const patch: Record<string, unknown> = {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.archived !== undefined ? { archived: args.archived } : {}),
      ...(args.fields ?? {}),
    };
    return {
      kind: "preview",
      preview: {
        actionLabel: "Update client",
        featureGroup: WORK,
        riskLabels: ["high_risk_write"],
        targets: [{ type: "client", id: args.id, name: args.name }],
        expectedChanges: Object.keys(patch).map((k) => `set ${k}`),
        reversibility: "You can update the client again to revert most fields.",
        warnings: ["Updating a client changes live workspace data."],
      },
      operation: {
        actionName: "clockify_clients_update",
        featureGroup: WORK,
        risks: ["high_risk_write"],
        payload: { id: args.id, patch },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { id: string; patch: Record<string, unknown> };
    const updated = await ctx.clockify.updateClient(payload.id, payload.patch);
    return successReceipt({
      action: "clockify_clients_update",
      entity: "client",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "client", id: updated.id, name: updated.name }] },
    });
  },
});

const deleteClient = defineAction({
  name: "clockify_clients_delete",
  description:
    "Delete a client (archives first, then deletes). Fails if the client still has active projects. Previews and requires confirmation.",
  featureGroup: WORK,
  risks: ["destructive"],
  schema: z.object({ id: z.string().min(1), name: z.string().optional() }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: "Delete client",
        featureGroup: WORK,
        riskLabels: ["destructive"],
        targets: [{ type: "client", id: args.id, name: args.name }],
        expectedChanges: [`Delete client ${args.name ?? args.id}`],
        reversibility: "This cannot be undone.",
        warnings: [
          "Deleting a client is permanent.",
          "Clockify rejects this if the client still has active projects.",
        ],
      },
      operation: {
        actionName: "clockify_clients_delete",
        featureGroup: WORK,
        risks: ["destructive"],
        payload: { id: args.id, name: args.name },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { id: string; name?: string };
    await ctx.clockify.deleteClient(payload.id);
    return successReceipt({
      action: "clockify_clients_delete",
      entity: "client",
      ids: { workspaceId: ctx.workspaceId },
      changed: { deleted: [{ type: "client", id: payload.id, name: payload.name }] },
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
