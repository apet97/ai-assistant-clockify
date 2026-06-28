import type { EntitySummary } from "../types.js";

/** List filter for clients (name / archived). */
export interface ClientFilter {
  name?: string;
  archived?: boolean;
}

/**
 * Client slice of the {@link WorkspaceClient} port (goclmcp §2.4). `updateClient`
 * is fetch-then-merge (PUT replaces, requires `name`); `deleteClient` archives
 * then deletes (Clockify rejects deleting an active client, and rejects entirely
 * if the client still has active projects — the error is surfaced).
 */
export interface ClientPort {
  listClients(filter?: ClientFilter): Promise<EntitySummary[]>;
  getClient(id: string): Promise<EntitySummary | null>;
  /** `ccEmails`/`currencyId` are silently dropped by POST /clients, so the adapter applies them via a follow-up PUT. */
  createClient(input: { name: string; ccEmails?: string[]; currencyId?: string }): Promise<EntitySummary>;
  updateClient(id: string, patch: Record<string, unknown>): Promise<EntitySummary>;
  deleteClient(id: string): Promise<void>;
  /** Workspace currencies (`{id, code}`), for resolving a currency CODE → id. */
  listCurrencies(): Promise<Array<{ id: string; code: string }>>;
}
