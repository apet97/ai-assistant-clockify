import type {
  EntitySummary,
  ProjectSummary,
  TaskSummary,
  TimeEntrySummary,
  WorkspaceClient,
} from "../../src/clockify/client.js";

/**
 * In-memory fake of the Clockify WorkspaceClient port for deterministic tests.
 * Tracks per-method call counts so tests can assert "called once" / "not called".
 */
export interface FakeWorkspaceSeed {
  tags?: EntitySummary[];
  clients?: EntitySummary[];
  projects?: ProjectSummary[];
  tasks?: TaskSummary[];
  running?: TimeEntrySummary | null;
  entries?: TimeEntrySummary[];
  expenses?: EntitySummary[];
  users?: EntitySummary[];
  webhooks?: EntitySummary[];
  /** deleteEntity throws for these ids (used to exercise partial batch failure). */
  failDeleteIds?: string[];
}

export interface FakeWorkspace {
  client: WorkspaceClient;
  counts: Record<string, number>;
  state: {
    tags: EntitySummary[];
    clients: EntitySummary[];
    projects: ProjectSummary[];
    tasks: TaskSummary[];
    timeEntries: TimeEntrySummary[];
    running: TimeEntrySummary | null;
    expenses: EntitySummary[];
    users: EntitySummary[];
    webhooks: EntitySummary[];
    deleted: Array<{ entityType: string; id: string }>;
  };
}

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

export function createFakeWorkspace(seed: FakeWorkspaceSeed = {}): FakeWorkspace {
  const state: FakeWorkspace["state"] = {
    tags: [...(seed.tags ?? [])],
    clients: [...(seed.clients ?? [])],
    projects: [...(seed.projects ?? [])],
    tasks: [...(seed.tasks ?? [])],
    timeEntries: [...(seed.entries ?? [])],
    running: seed.running ?? null,
    expenses: [...(seed.expenses ?? [])],
    users: [...(seed.users ?? [])],
    webhooks: [...(seed.webhooks ?? [])],
    deleted: [],
  };
  const counts: Record<string, number> = {};
  const bump = (method: string): void => {
    counts[method] = (counts[method] ?? 0) + 1;
  };

  const client: WorkspaceClient = {
    async listTags(filter) {
      bump("listTags");
      let rows = state.tags;
      if (filter?.name) {
        const needle = filter.name.toLowerCase();
        rows = rows.filter((t) => t.name.toLowerCase().includes(needle));
      }
      if (filter?.archived !== undefined) {
        rows = rows.filter((t) => Boolean(t.archived) === filter.archived);
      }
      return rows;
    },
    async getTag(id) {
      bump("getTag");
      return state.tags.find((t) => t.id === id) ?? null;
    },
    async createTag({ name }) {
      bump("createTag");
      const tag = { id: nextId("tag"), name };
      state.tags.push(tag);
      return tag;
    },
    async updateTag(id, patch) {
      bump("updateTag");
      const index = state.tags.findIndex((t) => t.id === id);
      const base: EntitySummary = index >= 0 ? state.tags[index] : { id, name: id };
      const updated: EntitySummary = {
        ...base,
        ...(typeof patch.name === "string" ? { name: patch.name } : {}),
        ...(typeof patch.archived === "boolean" ? { archived: patch.archived } : {}),
      };
      if (index >= 0) state.tags[index] = updated;
      else state.tags.push(updated);
      return updated;
    },
    async deleteTag(id) {
      bump("deleteTag");
      state.tags = state.tags.filter((t) => t.id !== id);
      state.deleted.push({ entityType: "tag", id });
    },
    async listClients(filter) {
      bump("listClients");
      let rows = state.clients;
      if (filter?.name) {
        const needle = filter.name.toLowerCase();
        rows = rows.filter((c) => c.name.toLowerCase().includes(needle));
      }
      if (filter?.archived !== undefined) {
        rows = rows.filter((c) => Boolean(c.archived) === filter.archived);
      }
      return rows;
    },
    async getClient(id) {
      bump("getClient");
      return state.clients.find((c) => c.id === id) ?? null;
    },
    async createClient({ name }) {
      bump("createClient");
      const c = { id: nextId("client"), name };
      state.clients.push(c);
      return c;
    },
    async updateClient(id, patch) {
      bump("updateClient");
      const index = state.clients.findIndex((c) => c.id === id);
      const base: EntitySummary = index >= 0 ? state.clients[index] : { id, name: id };
      const updated: EntitySummary = {
        ...base,
        ...(typeof patch.name === "string" ? { name: patch.name } : {}),
        ...(typeof patch.archived === "boolean" ? { archived: patch.archived } : {}),
      };
      if (index >= 0) state.clients[index] = updated;
      else state.clients.push(updated);
      return updated;
    },
    async deleteClient(id) {
      bump("deleteClient");
      state.clients = state.clients.filter((c) => c.id !== id);
      state.deleted.push({ entityType: "client", id });
    },
    async listProjects(filter) {
      bump("listProjects");
      let rows = state.projects;
      if (filter?.name) {
        const needle = filter.name.toLowerCase();
        rows = rows.filter((p) => p.name.toLowerCase().includes(needle));
      }
      if (filter?.archived !== undefined) {
        rows = rows.filter((p) => Boolean(p.archived) === filter.archived);
      }
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
      void id;
      void patch;
    },
    async listTasks(projectId, filter) {
      bump("listTasks");
      let rows = state.tasks.filter((t) => t.projectId === projectId);
      if (filter?.name) {
        const needle = filter.name.toLowerCase();
        rows = rows.filter((t) => t.name.toLowerCase().includes(needle));
      }
      return rows;
    },
    async getTask(projectId, id) {
      bump("getTask");
      return state.tasks.find((t) => t.projectId === projectId && t.id === id) ?? null;
    },
    async createTask({ projectId, name }) {
      bump("createTask");
      const t: TaskSummary = { id: nextId("task"), name, projectId };
      state.tasks.push(t);
      return t;
    },
    async updateTask(projectId, id, patch) {
      bump("updateTask");
      const index = state.tasks.findIndex((t) => t.projectId === projectId && t.id === id);
      const base: TaskSummary = index >= 0 ? state.tasks[index] : { id, name: id, projectId };
      const updated: TaskSummary = {
        ...base,
        ...(typeof patch.name === "string" ? { name: patch.name } : {}),
      };
      if (index >= 0) state.tasks[index] = updated;
      else state.tasks.push(updated);
      return updated;
    },
    async deleteTask(projectId, id) {
      bump("deleteTask");
      state.tasks = state.tasks.filter((t) => !(t.projectId === projectId && t.id === id));
      state.deleted.push({ entityType: "task", id });
    },
    async updateTaskRate(input) {
      bump("updateTaskRate");
      void input;
    },
    async getRunningTimeEntry() {
      bump("getRunningTimeEntry");
      return state.running;
    },
    async startTimeEntry(input) {
      bump("startTimeEntry");
      const entry: TimeEntrySummary = {
        id: nextId("entry"),
        description: input.description,
        projectId: input.projectId,
        taskId: input.taskId,
        tagIds: input.tagIds,
        billable: input.billable,
        start: input.start,
      };
      state.running = entry;
      state.timeEntries.push(entry);
      return entry;
    },
    async stopTimeEntry({ end }) {
      bump("stopTimeEntry");
      if (!state.running) return null;
      const stopped: TimeEntrySummary = { ...state.running, end };
      state.running = null;
      return stopped;
    },
    async createTimeEntry(input) {
      bump("createTimeEntry");
      const entry: TimeEntrySummary = {
        id: nextId("entry"),
        description: input.description,
        projectId: input.projectId,
        taskId: input.taskId,
        tagIds: input.tagIds,
        billable: input.billable,
        start: input.start,
        end: input.end ?? null,
      };
      state.timeEntries.push(entry);
      return entry;
    },
    async getEntries({ start, end, projectId, taskId }) {
      bump("getEntries");
      // ISO-8601 UTC strings sort lexicographically, so range filtering works.
      return state.timeEntries.filter((e) => {
        if (start && e.start < start) return false;
        if (end && e.start >= end) return false;
        if (projectId && e.projectId !== projectId) return false;
        if (taskId && e.taskId !== taskId) return false;
        return true;
      });
    },
    async getEntry(id) {
      bump("getEntry");
      return state.timeEntries.find((e) => e.id === id) ?? null;
    },
    async markEntriesInvoiced(input) {
      bump("markEntriesInvoiced");
      void input;
    },
    async updateTimeEntry({ id, description, projectId, taskId, tagIds }) {
      bump("updateTimeEntry");
      const index = state.timeEntries.findIndex((e) => e.id === id);
      const base: TimeEntrySummary =
        index >= 0 ? state.timeEntries[index] : { id, start: "" };
      const updated: TimeEntrySummary = {
        ...base,
        description: description ?? base.description,
        projectId: projectId ?? base.projectId,
        taskId: taskId ?? base.taskId,
        tagIds: tagIds ?? base.tagIds,
      };
      if (index >= 0) state.timeEntries[index] = updated;
      else state.timeEntries.push(updated);
      return updated;
    },
    async listExpenses() {
      bump("listExpenses");
      return state.expenses;
    },
    async listUsers() {
      bump("listUsers");
      return state.users;
    },
    async listWebhooks() {
      bump("listWebhooks");
      return state.webhooks;
    },
    async deleteEntity(input) {
      bump("deleteEntity");
      if ((seed.failDeleteIds ?? []).includes(input.id)) {
        throw new Error(`Clockify refused to delete ${input.entityType} ${input.id}`);
      }
      state.deleted.push(input);
    },
    async createInvoice(input) {
      bump("createInvoice");
      return { id: nextId("invoice"), name: input.title ?? `Invoice for ${input.clientId}` };
    },
    async manageWebhook(input) {
      bump("manageWebhook");
      if (input.operation === "delete") return null;
      return { id: input.id ?? nextId("webhook"), name: input.name ?? "webhook" };
    },
    async updateEntity(input) {
      bump("updateEntity");
      const name = (input.fields?.name as string | undefined) ?? input.id;
      return { id: input.id, name };
    },
    async manageExpense(input) {
      bump("manageExpense");
      if (input.operation === "delete") return null;
      return { id: input.id ?? nextId("expense"), name: input.name ?? "expense" };
    },
    async manageTimeOff(input) {
      bump("manageTimeOff");
      return { id: input.requestId, name: input.decision };
    },
    async manageSchedule(input) {
      bump("manageSchedule");
      void input.start;
      void input.end;
      return { id: nextId("schedule"), name: "schedule" };
    },
  };

  return { client, counts, state };
}
