import type { EntitySummary, ListResult } from "../types.js";

/** List filter for tags (name / archived). */
export interface TagFilter {
  name?: string;
  archived?: boolean;
}

/**
 * Tag slice of the {@link WorkspaceClient} port (goclmcp §2.5). `updateTag` is
 * fetch-then-merge (PUT replaces, requires `name`); tags delete with a plain
 * DELETE (no archive step needed).
 */
export interface TagPort {
  listTags(filter?: TagFilter): Promise<ListResult<EntitySummary>>;
  getTag(id: string): Promise<EntitySummary | null>;
  createTag(input: { name: string }): Promise<EntitySummary>;
  updateTag(id: string, patch: Record<string, unknown>): Promise<EntitySummary>;
  deleteTag(id: string): Promise<void>;
}
