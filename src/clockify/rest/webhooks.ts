import { PAGE_SIZE, type RestCore } from "./core.js";
import type { EntitySummary } from "../types.js";
import type { CreateWebhookInput, PreparedWebhookUpdateInput, UpdateWebhookInput, WebhookPort, WebhookSummary } from "../ports/webhooks.js";
import { collectPages } from "./list-pages.js";
import { AmbiguousWriteOutcome } from "../write-outcome.js";

/**
 * Known Clockify webhook event types (mirrors goclmcp §2.12). The workspace
 * events endpoint 400s and the per-webhook one 404s, so this is surfaced as a
 * static reference list rather than an API call.
 */
const WEBHOOK_EVENTS: readonly string[] = [
  "NEW_TIME_ENTRY", "NEW_TIMER_STARTED", "TIMER_STOPPED", "TIME_ENTRY_UPDATED", "TIME_ENTRY_DELETED",
  "TIME_ENTRY_RESTORED", "TIME_ENTRY_SPLIT", "NEW_PROJECT", "PROJECT_UPDATED", "PROJECT_DELETED",
  "NEW_TASK", "TASK_UPDATED", "TASK_DELETED", "NEW_CLIENT", "CLIENT_UPDATED", "CLIENT_DELETED",
  "NEW_TAG", "TAG_UPDATED", "TAG_DELETED", "NEW_INVOICE", "INVOICE_UPDATED",
  "EXPENSE_CREATED", "EXPENSE_UPDATED", "EXPENSE_DELETED", "EXPENSE_RESTORED",
  "BILLABLE_RATE_UPDATED", "COST_RATE_UPDATED", "BALANCE_UPDATED",
  "ASSIGNMENT_CREATED", "ASSIGNMENT_UPDATED", "ASSIGNMENT_DELETED", "ASSIGNMENT_PUBLISHED",
  "NEW_APPROVAL_REQUEST", "APPROVAL_REQUEST_STATUS_UPDATED",
  "TIME_OFF_REQUESTED", "TIME_OFF_REQUEST_APPROVED", "TIME_OFF_REQUEST_REJECTED",
  "TIME_OFF_REQUEST_WITHDRAWN", "TIME_OFF_REQUEST_UPDATED", "TIME_OFF_REQUEST_STARTED",
  "USER_JOINED_WORKSPACE", "USER_UPDATED", "USER_EMAIL_CHANGED",
  "USER_ACTIVATED_ON_WORKSPACE", "USER_DEACTIVATED_ON_WORKSPACE", "USER_DELETED_FROM_WORKSPACE",
  "USERS_INVITED_TO_WORKSPACE", "USER_GROUP_CREATED", "USER_GROUP_UPDATED", "USER_GROUP_DELETED",
];

/** Raw webhook fields read by {@link mapWebhook} (the `authToken` secret is never read). */
type WebhookRow = {
  id: string;
  name?: string;
  url?: string;
  webhookEvent?: string;
  triggerSource?: string[];
  triggerSourceType?: string;
  enabled?: boolean;
};

/** Map a raw webhook to a view, STRIPPING the `authToken` secret. */
function mapWebhook(raw: WebhookRow): WebhookSummary {
  const out: WebhookSummary = { id: raw.id, name: raw.name ?? raw.id };
  if (raw.url !== undefined) out.url = raw.url;
  if (raw.webhookEvent !== undefined) out.webhookEvent = raw.webhookEvent;
  if (Array.isArray(raw.triggerSource)) out.triggerSource = [...raw.triggerSource];
  if (raw.triggerSourceType !== undefined) out.triggerSourceType = raw.triggerSourceType;
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  return out; // authToken intentionally omitted
}

/**
 * Typed webhook REST module (goclmcp §2.12). I/O only. The HMAC `authToken`
 * secret is NEVER sent from this typed path and is STRIPPED from every response
 * (`mapWebhook` never copies it), so it can't reach the model, a receipt, or the
 * audit log. List unwraps `{webhooks:[…]}`; update is GET-then-merge-PUT.
 */
export function makeWebhookRest(core: RestCore, workspaceId: string): WebhookPort {
  const ws = `/workspaces/${workspaceId}`;

  async function prepareWebhookUpdate(id: string, patch: UpdateWebhookInput): Promise<PreparedWebhookUpdateInput> {
    const existing = (await core.call("api", "GET", `${ws}/webhooks/${id}`)) as WebhookRow | null;
    if (!existing) throw new Error(`Webhook ${id} no longer exists.`);
    const name = patch.name ?? existing.name;
    const url = patch.url ?? existing.url;
    const webhookEvent = patch.webhookEvent ?? existing.webhookEvent;
    const triggerSourceType = patch.triggerSourceType ?? existing.triggerSourceType ?? "WORKSPACE_ID";
    const triggerSource = patch.triggerSource ?? existing.triggerSource ?? [workspaceId];
    if (!name || !url || !webhookEvent) throw new Error(`Webhook ${id} is missing fields required for a complete replacement.`);
    return { name, url, webhookEvent, triggerSourceType, triggerSource: [...triggerSource] };
  }

  async function createWebhookAtomic(input: CreateWebhookInput): Promise<EntitySummary> {
    const body = {
      name: input.name,
      url: input.url,
      webhookEvent: input.webhookEvent,
      triggerSourceType: input.triggerSourceType ?? "WORKSPACE_ID",
      triggerSource: input.triggerSource ?? [workspaceId],
    };
    const row = (await core.mutate("api", "POST", `${ws}/webhooks`, body)) as { id?: unknown; name?: unknown } | null;
    if (typeof row?.id !== "string" || row.id.length === 0) {
      throw new AmbiguousWriteOutcome("POST", `${ws}/webhooks`, "Clockify accepted the webhook create without a usable id.");
    }
    return { id: row.id, name: typeof row.name === "string" ? row.name : input.name };
  }

  async function updateWebhookAtomic(id: string, input: PreparedWebhookUpdateInput): Promise<EntitySummary> {
    const row = (await core.mutate("api", "PUT", `${ws}/webhooks/${id}`, input)) as { id?: unknown; name?: unknown } | null;
    if (row?.id !== undefined && typeof row.id !== "string") {
      throw new AmbiguousWriteOutcome("PUT", `${ws}/webhooks/${id}`, "Clockify returned a malformed webhook id.");
    }
    return {
      id: typeof row?.id === "string" && row.id.length > 0 ? row.id : id,
      name: typeof row?.name === "string" ? row.name : input.name,
    };
  }

  async function deleteWebhookAtomic(id: string): Promise<void> {
    await core.mutate("api", "DELETE", `${ws}/webhooks/${id}`);
  }

  return {
    async listWebhooks() {
      const data = (await core.call("api", "GET", `${ws}/webhooks`)) as
        | { workspaceWebhookCount?: number; webhooks?: WebhookRow[] }
        | WebhookRow[]
        | null;
      const rows = Array.isArray(data) ? data : (data?.webhooks ?? []);
      const total = Array.isArray(data) ? undefined : data?.workspaceWebhookCount;
      return { rows: rows.map(mapWebhook), truncated: typeof total === "number" && total > rows.length };
    },
    async getWebhook(id) {
      const raw = (await core.call("api", "GET", `${ws}/webhooks/${id}`, undefined, true)) as WebhookRow | null;
      return raw ? mapWebhook(raw) : null;
    },
    prepareWebhookUpdate,
    createWebhookAtomic,
    updateWebhookAtomic,
    deleteWebhookAtomic,
    createWebhook: createWebhookAtomic,
    async updateWebhook(id, patch) { return updateWebhookAtomic(id, await prepareWebhookUpdate(id, patch)); },
    deleteWebhook: deleteWebhookAtomic,
    async listWebhookEvents() {
      return { rows: [...WEBHOOK_EVENTS], truncated: false };
    },
    async listWebhookLogs(id) {
      // Logs are a POST search per the OpenAPI spec (WebhookLogSearchRequestV1);
      // the GET on this route 405s live. Ask for ALL statuses, newest first.
      return collectPages({
        label: `${ws}/webhooks/${id}/logs`,
        pageSize: PAGE_SIZE,
        async load(page, pageSize) {
          const qs = new URLSearchParams({ page: String(page), "page-size": String(pageSize) });
          const rows = (await core.postQuery("api", `${ws}/webhooks/${id}/logs?${qs.toString()}`, {
            status: "ALL",
            sortByNewest: true,
          })) as unknown[] | null;
          return { rows: Array.isArray(rows) ? rows : [] };
        },
      });
    },
  };
}
