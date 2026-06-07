import type { WorkspaceClient, EntitySummary } from "./client.js";
import { createRestCore } from "./rest/core.js";
import { makeProjectRest } from "./rest/projects.js";
import { makeTimeEntryRest } from "./rest/time-entries.js";
import { makeTaskRest } from "./rest/tasks.js";
import { makeClientRest } from "./rest/clients.js";
import { makeTagRest } from "./rest/tags.js";
import { makeInvoiceRest } from "./rest/invoices.js";
import { makeExpenseRest } from "./rest/expenses.js";
import { makeCustomFieldRest } from "./rest/custom-fields.js";

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
  const timeEntryRest = makeTimeEntryRest(core, opts.workspaceId);
  const taskRest = makeTaskRest(core, opts.workspaceId);
  const clientRest = makeClientRest(core, opts.workspaceId);
  const tagRest = makeTagRest(core, opts.workspaceId);
  const invoiceRest = makeInvoiceRest(core, opts.workspaceId);
  const expenseRest = makeExpenseRest(core, opts.workspaceId);
  const customFieldRest = makeCustomFieldRest(core, opts.workspaceId);

  return {
    // Typed area modules (spread first); the inline methods below cover the
    // not-yet-migrated areas.
    ...projectRest,
    ...timeEntryRest,
    ...taskRest,
    ...clientRest,
    ...tagRest,
    ...invoiceRest,
    ...expenseRest,
    ...customFieldRest,
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
        await clientRest.deleteClient(id); // archive-then-delete
        return;
      }
      if (entityType === "tag") {
        await tagRest.deleteTag(id);
        return;
      }
      if (entityType === "invoice") {
        await invoiceRest.deleteInvoice(id);
        return;
      }
      if (entityType === "expense") {
        await expenseRest.deleteExpense(id);
        return;
      }
      const pathByType: Record<string, string> = {
        time_entry: `${ws}/time-entries/${id}`,
      };
      const path = pathByType[entityType];
      if (!path) throw new Error(`delete not supported for entity type: ${entityType}`);
      await call("DELETE", path);
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
