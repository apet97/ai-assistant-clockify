import type {
  WorkspaceClient,
  EntitySummary,
  TaskSummary,
  TimeEntrySummary,
} from "./client.js";
import { createRestCore } from "./rest/core.js";
import { makeProjectRest } from "./rest/projects.js";

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

/** Clockify date fields want a full ISO datetime; normalize a YYYY-MM-DD input. */
function toClockifyDate(d?: string): string | undefined {
  if (!d) return d;
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00Z` : d;
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
    // multipart/form-data bodies (expenses) must NOT carry a JSON content-type —
    // fetch/undici sets the multipart boundary itself when the body is a FormData.
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: { ...(isForm ? {} : { "content-type": "application/json" }), ...authHeader },
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
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

  // Per-area REST modules built on the multi-host core (D2). The core shares this
  // adapter's auth + base; areas are migrated off the inline `call` phase by phase.
  const core = createRestCore({ apiBase: base, auth: opts.auth, fetchImpl: opts.fetchImpl });
  const projectRest = makeProjectRest(core, opts.workspaceId);

  return {
    // Projects: typed module (Phase 2). Spread first; the inline methods below
    // cover the not-yet-migrated areas.
    ...projectRest,
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
      // Live shape: /expenses returns {expenses:{expenses:[...],count}, dailyTotals,
      // weeklyTotals} — double-nested. Items use `notes` (no `name`). Tolerate a
      // plain array too (older shape) for safety.
      type ExpenseRow = { id: string; name?: string; notes?: string };
      const data = (await call("GET", `${ws}/expenses`)) as
        | ExpenseRow[]
        | { expenses?: { expenses?: ExpenseRow[] } };
      const rows = Array.isArray(data) ? data : (data?.expenses?.expenses ?? []);
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
      // Live shape: /webhooks returns {workspaceWebhookCount, webhooks:[...]} — an
      // envelope, not a bare array. Tolerate a plain array too for safety.
      type WebhookRow = { id: string; name?: string };
      const data = (await call("GET", `${ws}/webhooks`)) as
        | WebhookRow[]
        | { webhooks?: WebhookRow[] };
      const rows = Array.isArray(data) ? data : (data?.webhooks ?? []);
      return rows.map((w): EntitySummary => ({ id: w.id, name: w.name ?? w.id }));
    },
    async updateTimeEntry({ id, description, projectId, taskId, tagIds }) {
      // Clockify's PUT /time-entries/{id} REPLACES the entry and REQUIRES `start`;
      // a sparse body 400s ("invalid value for field [start]"). GET the current
      // entry, flatten its timeInterval to the top-level shape PUT expects, then
      // merge the caller's fields and PUT the full body.
      const current = (await call("GET", `${ws}/time-entries/${id}`)) as ClockifyTimeEntry;
      const body: Record<string, unknown> = {
        start: current.timeInterval?.start,
        end: current.timeInterval?.end ?? undefined,
        description: description ?? current.description,
        projectId: projectId ?? current.projectId,
        taskId: taskId ?? current.taskId,
        tagIds: tagIds ?? current.tagIds,
        billable: current.billable,
      };
      const e = (await call("PUT", `${ws}/time-entries/${id}`, body)) as ClockifyTimeEntry;
      return mapEntry(e);
    },
    async deleteEntity({ entityType, id }) {
      // Projects and clients cannot be deleted while active — Clockify rejects a
      // bare DELETE ("Cannot delete an active ..."). Archive first, then delete.
      // The typed project module owns the project path; clients archive inline
      // until the Clients phase adds a typed module.
      if (entityType === "project") {
        await projectRest.deleteProject(id); // archive-then-delete
        return;
      }
      if (entityType === "client") {
        const current = ((await call("GET", `${ws}/clients/${id}`)) ?? {}) as Record<string, unknown>;
        await call("PUT", `${ws}/clients/${id}`, { ...current, archived: true });
        await call("DELETE", `${ws}/clients/${id}`);
        return;
      }
      const pathByType: Record<string, string> = {
        tag: `${ws}/tags/${id}`,
        time_entry: `${ws}/time-entries/${id}`,
      };
      const path = pathByType[entityType];
      if (!path) throw new Error(`delete not supported for entity type: ${entityType}`);
      await call("DELETE", path);
    },
    async createInvoice({ clientId, title, number, issuedDate, dueDate, currency }) {
      // Clockify create requires number/issuedDate/currency/dueDate alongside the
      // client; the action handler fills defaults so a sparse call still works.
      const inv = (await call("POST", `${ws}/invoices`, {
        clientId,
        number: number ?? title,
        issuedDate: toClockifyDate(issuedDate),
        dueDate: toClockifyDate(dueDate),
        currency,
      })) as { id: string; number?: string };
      return { id: inv.id, name: inv.number ?? number ?? "invoice" };
    },
    async manageWebhook(input) {
      if (input.operation === "delete") {
        await call("DELETE", `${ws}/webhooks/${input.id}`);
        return null;
      }
      // Create/update require webhookEvent + trigger source. For a workspace-scoped
      // event, default the trigger source to this workspace (the only value the
      // adapter can know); other shapes are passed through from the caller.
      const body: Record<string, unknown> = {
        name: input.name,
        url: input.url,
        webhookEvent: input.webhookEvent,
        triggerSourceType: input.triggerSourceType ?? "WORKSPACE_ID",
        triggerSource: input.triggerSource ?? [opts.workspaceId],
        ...(input.authToken ? { authToken: input.authToken } : {}),
      };
      const method = input.operation === "create" ? "POST" : "PUT";
      const path =
        input.operation === "create" ? `${ws}/webhooks` : `${ws}/webhooks/${input.id}`;
      const w = (await call(method, path, body)) as { id: string; name?: string };
      return { id: w.id, name: w.name ?? "webhook" };
    },
    async updateEntity({ entityType, id, fields }) {
      // Fetch-then-merge PUT (Clockify replaces on PUT, so merge onto the current
      // entity). Only single-resource paths are supported here; `task` needs a
      // projectId that this generic signature lacks, so it (and other types)
      // throw a clear error rather than guessing.
      const pathByType: Record<string, string> = {
        project: `${ws}/projects/${id}`,
        client: `${ws}/clients/${id}`,
        tag: `${ws}/tags/${id}`,
      };
      const path = pathByType[entityType];
      if (!path) throw new Error(`update not supported for entity type: ${entityType}`);
      const current = ((await call("GET", path)) ?? {}) as Record<string, unknown>;
      const merged = { ...current, ...(fields ?? {}) };
      const updated = (await call("PUT", path, merged)) as { id?: string; name?: string };
      return { id: updated.id ?? id, name: updated.name ?? id };
    },
    async manageExpense(input) {
      if (input.operation === "delete") {
        await call("DELETE", `${ws}/expenses/${input.id}`);
        return null;
      }
      // Create/update are multipart/form-data (Clockify expects a form, optionally
      // with a receipt file). `amount` is major currency units; `name` → `notes`.
      const form = new FormData();
      if (input.userId !== undefined) form.append("userId", input.userId);
      if (input.categoryId !== undefined) form.append("categoryId", input.categoryId);
      if (input.amount !== undefined) form.append("amount", String(input.amount));
      if (input.date !== undefined) form.append("date", toClockifyDate(input.date) ?? input.date);
      if (input.name !== undefined) form.append("notes", input.name);
      const method = input.operation === "create" ? "POST" : "PUT";
      const path =
        input.operation === "create" ? `${ws}/expenses` : `${ws}/expenses/${input.id}`;
      const e = (await call(method, path, form)) as { id: string; notes?: string };
      return { id: e.id, name: e.notes ?? input.name ?? "expense" };
    },
    async manageTimeOff({ policyId, requestId, decision }) {
      // Approve/deny a time-off request under its policy. NOTE: exercised live as
      // preview-only (the sac workspace has no GET-able pending request), so the
      // exact status body is best-effort and covered by the unit test, not a live
      // round-trip.
      const statusType = decision === "approve" ? "APPROVED" : "REJECTED";
      const r = (await call(
        "PATCH",
        `${ws}/time-off/policies/${policyId}/requests/${requestId}`,
        { statusType },
      )) as { id?: string } | null;
      return { id: r?.id ?? requestId, name: decision };
    },
    async manageSchedule({ start, end }) {
      // Publish scheduled assignments for a date range. NOTE: exercised live as
      // preview-only (publishing has real assignee-notification side effects), so
      // the body is covered by the unit test, not a live round-trip.
      const r = (await call("POST", `${ws}/scheduling/assignments/publish`, {
        start,
        end,
      })) as { id?: string } | null;
      return { id: r?.id ?? "published", name: "schedule" };
    },
  };
}
