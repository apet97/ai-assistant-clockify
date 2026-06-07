import type { EntitySummary } from "../client.js";

/**
 * Workspace & project-template slice of the {@link WorkspaceClient} port (goclmcp
 * §2.16–2.17). All reads. `getWorkspace` returns the current workspace's
 * settings/info; templates are projects flagged `is-template=true`.
 */
export interface WorkspacePort {
  getWorkspace(): Promise<unknown>;
  listTemplates(): Promise<EntitySummary[]>;
  getTemplate(id: string): Promise<EntitySummary | null>;
}
