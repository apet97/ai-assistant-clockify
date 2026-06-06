import type { EntitySummary } from "../client.js";

/**
 * Webhook slice of the {@link WorkspaceClient} port (goclmcp §2.12). Phase 12
 * extends this with typed get/create/update/delete and events/logs methods.
 */
export interface WebhookPort {
  listWebhooks(): Promise<EntitySummary[]>;
}
