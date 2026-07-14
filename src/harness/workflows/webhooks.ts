import { z } from "zod";
import {
  defineReadAction,
  defineRiskyAction,
  type ActionContext,
  type ActionDefinition,
} from "../action.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import { commitSingleDurableRiskyStep } from "../durable-risky-write.js";
import { listReceipt, successReceipt } from "../receipts.js";
import { captureTargetSnapshot } from "../target-snapshots.js";
import { sanitizedFingerprint } from "../safe-json.js";
import { describePatch } from "./resolve.js";
import { dispatchWithReconciliation, reconcileCreate } from "./structure-durable.js";
import { DefinitiveWriteFailure } from "../../clockify/write-outcome.js";
import type { PreparedWebhookUpdateInput, WebhookSummary } from "../../clockify/ports/webhooks.js";

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
const webhookCreateContract = durableMutationContract({ source: "confirmed", targeting: { mode: "create_no_target" }, strategies: ["create"] });
const webhookTargetContract = (strategy: "update" | "delete") => durableMutationContract({
  source: "confirmed", targeting: { mode: "snapshots", relations: ["target"] }, strategies: [strategy],
});

function webhookProjection(webhook: Awaited<ReturnType<ActionContext["clockify"]["getWebhook"]>>) {
  if (!webhook) return undefined;
  return {
    id: webhook.id, name: webhook.name, url: webhook.url, webhookEvent: webhook.webhookEvent,
    triggerSource: webhook.triggerSource, triggerSourceType: webhook.triggerSourceType, enabled: webhook.enabled,
  };
}

function webhookCreateProjection(webhook: Pick<WebhookSummary, "url" | "webhookEvent" | "triggerSource" | "triggerSourceType">) {
  return {
    url: webhook.url,
    webhookEvent: webhook.webhookEvent,
    triggerSource: [...(webhook.triggerSource ?? [])].sort(),
    triggerSourceType: webhook.triggerSourceType,
  };
}

function webhookMatchesBody(webhook: WebhookSummary, body: PreparedWebhookUpdateInput): boolean {
  return sanitizedFingerprint({
    name: webhook.name,
    url: webhook.url,
    webhookEvent: webhook.webhookEvent,
    triggerSource: [...(webhook.triggerSource ?? [])].sort(),
    triggerSourceType: webhook.triggerSourceType,
  }) === sanitizedFingerprint({ ...body, triggerSource: [...body.triggerSource].sort() });
}

async function requireFreshWebhookBaseline(ctx: ActionContext, baselineIds: readonly string[]) {
  const current = await ctx.clockify.listWebhooks();
  const ids = current.rows.map((row) => row.id).sort();
  if (current.truncated || sanitizedFingerprint(ids) !== sanitizedFingerprint([...baselineIds].sort())) {
    throw new DefinitiveWriteFailure("VERIFY", "webhook_baseline", "The webhook list changed after preview. Create a fresh preview.");
  }
}

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
    const { rows, truncated } = await ctx.clockify.listWebhooks();
    return listReceipt({ action: "clockify_webhooks_list", entity: "webhook", ids: { workspaceId: ctx.workspaceId }, rows, truncated });
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
    const { rows, truncated } = await ctx.clockify.listWebhookEvents();
    return listReceipt({ action: "clockify_webhooks_events", entity: "webhook", ids: { workspaceId: ctx.workspaceId }, rows, truncated, dataKey: "events" });
  },
});

const listLogs = defineReadAction({
  name: "clockify_webhooks_logs",
  description: "List delivery logs for a webhook.",
  group: WH,
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const { rows, truncated } = await ctx.clockify.listWebhookLogs(args.id);
    return listReceipt({ action: "clockify_webhooks_logs", entity: "webhook", ids: { workspaceId: ctx.workspaceId, webhookId: args.id }, rows, truncated, dataKey: "logs" });
  },
});

const createWebhook = defineRiskyAction({
  name: "clockify_webhooks_create",
  description:
    "Create a webhook (HTTPS url, a webhookEvent type). NOTE: Clockify blocks the whole webhooks API for add-ons (no scope grants it) — inside the embedded add-on this returns an honest restriction notice. External side effect — previews and requires confirmation. The signing secret is not set through the assistant.",
  group: WH,
  risks: ["external_side_effect"],
  mutationWorkflow: "durable",
  mutationContract: webhookCreateContract,
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
    const baseline = await ctx.clockify.listWebhooks();
    if (baseline.truncated) return { clarify: "Clockify returned an incomplete webhook list, so I can't safely create or reconcile this webhook." };
    return {
      actionLabel: "Create webhook",
      targets: [],
      expectedChanges: [`Create webhook "${args.name}" for ${args.webhookEvent} → ${args.url}`],
      reversibility: "You can delete the webhook afterward.",
      warnings: ["This sends workspace events to an external URL."],
      payload: {
        input,
        baselineIds: baseline.rows.map((row) => row.id).sort(),
        finalFingerprint: sanitizedFingerprint(webhookCreateProjection({
          url: input.url, webhookEvent: input.webhookEvent,
          triggerSource: input.triggerSource ?? [ctx.workspaceId],
          triggerSourceType: input.triggerSourceType ?? "WORKSPACE_ID",
        })),
      },
      mutationPlan: { mode: "single", steps: [{ id: "create-webhook", kind: "primary", reconciliationStrategy: "create" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { input, baselineIds, finalFingerprint } = payload as {
      input: Parameters<typeof ctx.clockify.createWebhookAtomic>[0]; baselineIds: string[]; finalFingerprint: string;
    };
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "create-webhook", name: "Create webhook",
      async dispatch() {
        await requireFreshWebhookBaseline(ctx, baselineIds);
        const dispatched = await dispatchWithReconciliation({
          dispatch: () => ctx.clockify.createWebhookAtomic(input),
          reconcile: async () => {
            const row = await reconcileCreate({
              beforeIds: baselineIds,
              list: () => ctx.clockify.listWebhooks(),
              matches: (candidate) => sanitizedFingerprint(webhookCreateProjection(candidate)) === finalFingerprint,
            });
            return row ? { id: row.id, name: row.name } : undefined;
          },
        });
        const webhook = dispatched.value;
        return { externalId: webhook.id, effect: { created: { type: "webhook", id: webhook.id, name: webhook.name } }, detail: { reconciled: dispatched.reconciled } };
      },
      success: (step) => successReceipt({ action: "clockify_webhooks_create", entity: "webhook", ids: { workspaceId: ctx.workspaceId }, changed: { created: [{ type: "webhook", id: step.externalId ?? "webhook", name: input.name }] } }),
    });
  },
});

const updateWebhook = defineRiskyAction({
  name: "clockify_webhooks_update",
  description:
    "Update a webhook (name/url/event/trigger source). External side effect — previews and requires confirmation. The signing secret is not set through the assistant.",
  group: WH,
  risks: ["external_side_effect"],
  mutationWorkflow: "durable",
  mutationContract: webhookTargetContract("update"),
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
    const current = await ctx.clockify.getWebhook(id);
    if (!current) return { clarify: `I couldn't verify webhook ${id}. Give me a current webhook id.` };
    let body: Awaited<ReturnType<typeof ctx.clockify.prepareWebhookUpdate>>;
    try { body = await ctx.clockify.prepareWebhookUpdate(id, patch); }
    catch { return { clarify: `I couldn't prepare a complete replacement for webhook ${id}. Refresh it and try again.` }; }
    const targetSnapshot = captureTargetSnapshot("target", { type: "webhook", id, name: current.name }, webhookProjection(current));
    return {
      actionLabel: "Update webhook",
      targets: [{ type: "webhook", id, ...(args.name !== undefined ? { name: args.name } : {}) }],
      expectedChanges: describePatch(patch),
      reversibility: "You can update the webhook again.",
      warnings: ["This changes where/which workspace events are delivered."],
      payload: { id, patch, body },
      targetSnapshots: [targetSnapshot],
      mutationPlan: { mode: "single", steps: [{ id: "update-webhook", kind: "primary", targetFingerprint: targetSnapshot.fingerprint, reconciliationStrategy: "update" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { id, body } = payload as { id: string; body: Parameters<typeof ctx.clockify.updateWebhookAtomic>[1] };
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "update-webhook", name: "Update webhook",
      verification: { snapshots: operation.targetSnapshots ?? [], async fetchSnapshot() {
        const current = await ctx.clockify.getWebhook(id);
        return current ? { ref: { type: "webhook", id, name: current.name }, projection: webhookProjection(current) } : undefined;
      } },
      async dispatch() {
        const dispatched = await dispatchWithReconciliation({
          dispatch: () => ctx.clockify.updateWebhookAtomic(id, body),
          reconcile: async () => {
            const current = await ctx.clockify.getWebhook(id);
            return current && webhookMatchesBody(current, body) ? { id: current.id, name: current.name } : undefined;
          },
        });
        const updated = dispatched.value;
        return { externalId: updated.id, effect: { updated: { type: "webhook", id: updated.id, name: updated.name } }, detail: { reconciled: dispatched.reconciled } };
      },
      success: (step) => successReceipt({ action: "clockify_webhooks_update", entity: "webhook", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "webhook", id: step.externalId ?? id, name: body.name }] } }),
    });
  },
});

const deleteWebhook = defineRiskyAction({
  name: "clockify_webhooks_delete",
  description: "Delete a webhook. Destructive external side effect — previews and requires confirmation.",
  group: WH,
  risks: ["destructive", "external_side_effect"],
  mutationWorkflow: "durable",
  mutationContract: webhookTargetContract("delete"),
  schema: z.object({ id: z.string().min(1), name: z.string().optional() }),
  async preview(ctx, args) {
    const blocked = addonWebhookRestriction(ctx);
    if (blocked) return blocked;
    const current = await ctx.clockify.getWebhook(args.id);
    if (!current) return { clarify: `I couldn't verify webhook ${args.id}. Give me a current webhook id.` };
    const targetSnapshot = captureTargetSnapshot("target", { type: "webhook", id: current.id, name: current.name }, webhookProjection(current));
    return {
      actionLabel: "Delete webhook",
      targets: [{ type: "webhook", id: args.id, name: args.name }],
      expectedChanges: [`Delete webhook ${args.name ?? args.id}`],
      reversibility: "This cannot be undone; recreate the webhook to restore it.",
      warnings: ["Deleting a webhook stops all future deliveries to its URL."],
      payload: { id: current.id, name: current.name ?? args.name },
      targetSnapshots: [targetSnapshot],
      mutationPlan: { mode: "single", steps: [{ id: "delete-webhook", kind: "primary", targetFingerprint: targetSnapshot.fingerprint, reconciliationStrategy: "delete" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { id, name } = payload as { id: string; name?: string };
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "delete-webhook", name: "Delete webhook",
      verification: { snapshots: operation.targetSnapshots ?? [], async fetchSnapshot() {
        const current = await ctx.clockify.getWebhook(id);
        return current ? { ref: { type: "webhook", id, name: current.name }, projection: webhookProjection(current) } : undefined;
      } },
      async dispatch() {
        const dispatched = await dispatchWithReconciliation({
          dispatch: async () => { await ctx.clockify.deleteWebhookAtomic(id); return true; },
          reconcile: async () => {
            const current = await ctx.clockify.listWebhooks();
            return !current.truncated && !current.rows.some((row) => row.id === id) ? true : undefined;
          },
        });
        return { externalId: id, effect: { deleted: { type: "webhook", id, name } }, detail: { reconciled: dispatched.reconciled } };
      },
      success: () => successReceipt({ action: "clockify_webhooks_delete", entity: "webhook", ids: { workspaceId: ctx.workspaceId }, changed: { deleted: [{ type: "webhook", id, name }] } }),
    });
  },
});

export const WEBHOOK_ACTIONS: ActionDefinition[] = [listWebhooks, getWebhook, listEvents, listLogs, createWebhook, updateWebhook, deleteWebhook];

/** Read-only startup dispatcher metadata; it grants no mutation capability. */
export const WEBHOOK_STARTUP_RECONCILIATION = Object.freeze({
  clockify_webhooks_create: { "create-webhook": "create" },
  clockify_webhooks_update: { "update-webhook": "update" },
  clockify_webhooks_delete: { "delete-webhook": "delete" },
} as const);
