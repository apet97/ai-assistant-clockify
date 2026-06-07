import type { EntitySummary } from "../client.js";

/**
 * Webhook view. NEVER carries `authToken` (the HMAC signing secret) — the REST
 * layer strips it from every response so it can never reach the model, a
 * receipt, or the audit log.
 */
export interface WebhookSummary extends EntitySummary {
  url?: string;
  webhookEvent?: string;
  triggerSourceType?: string;
  enabled?: boolean;
}

export interface CreateWebhookInput {
  name: string;
  /** Must be HTTPS, no loopback (validated in the action layer). */
  url: string;
  webhookEvent: string;
  triggerSource?: string[];
  triggerSourceType?: string;
}

export interface UpdateWebhookInput {
  name?: string;
  url?: string;
  webhookEvent?: string;
  triggerSource?: string[];
  triggerSourceType?: string;
}

/**
 * Webhook slice of the {@link WorkspaceClient} port (goclmcp §2.12). Reads are
 * immediate; create/update/delete run from the handler. The `authToken` secret is
 * NEVER accepted from the model nor returned. `listWebhooks` keeps returning
 * `EntitySummary[]`-compatible rows (the generic `list_entities` uses it).
 */
export interface WebhookPort {
  listWebhooks(): Promise<WebhookSummary[]>;
  getWebhook(id: string): Promise<WebhookSummary | null>;
  createWebhook(input: CreateWebhookInput): Promise<EntitySummary>;
  updateWebhook(id: string, patch: UpdateWebhookInput): Promise<EntitySummary>;
  deleteWebhook(id: string): Promise<void>;
  listWebhookEvents(): Promise<string[]>;
  listWebhookLogs(id: string): Promise<unknown[]>;
}
