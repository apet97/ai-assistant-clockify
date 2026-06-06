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
    async listTags() {
      bump("listTags");
      return state.tags;
    },
    async createTag({ name }) {
      bump("createTag");
      const tag = { id: nextId("tag"), name };
      state.tags.push(tag);
      return tag;
    },
    async listClients() {
      bump("listClients");
      return state.clients;
    },
    async createClient({ name }) {
      bump("createClient");
      const c = { id: nextId("client"), name };
      state.clients.push(c);
      return c;
    },
    async listProjects() {
      bump("listProjects");
      return state.projects;
    },
    async createProject({ name, clientId }) {
      bump("createProject");
      const p: ProjectSummary = { id: nextId("project"), name, clientId };
      state.projects.push(p);
      return p;
    },
    async listTasks(projectId) {
      bump("listTasks");
      return state.tasks.filter((t) => t.projectId === projectId);
    },
    async createTask({ projectId, name }) {
      bump("createTask");
      const t: TaskSummary = { id: nextId("task"), name, projectId };
      state.tasks.push(t);
      return t;
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
    async getEntries({ start, end }) {
      bump("getEntries");
      // ISO-8601 UTC strings sort lexicographically, so range filtering works.
      return state.timeEntries.filter((e) => {
        if (start && e.start < start) return false;
        if (end && e.start >= end) return false;
        return true;
      });
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
