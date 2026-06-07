import type { EntitySummary } from "../client.js";

/**
 * User slice of the {@link WorkspaceClient} port (goclmcp §2.13). Phase 13
 * extends this with managers/deactivate/role/invite and group methods.
 */
export interface UserPort {
  listUsers(): Promise<EntitySummary[]>;
}
