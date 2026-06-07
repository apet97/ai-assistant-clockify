import { z } from "zod";
import { defineAction, type ActionDefinition } from "../action.js";
import { successReceipt } from "../receipts.js";

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

const listWebhooks = defineAction({
  name: "clockify_webhooks_list",
  description: "List webhooks in the workspace.",
  featureGroup: WH,
  risks: ["read"],
  schema: z.object({}),
  async handler(ctx) {
    const items = await ctx.clockify.listWebhooks();
    return { kind: "receipt", receipt: successReceipt({ action: "clockify_webhooks_list", entity: "webhook", ids: { workspaceId: ctx.workspaceId }, data: { count: items.length, items } }) };
  },
});

const getWebhook = defineAction({
  name: "clockify_webhooks_get",
  description: "Fetch a single webhook by id (the signing secret is never returned).",
  featureGroup: WH,
  risks: ["read"],
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const entity = await ctx.clockify.getWebhook(args.id);
    return { kind: "receipt", receipt: successReceipt({ action: "clockify_webhooks_get", entity: "webhook", ids: { workspaceId: ctx.workspaceId }, data: { entity } }) };
  },
});

const listEvents = defineAction({
  name: "clockify_webhooks_events",
  description: "List the available webhook event types.",
  featureGroup: WH,
  risks: ["read"],
  schema: z.object({}),
  async handler(ctx) {
    const events = await ctx.clockify.listWebhookEvents();
    return { kind: "receipt", receipt: successReceipt({ action: "clockify_webhooks_events", entity: "webhook", ids: { workspaceId: ctx.workspaceId }, data: { count: events.length, events } }) };
  },
});

const listLogs = defineAction({
  name: "clockify_webhooks_logs",
  description: "List delivery logs for a webhook.",
  featureGroup: WH,
  risks: ["read"],
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const logs = await ctx.clockify.listWebhookLogs(args.id);
    return { kind: "receipt", receipt: successReceipt({ action: "clockify_webhooks_logs", entity: "webhook", ids: { workspaceId: ctx.workspaceId, webhookId: args.id }, data: { count: logs.length, logs } }) };
  },
});

const createWebhook = defineAction({
  name: "clockify_webhooks_create",
  description:
    "Create a webhook (HTTPS url, a webhookEvent type). External side effect — previews and requires confirmation. The signing secret is not set through the assistant.",
  featureGroup: WH,
  risks: ["external_side_effect"],
  schema: z.object({
    name: z.string().min(1),
    url: httpsUrl,
    webhookEvent: z.string().min(1),
    triggerSource: z.array(z.string().min(1)).optional(),
    triggerSourceType: z.string().optional(),
  }),
  async handler(ctx, args) {
    const input = {
      name: args.name,
      url: args.url,
      webhookEvent: args.webhookEvent,
      ...(args.triggerSource !== undefined ? { triggerSource: args.triggerSource } : {}),
      ...(args.triggerSourceType !== undefined ? { triggerSourceType: args.triggerSourceType } : {}),
    };
    return {
      kind: "preview",
      preview: {
        actionLabel: "Create webhook",
        featureGroup: WH,
        riskLabels: ["external_side_effect"],
        targets: [],
        expectedChanges: [`Create webhook "${args.name}" for ${args.webhookEvent} → ${args.url}`],
        reversibility: "You can delete the webhook afterward.",
        warnings: ["This sends workspace events to an external URL."],
      },
      operation: { actionName: "clockify_webhooks_create", featureGroup: WH, risks: ["external_side_effect"], payload: { input } },
    };
  },
  async commit(ctx, operation) {
    const { input } = operation.payload as { input: Parameters<typeof ctx.clockify.createWebhook>[0] };
    const webhook = await ctx.clockify.createWebhook(input);
    return successReceipt({ action: "clockify_webhooks_create", entity: "webhook", ids: { workspaceId: ctx.workspaceId }, changed: { created: [{ type: "webhook", id: webhook.id, name: webhook.name }] } });
  },
});

const updateWebhook = defineAction({
  name: "clockify_webhooks_update",
  description:
    "Update a webhook (name/url/event/trigger source). External side effect — previews and requires confirmation. The signing secret is not set through the assistant.",
  featureGroup: WH,
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
  async handler(ctx, args) {
    const { id, ...patch } = args;
    return {
      kind: "preview",
      preview: {
        actionLabel: "Update webhook",
        featureGroup: WH,
        riskLabels: ["external_side_effect"],
        targets: [{ type: "webhook", id, ...(args.name !== undefined ? { name: args.name } : {}) }],
        expectedChanges: Object.keys(patch).map((k) => `set ${k}`),
        reversibility: "You can update the webhook again.",
        warnings: ["This changes where/which workspace events are delivered."],
      },
      operation: { actionName: "clockify_webhooks_update", featureGroup: WH, risks: ["external_side_effect"], payload: { id, patch } },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { id: string; patch: Parameters<typeof ctx.clockify.updateWebhook>[1] };
    const updated = await ctx.clockify.updateWebhook(payload.id, payload.patch);
    return successReceipt({ action: "clockify_webhooks_update", entity: "webhook", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "webhook", id: updated.id, name: updated.name }] } });
  },
});

const deleteWebhook = defineAction({
  name: "clockify_webhooks_delete",
  description: "Delete a webhook. Destructive external side effect — previews and requires confirmation.",
  featureGroup: WH,
  risks: ["destructive", "external_side_effect"],
  schema: z.object({ id: z.string().min(1), name: z.string().optional() }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: "Delete webhook",
        featureGroup: WH,
        riskLabels: ["destructive", "external_side_effect"],
        targets: [{ type: "webhook", id: args.id, name: args.name }],
        expectedChanges: [`Delete webhook ${args.name ?? args.id}`],
        reversibility: "This cannot be undone; recreate the webhook to restore it.",
        warnings: ["Deleting a webhook stops all future deliveries to its URL."],
      },
      operation: { actionName: "clockify_webhooks_delete", featureGroup: WH, risks: ["destructive", "external_side_effect"], payload: { id: args.id, name: args.name } },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { id: string; name?: string };
    await ctx.clockify.deleteWebhook(payload.id);
    return successReceipt({ action: "clockify_webhooks_delete", entity: "webhook", ids: { workspaceId: ctx.workspaceId }, changed: { deleted: [{ type: "webhook", id: payload.id, name: payload.name }] } });
  },
});

export const WEBHOOK_ACTIONS: ActionDefinition[] = [listWebhooks, getWebhook, listEvents, listLogs, createWebhook, updateWebhook, deleteWebhook];
