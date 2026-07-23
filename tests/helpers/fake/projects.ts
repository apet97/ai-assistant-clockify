import type { ProjectSummary, WorkspaceClient } from "../../../src/clockify/client.js";
import { decodeProjectMembershipRows } from "../../../src/clockify/rest/projects.js";
import { fakeListResult, type FakeContext } from "./state.js";

export function makeFakeProjects({ state, seed, bump, nextId }: FakeContext): Pick<
  WorkspaceClient,
  | "listProjects"
  | "getProject"
  | "getProjectMutationState"
  | "createProject"
  | "updateProject"
  | "archiveProject"
  | "deleteProject"
  | "createProjectFromTemplate"
  | "updateProjectRate"
  | "updateProjectEstimate"
  | "updateProjectMemberships"
  | "getProjectMemberships"
  | "createProjectAtomic"
  | "prepareProjectUpdate"
  | "updateProjectAtomic"
  | "archiveProjectAtomic"
  | "deleteProjectAtomic"
  | "createProjectFromTemplateAtomic"
  | "updateProjectRateAtomic"
  | "updateProjectMemberHourlyRateAtomic"
  | "updateProjectMemberCostRateAtomic"
  | "updateProjectEstimateAtomic"
  | "updateProjectMembershipsAtomic"
> {
  const createAtomic: WorkspaceClient["createProjectAtomic"] = async (input) => {
    bump("createProjectAtomic");
    const p = { id: nextId("project"), ...input } as ProjectSummary;
    state.projects.push(p);
    return p;
  };
  const prepareUpdate: WorkspaceClient["prepareProjectUpdate"] = async (id, patch) => {
    bump("prepareProjectUpdate");
    const current = state.projects.find((project) => project.id === id);
    if (!current) throw new Error("project_not_found");
    return { ...current, ...patch };
  };
  const updateAtomic: WorkspaceClient["updateProjectAtomic"] = async (id, body) => {
    bump("updateProjectAtomic");
    const index = state.projects.findIndex((project) => project.id === id);
    const updated = { ...(index >= 0 ? state.projects[index] : { id, name: id }), ...body, id } as ProjectSummary;
    if (index >= 0) state.projects[index] = updated;
    else state.projects.push(updated);
    return updated;
  };
  const archiveAtomic: WorkspaceClient["archiveProjectAtomic"] = async (id, body) => {
    bump("archiveProjectAtomic");
    const index = state.projects.findIndex((project) => project.id === id);
    const updated = { ...(index >= 0 ? state.projects[index] : { id, name: id }), ...body, id } as ProjectSummary;
    if (index >= 0) state.projects[index] = updated;
    else state.projects.push(updated);
    return updated;
  };
  const deleteAtomic: WorkspaceClient["deleteProjectAtomic"] = async (id) => {
    bump("deleteProjectAtomic");
    state.projects = state.projects.filter((project) => project.id !== id);
    state.deleted.push({ entityType: "project", id });
  };
  const fromTemplateAtomic: WorkspaceClient["createProjectFromTemplateAtomic"] = async ({ templateProjectId, name }) => {
    bump("createProjectFromTemplateAtomic");
    const project = { id: nextId("project"), name: name || `from-${templateProjectId}` };
    state.projects.push(project);
    return project;
  };
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
      return fakeListResult(seed, "listProjects", rows);
    },
    async getProject(id) {
      bump("getProject");
      return state.projects.find((p) => p.id === id) ?? null;
    },
    async getProjectMutationState(id) {
      bump("getProjectMutationState");
      const row = state.projects.find((project) => project.id === id);
      return row ? { ...row } : null;
    },
    async createProject(input) {
      bump("createProject");
      return createAtomic(input);
    },
    createProjectAtomic: createAtomic,
    async updateProject(id, patch) {
      bump("updateProject");
      const index = state.projects.findIndex((p) => p.id === id);
      const base: ProjectSummary = index >= 0 ? state.projects[index] : { id, name: id };
      const updated: ProjectSummary = {
        ...base,
        ...(typeof patch.name === "string" ? { name: patch.name } : {}),
        ...(typeof patch.clientId === "string" ? { clientId: patch.clientId } : {}),
        ...(typeof patch.archived === "boolean" ? { archived: patch.archived } : {}),
        ...(patch.hourlyRate ? { hourlyRate: patch.hourlyRate as { amount: number } } : {}),
      };
      if (index >= 0) state.projects[index] = updated;
      else state.projects.push(updated);
      return updated;
    },
    prepareProjectUpdate: prepareUpdate,
    updateProjectAtomic: updateAtomic,
    async archiveProject(id) {
      bump("archiveProject");
      const index = state.projects.findIndex((p) => p.id === id);
      const base: ProjectSummary = index >= 0 ? state.projects[index] : { id, name: id };
      const archived: ProjectSummary = { ...base, archived: true };
      if (index >= 0) state.projects[index] = archived;
      else state.projects.push(archived);
      return archived;
    },
    archiveProjectAtomic: archiveAtomic,
    async deleteProject(id) {
      bump("deleteProject");
      state.projects = state.projects.filter((p) => p.id !== id);
      state.deleted.push({ entityType: "project", id });
    },
    deleteProjectAtomic: deleteAtomic,
    async createProjectFromTemplate({ templateProjectId, name }) {
      bump("createProjectFromTemplate");
      const p: ProjectSummary = { id: nextId("project"), name: name || `from-${templateProjectId}` };
      state.projects.push(p);
      return p;
    },
    createProjectFromTemplateAtomic: fromTemplateAtomic,
    async updateProjectRate(input) {
      bump("updateProjectRate");
      const key = input.rateKind === "COST" ? "costRate" : "hourlyRate";
      state.projectMemberships[input.projectId] = (state.projectMemberships[input.projectId] ?? []).map((row) =>
        String(row.userId) === input.userId
          ? { ...row, [key]: { amount: input.amountMinor, ...(input.since ? { since: input.since } : {}) } }
          : row);
    },
    async updateProjectRateAtomic(input) {
      bump("updateProjectRateAtomic");
      const key = input.rateKind === "COST" ? "costRate" : "hourlyRate";
      state.projectMemberships[input.projectId] = (state.projectMemberships[input.projectId] ?? []).map((row) =>
        String(row.userId) === input.userId
          ? { ...row, [key]: { amount: input.amountMinor, ...(input.since ? { since: input.since } : {}) } }
          : row);
    },
    async updateProjectMemberHourlyRateAtomic(input) {
      bump("updateProjectMemberHourlyRateAtomic");
      state.projectMemberships[input.projectId] = (state.projectMemberships[input.projectId] ?? []).map((row) =>
        String(row.userId) === input.userId
          ? { ...row, hourlyRate: { amount: input.amountMinor, ...(input.since ? { since: input.since } : {}) } }
          : row);
    },
    async updateProjectMemberCostRateAtomic(input) {
      bump("updateProjectMemberCostRateAtomic");
      state.projectMemberships[input.projectId] = (state.projectMemberships[input.projectId] ?? []).map((row) =>
        String(row.userId) === input.userId
          ? { ...row, costRate: { amount: input.amountMinor, ...(input.since ? { since: input.since } : {}) } }
          : row);
    },
    async updateProjectEstimate(id, patch) {
      bump("updateProjectEstimate");
      void id;
      void patch;
    },
    async updateProjectEstimateAtomic(id, patch) {
      bump("updateProjectEstimateAtomic");
      void id;
      void patch;
    },
    async updateProjectMemberships(id, patch) {
      bump("updateProjectMemberships");
      const rows = (patch as { memberships?: Array<Record<string, unknown>> }).memberships;
      if (rows) state.projectMemberships[id] = [...rows];
    },
    async updateProjectMembershipsAtomic(id, patch) {
      bump("updateProjectMembershipsAtomic");
      const rows = (patch as { memberships?: Array<Record<string, unknown>> }).memberships;
      if (rows) state.projectMemberships[id] = [...rows];
    },
    async getProjectMemberships(projectId) {
      bump("getProjectMemberships");
      return fakeListResult(seed, "getProjectMemberships", decodeProjectMembershipRows(state.projectMemberships[projectId] ?? []));
    },
  };
}
