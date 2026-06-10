import type { ProjectSummary, WorkspaceClient } from "../../../src/clockify/client.js";
import type { FakeContext } from "./state.js";

export function makeFakeProjects({ state, bump, nextId }: FakeContext): Pick<
  WorkspaceClient,
  | "listProjects"
  | "getProject"
  | "createProject"
  | "updateProject"
  | "archiveProject"
  | "deleteProject"
  | "createProjectFromTemplate"
  | "updateProjectRate"
  | "updateProjectEstimate"
  | "updateProjectMemberships"
  | "getProjectMemberships"
> {
  return {
    async listProjects(filter) {
      bump("listProjects");
      let rows = state.projects;
      if (filter?.name) {
        const needle = filter.name.toLowerCase();
        rows = rows.filter((p) => p.name.toLowerCase().includes(needle));
      }
      // The real adapter always wires archived=false unless asked (rest/projects.ts).
      const archived = filter?.archived ?? false;
      rows = rows.filter((p) => Boolean(p.archived) === archived);
      if (filter?.clientIds?.length) {
        rows = rows.filter((p) => p.clientId !== undefined && filter.clientIds?.includes(p.clientId));
      }
      return rows;
    },
    async getProject(id) {
      bump("getProject");
      return state.projects.find((p) => p.id === id) ?? null;
    },
    async createProject({ name, clientId }) {
      bump("createProject");
      const p: ProjectSummary = { id: nextId("project"), name, clientId };
      state.projects.push(p);
      return p;
    },
    async updateProject(id, patch) {
      bump("updateProject");
      const index = state.projects.findIndex((p) => p.id === id);
      const base: ProjectSummary = index >= 0 ? state.projects[index] : { id, name: id };
      const updated: ProjectSummary = {
        ...base,
        ...(typeof patch.name === "string" ? { name: patch.name } : {}),
        ...(typeof patch.clientId === "string" ? { clientId: patch.clientId } : {}),
        ...(typeof patch.archived === "boolean" ? { archived: patch.archived } : {}),
      };
      if (index >= 0) state.projects[index] = updated;
      else state.projects.push(updated);
      return updated;
    },
    async archiveProject(id) {
      bump("archiveProject");
      const index = state.projects.findIndex((p) => p.id === id);
      const base: ProjectSummary = index >= 0 ? state.projects[index] : { id, name: id };
      const archived: ProjectSummary = { ...base, archived: true };
      if (index >= 0) state.projects[index] = archived;
      else state.projects.push(archived);
      return archived;
    },
    async deleteProject(id) {
      bump("deleteProject");
      state.projects = state.projects.filter((p) => p.id !== id);
      state.deleted.push({ entityType: "project", id });
    },
    async createProjectFromTemplate({ templateId, name }) {
      bump("createProjectFromTemplate");
      const p: ProjectSummary = { id: nextId("project"), name: name ?? `from-${templateId}` };
      state.projects.push(p);
      return p;
    },
    async updateProjectRate(input) {
      bump("updateProjectRate");
      void input;
    },
    async updateProjectEstimate(id, patch) {
      bump("updateProjectEstimate");
      void id;
      void patch;
    },
    async updateProjectMemberships(id, patch) {
      bump("updateProjectMemberships");
      const rows = (patch as { memberships?: Array<Record<string, unknown>> }).memberships;
      if (rows) state.projectMemberships[id] = [...rows];
    },
    async getProjectMemberships(projectId) {
      bump("getProjectMemberships");
      return [...(state.projectMemberships[projectId] ?? [])];
    },
  };
}
