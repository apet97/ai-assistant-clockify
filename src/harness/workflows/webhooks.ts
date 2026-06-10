import { z } from "zod";
import {
  defineReadAction,
  defineRiskyAction,
  type ActionContext,
  type ActionDefinition,
} from "../action.js";
import { successReceipt } from "../receipts.js";

/**
 * Clockify refuses the ENTIRE webhooks API for add-on tokens — no manifest
 * scope can grant it (probed live 2026-06-10). A webhook write must surface
 * that at PREVIEW time so the admin is never told to confirm a doomed change
 * (live item 248); the reads already fail honestly at call time.
 */
function addonWebhookRestriction(ctx: ActionContext): { clarify: string } | undefined {
  if (ctx.clockify.authClass !== "addon") return undefined;
  return {
    clarify:
      "Clockify does not allow add-ons to call the webhooks API — no manifest scope can grant it, so I can't change webhooks from inside this add-on. This is a Clockify platform restriction, not one of your assistant permissions. Webhooks can be managed in Clockify's workspace settings or with a personal API key.",
  };
}

/**
 * Typed webhook workflows (goclmcp §2.12). Reads (list/get/events/logs) execute
 * immediately; create/update/delete run preview→commit. Risk: create/update =
 * external_side_effect (they configure outbound deliveries); delete =
 * destructive + external_side_effect. All gated by `webhooks`. The HMAC
 * `authToken` secret is NEVER accepted from the model (not in the schema) nor
 * stored in a payload — supersedes the generic clockify_manage_webhook.
 */

const WH = "webhooks" as const;

/** HTTPS URL with no loopback/private host (Clockify rejects those). */
const httpsUrl = z
  .string()
  .url()
  .refine((u) => u.toLowerCase().startsWith("https://"), { message: "Webhook URL must use HTTPS." })
  .refine((u) => {
    try {
      const host = new URL(u).hostname.toLowerCase();
      return !(host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local"));
    } catch {
      return false;
    }
  }, { message: "Webhook URL cannot target a loopback/local address." });

const listWebhooks = defineReadAction({
  name: "clockify_webhooks_list",
  description: "List webhooks in the workspace.",
  group: WH,
  schema: z.object({}),
  async handler(ctx) {
    const items = await ctx.clockify.listWebhooks();
    return successReceipt({ action: "clockify_webhooks_list", entity: "webhook", ids: { workspaceId: ctx.workspaceId }, data: { count: items.length, items } });
  },
});

const getWebhook = defineReadAction({
  name: "clockify_webhooks_get",
  description: "Fetch a single webhook by id (the signing secret is never returned).",
  group: WH,
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const entity = await ctx.clockify.getWebhook(args.id);
    return successReceipt({ action: "clockify_webhooks_get", entity: "webhook", ids: { workspaceId: ctx.workspaceId }, data: { entity } });
  },
});

const listEvents = defineReadAction({
  name: "clockify_webhooks_events",
  description: "List the available webhook event types.",
  group: WH,
  schema: z.object({}),
  async handler(ctx) {
    const events = await ctx.clockify.listWebhookEvents();
    return successReceipt({ action: "clockify_webhooks_events", entity: "webhook", ids: { workspaceId: ctx.workspaceId }, data: { count: events.length, events } });
  },
});

const listLogs = defineReadAction({
  name: "clockify_webhooks_logs",
  description: "List delivery logs for a webhook.",
  group: WH,
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const logs = await ctx.clockify.listWebhookLogs(args.id);
    return successReceipt({ action: "clockify_webhooks_logs", entity: "webhook", ids: { workspaceId: ctx.workspaceId, webhookId: args.id }, data: { count: logs.length, logs } });
  },
});

const createWebhook = defineRiskyAction({
  name: "clockify_webhooks_create",
  description:
    "Create a webhook (HTTPS url, a webhookEvent type). NOTE: Clockify blocks the whole webhooks API for add-ons (no scope grants it) — inside the embedded add-on this returns an honest restriction notice. External side effect — previews and requires confirmation. The signing secret is not set through the assistant.",
  group: WH,
  risks: ["external_side_effect"],
  schema: z.object({
    name: z.string().min(1),
    url: httpsUrl,
    webhookEvent: z.string().min(1),
    triggerSource: z.array(z.string().min(1)).optional(),
    triggerSourceType: z.string().optional(),
  }),
  async preview(ctx, args) {
    const blocked = addonWebhookRestriction(ctx);
    if (blocked) return blocked;
    const input = {
      name: args.name,
      url: args.url,
      webhookEvent: args.webhookEvent,
      ...(args.triggerSource !== undefined ? { triggerSource: args.triggerSource } : {}),
      ...(args.triggerSourceType !== undefined ? { triggerSourceType: args.triggerSourceType } : {}),
    };
    return {
      actionLabel: "Create webhook",
      targets: [],
      expectedChanges: [`Create webhook "${args.name}" for ${args.webhookEvent} → ${args.url}`],
      reversibility: "You can delete the webhook afterward.",
      warnings: ["This sends workspace events to an external URL."],
      payload: { input },
    };
  },
  async commit(ctx, payload) {
    const { input } = payload as { input: Parameters<typeof ctx.clockify.createWebhook>[0] };
    const webhook = await ctx.clockify.createWebhook(input);
    return successReceipt({ action: "clockify_webhooks_create", entity: "webhook", ids: { workspaceId: ctx.workspaceId }, changed: { created: [{ type: "webhook", id: webhook.id, name: webhook.name }] } });
  },
});

const updateWebhook = defineRiskyAction({
  name: "clockify_webhooks_update",
  description:
    "Update a webhook (name/url/event/trigger source). External side effect — previews and requires confirmation. The signing secret is not set through the assistant.",
  group: WH,
  risks: ["external_side_effect"],
  schema: z
    .object({
      id: z.string().min(1),
      name: z.string().optional(),
      url: httpsUrl.optional(),
      webhookEvent: z.string().optional(),
      triggerSource: z.array(z.string().min(1)).optional(),
      triggerSourceType: z.string().optional(),
    })
    .refine(
      (v) => v.name !== undefined || v.url !== undefined || v.webhookEvent !== undefined || v.triggerSource !== undefined || v.triggerSourceType !== undefined,
      { message: "Provide at least one field to change." },
    ),
  async preview(ctx, args) {
    const blocked = addonWebhookRestriction(ctx);
    if (blocked) return blocked;
    const { id, ...patch } = args;
    return {
      actionLabel: "Update webhook",
      targets: [{ type: "webhook", id, ...(args.name !== undefined ? { name: args.name } : {}) }],
      expectedChanges: Object.keys(patch).map((k) => `set ${k}`),
      reversibility: "You can update the webhook again.",
      warnings: ["This changes where/which workspace events are delivered."],
      payload: { id, patch },
    };
  },
  async commit(ctx, payload) {
    const { id, patch } = payload as { id: string; patch: Parameters<typeof ctx.clockify.updateWebhook>[1] };
    const updated = await ctx.clockify.updateWebhook(id, patch);
    return successReceipt({ action: "clockify_webhooks_update", entity: "webhook", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "webhook", id: updated.id, name: updated.name }] } });
  },
});

const deleteWebhook = defineRiskyAction({
  name: "clockify_webhooks_delete",
  description: "Delete a webhook. Destructive external side effect — previews and requires confirmation.",
  group: WH,
  risks: ["destructive", "external_side_effect"],
  schema: z.object({ id: z.string().min(1), name: z.string().optional() }),
  async preview(ctx, args) {
    const blocked = addonWebhookRestriction(ctx);
    if (blocked) return blocked;
    return {
      actionLabel: "Delete webhook",
      targets: [{ type: "webhook", id: args.id, name: args.name }],
      expectedChanges: [`Delete webhook ${args.name ?? args.id}`],
      reversibility: "This cannot be undone; recreate the webhook to restore it.",
      warnings: ["Deleting a webhook stops all future deliveries to its URL."],
      payload: { id: args.id, name: args.name },
    };
  },
  async commit(ctx, payload) {
    const { id, name } = payload as { id: string; name?: string };
    await ctx.clockify.deleteWebhook(id);
    return successReceipt({ action: "clockify_webhooks_delete", entity: "webhook", ids: { workspaceId: ctx.workspaceId }, changed: { deleted: [{ type: "webhook", id, name }] } });
  },
});

export const WEBHOOK_ACTIONS: ActionDefinition[] = [listWebhooks, getWebhook, listEvents, listLogs, createWebhook, updateWebhook, deleteWebhook];
