import type { ProjectSummary } from "../client.js";

/**
 * Project slice of the {@link WorkspaceClient} port (goclmcp §2.2). Phase 2
 * extends this with typed get/update/archive/delete/rate/estimate/membership
 * methods; for now it holds the two existing methods verbatim.
 */
export interface ProjectPort {
  listProjects(): Promise<ProjectSummary[]>;
  createProject(input: { name: string; clientId?: string }): Promise<ProjectSummary>;
}
