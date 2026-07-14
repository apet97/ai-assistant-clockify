import type { EntitySummary, ListResult } from "../types.js";

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
  listClients(filter?: ClientFilter): Promise<ListResult<EntitySummary>>;
  getClient(id: string): Promise<EntitySummary | null>;
  /** Complete raw client document for durable fingerprint/reconciliation reads. */
  getClientMutationState(id: string): Promise<Record<string, unknown> | null>;
  /** `ccEmails`/`currencyId` are silently dropped by POST /clients, so the adapter applies them via a follow-up PUT. */
  createClient(input: { name: string; ccEmails?: string[]; currencyId?: string }): Promise<EntitySummary>;
  createClientBaseAtomic(input: { name: string }): Promise<EntitySummary>;
  updateClient(id: string, patch: Record<string, unknown>): Promise<EntitySummary>;
  prepareClientUpdate(id: string, patch: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateClientAtomic(id: string, body: Record<string, unknown>): Promise<EntitySummary>;
  deleteClient(id: string): Promise<void>;
  deleteClientAtomic(id: string): Promise<void>;
  /** Workspace currencies (`{id, code}`), for resolving a currency CODE → id. */
  listCurrencies(): Promise<ListResult<{ id: string; code: string }>>;
}
