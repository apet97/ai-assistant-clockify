import { z } from "zod";
import {
  type ActionContext,
  defineAction,
  defineReadAction,
  defineRiskyAction,
  type ActionDefinition,
} from "../action.js";
import { listReceipt, successReceipt } from "../receipts.js";
import { describePatch, resolveEntityRef } from "./resolve.js";

/** Resolve a currency code or exact id to its workspace currencyId, or clarify. */
async function resolveCurrencyId(
  ctx: ActionContext,
  currency: string,
): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  const currencies = await ctx.clockify.listCurrencies();
  const raw = currency.trim();
  const exactId = currencies.rows.find((candidate) => candidate.id === raw);
  if (exactId) return { ok: true, id: exactId.id };
  const want = raw.toUpperCase();
  const match = currencies.rows.find((c) => c.code.toUpperCase() === want);
  if (currencies.truncated) {
    return {
      ok: false,
      message: `Clockify returned an incomplete currency list, so I can't prove that "${currency}" identifies one currency. Provide the exact currency id or retry with a complete lookup.`,
    };
  }
  if (match) return { ok: true, id: match.id };
  const codes = currencies.rows.map((c) => c.code).join(", ");
  return { ok: false, message: `I don't see a "${currency}" currency in this workspace. Available: ${codes || "(none configured)"}.` };
}

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
    const { rows, truncated } = await ctx.clockify.listClients(args);
    return listReceipt({
      action: "clockify_clients_list",
      entity: "client",
      ids: { workspaceId: ctx.workspaceId },
      rows,
      truncated,
    });
  },
});

const getClient = defineAction({
  name: "clockify_clients_get",
  description: "Fetch a single client by id, or by its exact `name` (resolved server-side).",
  featureGroup: WORK,
  risks: ["read"],
  schema: z
    .object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
    .refine((v) => v.id !== undefined || v.name !== undefined, {
      message: "Provide the client id or its exact name.",
    }),
  async handler(ctx, args) {
    const resolved = await resolveEntityRef(args, {
      noun: "client",
      verb: "fetch",
      list: () => ctx.clockify.listClients(),
    });
    if (!resolved.ok) {
      return { kind: "clarify", message: resolved.clarify.clarify, options: resolved.clarify.options };
    }
    const entity = await ctx.clockify.getClient(resolved.id);
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
  description:
    'Create a client (optional billing `ccEmails` + `currency` by code, e.g. "EUR", or exact currency id). Safe write — executes immediately when policy allows.',
  featureGroup: WORK,
  risks: ["safe_write"],
  schema: z.object({
    name: z.string().min(1),
    ccEmails: z.array(z.string().email()).optional(),
    /** Currency code (e.g. "USD") or exact id, resolved server-side. */
    currency: z.string().min(1).optional(),
  }),
  async handler(ctx, args) {
    let currencyId: string | undefined;
    if (args.currency !== undefined) {
      const cur = await resolveCurrencyId(ctx, args.currency);
      if (!cur.ok) return { kind: "clarify", message: cur.message };
      currencyId = cur.id;
    }
    const client = await ctx.clockify.createClient({
      name: args.name,
      ...(args.ccEmails !== undefined ? { ccEmails: args.ccEmails } : {}),
      ...(currencyId !== undefined ? { currencyId } : {}),
    });
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
    'Update a client (rename, archive/unarchive, set billing `ccEmails`, set `currency` by code e.g. "EUR" or exact id). Pass the client\'s `id`, or its exact `currentName` and the harness resolves it — use this to RENAME (`currentName` + the new `name`) without listing first. Elevated write — previews and requires confirmation.',
  group: WORK,
  risks: ["high_risk_write"],
  argumentOpenPaths: ["fields"],
  schema: z
    .object({
      id: z.string().min(1).optional(),
      /** The client's existing name, resolved to an id server-side (rename-by-name). */
      currentName: z.string().min(1).optional(),
      name: z.string().optional(),
      archived: z.boolean().optional(),
      /** Billing CC recipients (Clockify `ccEmails`); update sticks via getThenPut. */
      ccEmails: z.array(z.string().email()).optional(),
      /** Currency code (e.g. "EUR") or exact id, resolved server-side. */
      currency: z.string().min(1).optional(),
      fields: z.record(z.string(), z.unknown()).optional(),
    })
    .refine((v) => v.id !== undefined || v.currentName !== undefined, {
      message: "Provide the client id or its exact currentName.",
    })
    .refine(
      (v) =>
        v.name !== undefined ||
        v.archived !== undefined ||
        v.ccEmails !== undefined ||
        v.currency !== undefined ||
        v.fields !== undefined,
      { message: "Provide at least one field to change." },
    ),
  async preview(ctx, args) {
    const resolved = await resolveEntityRef(
      { id: args.id, name: args.currentName },
      {
        noun: "client",
        verb: "update",
        list: (filter) => ctx.clockify.listClients(filter),
        // Unarchiving targets an entity that is archived by definition.
        includeArchived: args.archived === false,
      },
    );
    if (!resolved.ok) return resolved.clarify;
    let currencyId: string | undefined;
    if (args.currency !== undefined) {
      const cur = await resolveCurrencyId(ctx, args.currency);
      if (!cur.ok) return { clarify: cur.message };
      currencyId = cur.id;
    }
    const patch: Record<string, unknown> = {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.archived !== undefined ? { archived: args.archived } : {}),
      ...(args.ccEmails !== undefined ? { ccEmails: args.ccEmails } : {}),
      ...(currencyId !== undefined ? { currencyId } : {}),
      ...(args.fields ?? {}),
    };
    return {
      actionLabel: "Update client",
      targets: [{ type: "client", id: resolved.id, name: resolved.name ?? args.name }],
      expectedChanges: describePatch(patch),
      reversibility: "You can update the client again to revert most fields.",
      warnings: ["Updating a client changes live workspace data."],
      payload: { id: resolved.id, patch },
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
    "Delete a client (archives first, then deletes). Pass the client id, or its exact `name` and the harness resolves it. Fails if the client still has active projects. Previews and requires confirmation.",
  group: WORK,
  risks: ["destructive"],
  schema: z
    .object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
    .refine((v) => v.id !== undefined || v.name !== undefined, {
      message: "Provide the client id or its exact name.",
    }),
  async preview(ctx, args) {
    const resolved = await resolveEntityRef(args, {
      noun: "client",
      verb: "delete",
      list: (filter) => ctx.clockify.listClients(filter),
      // Deleting an ARCHIVED client is valid (delete archives first anyway).
      includeArchived: true,
    });
    if (!resolved.ok) return resolved.clarify;
    const name = resolved.name ?? args.name;
    return {
      actionLabel: "Delete client",
      targets: [{ type: "client", id: resolved.id, name }],
      expectedChanges: [`Delete client ${name ?? resolved.id}`],
      reversibility: "This cannot be undone.",
      warnings: [
        "Deleting a client is permanent.",
        "Clockify rejects this if the client still has active projects.",
      ],
      payload: { id: resolved.id, name },
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
