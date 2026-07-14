import { PAGE_SIZE, type RestCore } from "./core.js";
import type { EntitySummary } from "../types.js";
import type { WebhookPort, WebhookSummary } from "../ports/webhooks.js";
import { collectPages } from "./list-pages.js";

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

/** Editable webhook fields carried through a GET-then-merge update (never authToken). */
const WEBHOOK_FIELDS = ["name", "url", "webhookEvent", "triggerSourceType", "triggerSource"] as const;

/** Raw webhook fields read by {@link mapWebhook} (the `authToken` secret is never read). */
type WebhookRow = {
  id: string;
  name?: string;
  url?: string;
  webhookEvent?: string;
  triggerSourceType?: string;
  enabled?: boolean;
};

/** Map a raw webhook to a view, STRIPPING the `authToken` secret. */
function mapWebhook(raw: WebhookRow): WebhookSummary {
  const out: WebhookSummary = { id: raw.id, name: raw.name ?? raw.id };
  if (raw.url !== undefined) out.url = raw.url;
  if (raw.webhookEvent !== undefined) out.webhookEvent = raw.webhookEvent;
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
    async createWebhook(input): Promise<EntitySummary> {
      const body: Record<string, unknown> = {
        name: input.name,
        url: input.url,
        webhookEvent: input.webhookEvent,
        triggerSourceType: input.triggerSourceType ?? "WORKSPACE_ID",
        triggerSource: input.triggerSource ?? [workspaceId],
      };
      const w = (await core.call("api", "POST", `${ws}/webhooks`, body)) as { id: string; name?: string };
      return { id: w.id, name: w.name ?? input.name };
    },
    async updateWebhook(id, patch): Promise<EntitySummary> {
      // GET-then-merge-PUT (Clockify replaces on PUT). Carry only the editable
      // fields from the existing webhook — never the authToken it returns.
      const existing = ((await core.call("api", "GET", `${ws}/webhooks/${id}`)) ?? {}) as Record<string, unknown>;
      const body: Record<string, unknown> = {};
      for (const key of WEBHOOK_FIELDS) {
        if (existing[key] !== undefined) body[key] = existing[key];
      }
      if (patch.name !== undefined) body.name = patch.name;
      if (patch.url !== undefined) body.url = patch.url;
      if (patch.webhookEvent !== undefined) body.webhookEvent = patch.webhookEvent;
      if (patch.triggerSourceType !== undefined) body.triggerSourceType = patch.triggerSourceType;
      if (patch.triggerSource !== undefined) body.triggerSource = patch.triggerSource;
      const w = (await core.call("api", "PUT", `${ws}/webhooks/${id}`, body)) as { id?: string; name?: string };
      return { id: w?.id ?? id, name: w?.name ?? patch.name ?? id };
    },
    async deleteWebhook(id) {
      await core.call("api", "DELETE", `${ws}/webhooks/${id}`);
    },
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
          const rows = (await core.call("api", "POST", `${ws}/webhooks/${id}/logs?${qs.toString()}`, {
            status: "ALL",
            sortByNewest: true,
          })) as unknown[] | null;
          return { rows: Array.isArray(rows) ? rows : [] };
        },
      });
    },
  };
}
