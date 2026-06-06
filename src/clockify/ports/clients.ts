import type { EntitySummary } from "../client.js";

/**
 * Client slice of the {@link WorkspaceClient} port (goclmcp §2.4).
 */
export interface ClientPort {
  listClients(): Promise<EntitySummary[]>;
  createClient(input: { name: string }): Promise<EntitySummary>;
}
