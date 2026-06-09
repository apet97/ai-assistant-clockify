import type { ProjectSummary } from "../types.js";

/** List filter for projects (goclmcp §2.2 — name/archived/clients). */
export interface ProjectFilter {
  name?: string;
  archived?: boolean;
  clientIds?: string[];
}

/** Create input — only `name` is required; the rest are passed through if set. */
export interface CreateProjectInput {
  name: string;
  clientId?: string;
  billable?: boolean;
  color?: string; // hex
  isPublic?: boolean;
}

/** Project billing-rate write (minor units on the wire; major→minor done upstream). */
export interface UpdateProjectRateInput {
  projectId: string;
  userId: string;
  rateKind: "HOURLY" | "COST";
  amountMinor: number;
  since?: string; // ISO datetime
}

/**
 * Project slice of the {@link WorkspaceClient} port (goclmcp §2.2). The worked
 * reference area: read+paginate, safe create, risky fetch-then-merge update,
 * archive-then-delete, billing rate, estimate, memberships. Risky/commit-only
 * methods stay typed (non-optional) here because the REST adapter and fake both
 * implement them; the harness still gates them by risk label.
 */
export interface ProjectPort {
  listProjects(filter?: ProjectFilter): Promise<ProjectSummary[]>;
  getProject(id: string): Promise<ProjectSummary | null>;
  createProject(input: CreateProjectInput): Promise<ProjectSummary>;
  /** Fetch-then-merge PUT (Clockify replaces and requires `name`). */
  updateProject(id: string, patch: Record<string, unknown>): Promise<ProjectSummary>;
  archiveProject(id: string): Promise<ProjectSummary>;
  /** Archive-then-delete (Clockify rejects deleting an active project). */
  deleteProject(id: string): Promise<void>;
  createProjectFromTemplate(input: { templateId: string; name?: string }): Promise<ProjectSummary>;
  updateProjectRate(input: UpdateProjectRateInput): Promise<void>;
  updateProjectEstimate(id: string, patch: Record<string, unknown>): Promise<void>;
  updateProjectMemberships(id: string, patch: Record<string, unknown>): Promise<void>;
}
