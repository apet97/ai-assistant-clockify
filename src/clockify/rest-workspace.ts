import type {
  WorkspaceClient,
  EntitySummary,
  ProjectSummary,
  TaskSummary,
  TimeEntrySummary,
} from "./client.js";

/**
 * Real Clockify REST adapter for the `WorkspaceClient` port. Does I/O only — it
 * holds NO risk decisions, NO policy checks, and NO confirmation logic; those
 * stay in `src/harness/*`. Supports either add-on-token auth (production:
 * `X-Addon-Token`) or API-key auth (live smoke: `X-Api-Key`).
 *
 * The token/key is sent only in the request header — never logged, never placed
 * in a prompt, never returned.
 */
export type ClockifyAuth = { addonToken: string } | { apiKey: string };

export interface RestWorkspaceOptions {
  baseUrl: string; // e.g. https://api.clockify.me/api/v1
  workspaceId: string;
  auth: ClockifyAuth;
  fetchImpl?: typeof fetch; // injectable for tests
}

interface ClockifyTimeEntry {
  id: string;
  description?: string;
  projectId?: string;
  taskId?: string;
  tagIds?: string[];
  billable?: boolean;
  timeInterval?: { start: string; end?: string | null };
}

function mapEntry(e: ClockifyTimeEntry): TimeEntrySummary {
  return {
    id: e.id,
    description: e.description,
    projectId: e.projectId,
    taskId: e.taskId,
    tagIds: e.tagIds,
    billable: e.billable,
    start: e.timeInterval?.start ?? "",
    end: e.timeInterval?.end ?? null,
  };
}

export function createRestWorkspaceClient(opts: RestWorkspaceOptions): WorkspaceClient {
  const base = opts.baseUrl.replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const authHeader: Record<string, string> =
    "addonToken" in opts.auth
      ? { "X-Addon-Token": opts.auth.addonToken }
      : { "X-Api-Key": opts.auth.apiKey };
  const ws = `/workspaces/${opts.workspaceId}`;

  async function call(
    method: string,
    path: string,
    body?: unknown,
    allow404 = false,
  ): Promise<unknown> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...authHeader },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 404 && allow404) return null;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Clockify ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  return {
    async listTags() {
      const rows = (await call("GET", `${ws}/tags?page-size=200&archived=false`)) as Array<{
        id: string;
        name: string;
        archived?: boolean;
      }>;
      return rows.map((t): EntitySummary => ({ id: t.id, name: t.name, archived: t.archived }));
    },
    async createTag({ name }) {
      const t = (await call("POST", `${ws}/tags`, { name })) as { id: string; name: string };
      return { id: t.id, name: t.name };
    },
    async listClients() {
      const rows = (await call("GET", `${ws}/clients?page-size=200`)) as Array<{
        id: string;
        name: string;
        archived?: boolean;
      }>;
      return rows.map((c): EntitySummary => ({ id: c.id, name: c.name, archived: c.archived }));
    },
    async createClient({ name }) {
      const c = (await call("POST", `${ws}/clients`, { name })) as { id: string; name: string };
      return { id: c.id, name: c.name };
    },
    async listProjects() {
      const rows = (await call(
        "GET",
        `${ws}/projects?page-size=200&archived=false`,
      )) as Array<{ id: string; name: string; clientId?: string; archived?: boolean }>;
      return rows.map(
        (p): ProjectSummary => ({
          id: p.id,
          name: p.name,
          clientId: p.clientId,
          archived: p.archived,
        }),
      );
    },
    async createProject({ name, clientId }) {
      const p = (await call("POST", `${ws}/projects`, {
        name,
        ...(clientId ? { clientId } : {}),
      })) as { id: string; name: string; clientId?: string };
      return { id: p.id, name: p.name, clientId: p.clientId };
    },
    async listTasks(projectId) {
      const rows = (await call(
        "GET",
        `${ws}/projects/${projectId}/tasks?page-size=200`,
      )) as Array<{ id: string; name: string }>;
      return rows.map((t): TaskSummary => ({ id: t.id, name: t.name, projectId }));
    },
    async createTask({ projectId, name }) {
      const t = (await call("POST", `${ws}/projects/${projectId}/tasks`, { name })) as {
        id: string;
        name: string;
      };
      return { id: t.id, name: t.name, projectId };
    },
    async getRunningTimeEntry(userId) {
      const rows = (await call(
        "GET",
        `${ws}/user/${userId}/time-entries?in-progress=true`,
      )) as ClockifyTimeEntry[];
      return rows.length ? mapEntry(rows[0]) : null;
    },
    async startTimeEntry(input) {
      const e = (await call("POST", `${ws}/time-entries`, {
        start: input.start,
        description: input.description,
        projectId: input.projectId,
        taskId: input.taskId,
        tagIds: input.tagIds,
        billable: input.billable,
      })) as ClockifyTimeEntry;
      return mapEntry(e);
    },
    async stopTimeEntry({ userId, end }) {
      const e = (await call(
        "PATCH",
        `${ws}/user/${userId}/time-entries`,
        { end },
        true,
      )) as ClockifyTimeEntry | null;
      return e ? mapEntry(e) : null;
    },
    async createTimeEntry(input) {
      const e = (await call("POST", `${ws}/time-entries`, {
        start: input.start,
        end: input.end,
        description: input.description,
        projectId: input.projectId,
        taskId: input.taskId,
        tagIds: input.tagIds,
        billable: input.billable,
      })) as ClockifyTimeEntry;
      return mapEntry(e);
    },
    async getEntries({ userId, start, end }) {
      const params = new URLSearchParams({ "page-size": "200" });
      if (start) params.set("start", start);
      if (end) params.set("end", end);
      const rows = (await call(
        "GET",
        `${ws}/user/${userId}/time-entries?${params.toString()}`,
      )) as ClockifyTimeEntry[];
      return rows.map(mapEntry);
    },
    async listExpenses() {
      // TODO verify exact Clockify expenses response (pagination wrapper / fields)
      // against the docs before live use. Handles both an array and {expenses:[...]}.
      const data = (await call("GET", `${ws}/expenses`)) as
        | Array<{ id: string; name?: string; notes?: string }>
        | { expenses?: Array<{ id: string; name?: string; notes?: string }> };
      const rows = Array.isArray(data) ? data : (data?.expenses ?? []);
      return rows.map((e): EntitySummary => ({ id: e.id, name: e.name ?? e.notes ?? e.id }));
    },
    async listUsers() {
      const rows = (await call("GET", `${ws}/users`)) as Array<{
        id: string;
        name?: string;
        email?: string;
      }>;
      return rows.map((u): EntitySummary => ({ id: u.id, name: u.name ?? u.email ?? u.id }));
    },
    async listWebhooks() {
      // TODO verify exact Clockify webhooks response against the docs before live use.
      const rows = (await call("GET", `${ws}/webhooks`)) as Array<{ id: string; name?: string }>;
      return rows.map((w): EntitySummary => ({ id: w.id, name: w.name ?? w.id }));
    },
    async updateTimeEntry({ id, description, projectId, taskId, tagIds }) {
      // TODO before live use: Clockify's PUT /time-entries/{id} replaces the entry
      // and REQUIRES `start` (a sparse body can 400 or null out `start`). Wire this
      // to GET-before-PUT (merge onto the current entry) — do not ship as-is live.
      const e = (await call("PUT", `${ws}/time-entries/${id}`, {
        description,
        projectId,
        taskId,
        tagIds,
      })) as ClockifyTimeEntry;
      return mapEntry(e);
    },
    async deleteEntity({ entityType, id }) {
      const pathByType: Record<string, string> = {
        tag: `${ws}/tags/${id}`,
        project: `${ws}/projects/${id}`,
        client: `${ws}/clients/${id}`,
        time_entry: `${ws}/time-entries/${id}`,
      };
      const path = pathByType[entityType];
      if (!path) throw new Error(`delete not supported for entity type: ${entityType}`);
      await call("DELETE", path);
    },
    async createInvoice({ clientId, title }) {
      // TODO verify exact Clockify invoice body before live use.
      const inv = (await call("POST", `${ws}/invoices`, {
        clientId,
        ...(title ? { number: title } : {}),
      })) as { id: string; number?: string };
      return { id: inv.id, name: inv.number ?? "invoice" };
    },
    async manageWebhook(input) {
      // TODO verify exact Clockify webhook body before live use.
      if (input.operation === "delete") {
        await call("DELETE", `${ws}/webhooks/${input.id}`);
        return null;
      }
      const method = input.operation === "create" ? "POST" : "PUT";
      const path =
        input.operation === "create" ? `${ws}/webhooks` : `${ws}/webhooks/${input.id}`;
      const w = (await call(method, path, { name: input.name, url: input.url })) as {
        id: string;
        name?: string;
      };
      return { id: w.id, name: w.name ?? "webhook" };
    },
  };
}
