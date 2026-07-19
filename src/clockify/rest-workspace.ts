import type { WorkspaceClient } from "./client.js";
import type { ClockifyAuth } from "./types.js";
import { createRestCore, type RestCoreOptions } from "./rest/core.js";
import { makeProjectRest } from "./rest/projects.js";
import { makeTimeEntryRest } from "./rest/time-entries.js";
import { makeTaskRest } from "./rest/tasks.js";
import { makeClientRest } from "./rest/clients.js";
import { makeTagRest } from "./rest/tags.js";
import { makeInvoiceRest } from "./rest/invoices.js";
import { makeExpenseRest } from "./rest/expenses.js";
import { makeCustomFieldRest } from "./rest/custom-fields.js";
import { makeTimeOffRest } from "./rest/time-off.js";
import { makeHolidayRest } from "./rest/holidays.js";
import { makeSchedulingRest } from "./rest/scheduling.js";
import { makeApprovalRest } from "./rest/approvals.js";
import { makeWebhookRest } from "./rest/webhooks.js";
import { makeUserRest } from "./rest/users.js";
import { makeReportRest } from "./rest/reports.js";
import { makeAuditRest } from "./rest/audit.js";
import { makeWorkspaceRest } from "./rest/workspace.js";

/**
 * Real Clockify REST adapter for the `WorkspaceClient` port. Does I/O only — it
 * holds NO risk decisions, NO policy checks, and NO confirmation logic; those
 * stay in `src/harness/*`. Supports either add-on-token auth (production:
 * `X-Addon-Token`) or API-key auth (live smoke: `X-Api-Key`).
 *
 * The token/key is sent only in the request header — never logged, never placed
 * in a prompt, never returned.
 */
// `ClockifyAuth` now lives in the import-free leaf (types.ts) so the adapter and
// the core share ONE definition; re-exported here because callers/tests import
// it from this module.
export type { ClockifyAuth };

export interface RestWorkspaceOptions
  extends Pick<RestCoreOptions, "reportsBase" | "auditBase" | "auth" | "fetchImpl" | "commitTimeoutMs" | "requestGovernor" | "signal"> {
  baseUrl: string; // e.g. https://api.clockify.me/api/v1
  workspaceId: string;
  /** Unit/integration adapter probes only. Production always leaves this true. */
  testOnlyEnforceMutationScope?: boolean;
}

export function createRestWorkspaceClient(opts: RestWorkspaceOptions): WorkspaceClient {
  const base = opts.baseUrl.replace(/\/$/, "");

  // Per-area REST modules built on the multi-host core (D2). The core shares this
  // adapter's auth + base; areas are migrated off the inline `call` phase by phase.
  const core = createRestCore({
    apiBase: base,
    reportsBase: opts.reportsBase,
    auditBase: opts.auditBase,
    auth: opts.auth,
    fetchImpl: opts.fetchImpl,
    commitTimeoutMs: opts.commitTimeoutMs,
    requestGovernor: opts.requestGovernor,
    signal: opts.signal,
    enforceMutationScope: process.env.NODE_ENV === "test"
      ? (opts.testOnlyEnforceMutationScope ?? true)
      : true,
  });
  const projectRest = makeProjectRest(core, opts.workspaceId);
  const timeEntryRest = makeTimeEntryRest(core, opts.workspaceId);
  const taskRest = makeTaskRest(core, opts.workspaceId);
  const clientRest = makeClientRest(core, opts.workspaceId);
  const tagRest = makeTagRest(core, opts.workspaceId);
  const invoiceRest = makeInvoiceRest(core, opts.workspaceId);
  const expenseRest = makeExpenseRest(core, opts.workspaceId);
  const customFieldRest = makeCustomFieldRest(core, opts.workspaceId);
  const timeOffRest = makeTimeOffRest(core, opts.workspaceId);
  const holidayRest = makeHolidayRest(core, opts.workspaceId);
  const schedulingRest = makeSchedulingRest(core, opts.workspaceId);
  const approvalRest = makeApprovalRest(core, opts.workspaceId);
  const webhookRest = makeWebhookRest(core, opts.workspaceId);
  const userRest = makeUserRest(core, opts.workspaceId);
  const reportRest = makeReportRest(core, opts.workspaceId);
  const auditRest = makeAuditRest(core, opts.workspaceId);
  const workspaceRest = makeWorkspaceRest(core, opts.workspaceId);

  return {
    // Some endpoint families are refused for the add-on token class — the
    // workflows surface that at PREVIEW time instead of a doomed confirm.
    authClass: "addonToken" in opts.auth ? "addon" : "api_key",
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
    ...timeOffRest,
    ...holidayRest,
    ...schedulingRest,
    ...approvalRest,
    ...webhookRest,
    ...userRest,
    ...reportRest,
    ...auditRest,
    ...workspaceRest,
    async deleteEntity({ entityType, id, projectId }) {
      // Route the generic delete to the typed per-area deleter, which owns the
      // archive-then-delete ordering Clockify requires (projects/clients archive
      // first because a bare DELETE is rejected for an active one; tasks mark
      // DONE then DELETE). The task case is special: a delete is PROJECT-scoped,
      // so without the projectId we cannot route it and fail loudly rather than
      // guess (a created-task undo always carries its projectId).
      if (entityType === "task") {
        if (!projectId) throw new Error("delete not supported for a task without its projectId");
        await taskRest.deleteTask(projectId, id);
        return;
      }
      const deleteByType: Record<string, (id: string) => Promise<void>> = {
        project: (i) => projectRest.deleteProject(i), // archive-then-delete
        client: (i) => clientRest.deleteClient(i), // archive-then-delete
        tag: (i) => tagRest.deleteTag(i),
        invoice: (i) => invoiceRest.deleteInvoice(i),
        expense: (i) => expenseRest.deleteExpense(i),
        webhook: (i) => webhookRest.deleteWebhook(i),
        group: (i) => userRest.deleteGroup(i),
        holiday: (i) => holidayRest.deleteHoliday(i),
        assignment: (i) => schedulingRest.deleteAssignment(i),
        time_entry: (i) => timeEntryRest.deleteTimeEntryAtomic(i),
      };
      const del = deleteByType[entityType];
      if (!del) throw new Error(`delete not supported for entity type: ${entityType}`);
      await del(id);
    },
    async updateEntity({ entityType, id, fields }) {
      // Delegate to the typed per-area update (each is GET-then-merge-PUT, since
      // Clockify replaces on PUT). Only project/client/tag have a single-resource
      // path; `task` needs a projectId this generic signature lacks, so it (and
      // every other type) throws a clear error rather than guessing. Normalize the
      // typed result back to the `{id,name}` shape admin.ts's commit consumes.
      const patch = fields ?? {};
      const updateByType: Record<string, (patch: Record<string, unknown>) => Promise<{ id: string; name: string }>> = {
        project: (p) => projectRest.updateProject(id, p),
        client: (p) => clientRest.updateClient(id, p),
        tag: (p) => tagRest.updateTag(id, p),
      };
      const update = updateByType[entityType];
      if (!update) throw new Error(`update not supported for entity type: ${entityType}`);
      const updated = await update(patch);
      return { id: updated.id ?? id, name: updated.name ?? id };
    },
  };
}
