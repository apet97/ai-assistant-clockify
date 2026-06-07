import type { EntitySummary } from "../client.js";

/**
 * Tag slice of the {@link WorkspaceClient} port (goclmcp §2.5).
 */
export interface TagPort {
  listTags(): Promise<EntitySummary[]>;
  createTag(input: { name: string }): Promise<EntitySummary>;
}
