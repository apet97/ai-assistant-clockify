import type { RestCore } from "./core.js";
import type { ProjectPort } from "../ports/projects.js";
import type { ProjectSummary } from "../types.js";

/**
 * Typed project REST module (goclmcp §2.2). I/O only — risk/policy/confirmation
 * stay in the harness. Methods mirror the Go reference's operations and shapes:
 * estimate and memberships use PATCH (not PUT); rate writes the raw integer
 * `amount` to the `.../{userId}/{hourly-rate|cost-rate}` endpoint; delete
 * archives first because Clockify rejects deleting an active project.
 */
export function makeProjectRest(core: RestCore, workspaceId: string): ProjectPort {
  const ws = `/workspaces/${workspaceId}`;
  const map = (p: any): ProjectSummary => ({
    id: p.id,
    name: p.name,
    clientId: p.clientId,
    archived: p.archived,
    billable: p.billable,
  });

  return {
    async listProjects(filter) {
      const params: Record<string, string> = { archived: String(filter?.archived ?? false) };
      if (filter?.name) params.name = filter.name;
      if (filter?.clientIds?.length) params.clients = filter.clientIds.join(",");
      const rows = await core.paginate("api", `${ws}/projects`, params);
      return rows.map(map);
    },
    async getProject(id) {
      const p = await core.call("api", "GET", `${ws}/projects/${id}`, undefined, true);
      return p ? map(p) : null;
    },
    async createProject(input) {
      const p = await core.call("api", "POST", `${ws}/projects`, {
        name: input.name,
        ...(input.clientId ? { clientId: input.clientId } : {}),
        ...(input.billable !== undefined ? { billable: input.billable } : {}),
        ...(input.color ? { color: input.color } : {}),
        ...(input.isPublic !== undefined ? { isPublic: input.isPublic } : {}),
      });
      return map(p);
    },
    async updateProject(id, patch) {
      const p = await core.getThenPut("api", `${ws}/projects/${id}`, patch);
      return map(p);
    },
    async archiveProject(id) {
      const p = await core.getThenPut("api", `${ws}/projects/${id}`, { archived: true });
      return map(p);
    },
    async deleteProject(id) {
      await core.getThenPut("api", `${ws}/projects/${id}`, { archived: true }); // archive first
      await core.call("api", "DELETE", `${ws}/projects/${id}`);
    },
    async createProjectFromTemplate(input) {
      const p = await core.call("api", "POST", `${ws}/projects/from-template`, {
        templateId: input.templateId,
        ...(input.name ? { name: input.name } : {}),
      });
      return map(p);
    },
    async updateProjectRate(input) {
      const kind = input.rateKind === "COST" ? "cost-rate" : "hourly-rate";
      await core.call("api", "PUT", `${ws}/projects/${input.projectId}/users/${input.userId}/${kind}`, {
        amount: input.amountMinor,
        ...(input.since ? { since: input.since } : {}),
      });
    },
    async updateProjectEstimate(id, patch) {
      // PATCH, per the goclmcp reference (the plan's "PUT" predates that check).
      await core.call("api", "PATCH", `${ws}/projects/${id}/estimate`, patch);
    },
    async updateProjectMemberships(id, patch) {
      // PATCH, per the goclmcp reference. Replaces the membership set.
      await core.call("api", "PATCH", `${ws}/projects/${id}/memberships`, patch);
    },
    async getProjectMemberships(projectId) {
      const p = (await core.call("api", "GET", `${ws}/projects/${projectId}`, undefined, true)) as
        | { memberships?: Array<Record<string, unknown>> }
        | null;
      return p?.memberships ?? [];
    },
  };
}
