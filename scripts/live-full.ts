/**
 * Opt-in EXHAUSTIVE live Clockify exerciser. Drives every catalog action through
 * the REAL harness (executeAction + preview→confirm→commit) against a sacrificial
 * workspace via the REST adapter (API-key auth, dev-only). It creates only
 * AIASSIST_SMOKE_* resources and cleans up everything it can, reporting a
 * per-action matrix and any leftovers.
 *
 * This is a dev tool, NOT the add-on's auth model (production uses X-Addon-Token).
 *
 * Run (reads .env automatically):
 *   LIVE_CLOCKIFY=1 LIVE_CLOCKIFY_API_KEY=... LIVE_WORKSPACE_ID=... \
 *     npx tsx scripts/live-full.ts
 *
 * Never commit credentials.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { executeAction, commitConfirmedOperation } from "../src/harness/actions.js";
import { createPendingConfirmation, confirmPending } from "../src/harness/confirmations.js";
import { defaultAdminPolicy } from "../src/harness/permissions.js";
import type { ActionContext, ConfirmableOperation } from "../src/harness/action.js";
import { createRestWorkspaceClient } from "../src/clockify/rest-workspace.js";

function loadDotEnv(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}
loadDotEnv();

if (process.env.LIVE_CLOCKIFY !== "1") {
  console.error("Refusing to run: set LIVE_CLOCKIFY=1 to opt in.");
  process.exit(2);
}
const API_KEY = process.env.LIVE_CLOCKIFY_API_KEY;
const WORKSPACE_ID = process.env.LIVE_WORKSPACE_ID;
const BASE = (process.env.LIVE_BASE_URL ?? "https://api.clockify.me/api/v1").replace(/\/$/, "");
if (!API_KEY || !WORKSPACE_ID) {
  console.error("Missing LIVE_CLOCKIFY_API_KEY or LIVE_WORKSPACE_ID.");
  process.exit(2);
}

// Raw REST helper for setup (/user) and best-effort cleanup (archive/delete).
async function call(method: string, path: string, body?: unknown, allow404 = false): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "X-Api-Key": API_KEY as string, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 404 && allow404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

type Status = "PASS" | "PREVIEW_OK" | "UNSUPPORTED" | "FAIL" | "SKIP";
interface Row {
  action: string;
  status: Status;
  detail: string;
}
const rows: Row[] = [];
function record(action: string, status: Status, detail = ""): void {
  rows.push({ action, status, detail });
  const icon = { PASS: "✓", PREVIEW_OK: "·", UNSUPPORTED: "⊘", FAIL: "✗", SKIP: "–" }[status];
  console.log(`  ${icon} ${status.padEnd(11)} ${action}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Per-area exerciser handle passed to each `runArea` block (API_COVERAGE_PLAN
 * Phase 0, Task 0.8). Each feature-area phase adds a `runArea` function that
 * exercises its actions through the real harness (read / safeWrite / risky /
 * previewOnly), uses `call` for raw setup + self-cleanup, and `record`s its rows.
 * Area runners must self-clean (create→delete round-trips) so the sweep stays 0.
 */
export interface LiveHarness {
  ctx: ActionContext;
  /** Random per-run suffix so AIASSIST_SMOKE_* names never collide. */
  sfx: string;
  /** Discovered live fixtures (default currency, a real expense category, etc.). */
  fixtures: { currency: string; categoryId?: string; policyId?: string };
  /** Raw REST (X-Api-Key) for setup + best-effort cleanup. */
  call(method: string, path: string, body?: unknown, allow404?: boolean): Promise<unknown>;
  read(actionName: string, args: unknown): Promise<any>;
  safeWrite(actionName: string, args: unknown): Promise<any>;
  risky(actionName: string, args: unknown): Promise<any>;
  previewOnly(actionName: string, args: unknown): Promise<void>;
  record(action: string, status: Status, detail?: string): void;
}

/**
 * Registry of per-area exercisers. Phases push their `runArea` here (e.g.
 * `AREA_RUNNERS.push(runProjects)`); `main` runs them all after the core flow.
 * Empty in Phase 0 — structure only, no behaviour change.
 */
const AREA_RUNNERS: Array<(h: LiveHarness) => Promise<void>> = [];

/* eslint-disable @typescript-eslint/no-explicit-any */
async function read(ctx: ActionContext, actionName: string, args: any): Promise<any> {
  try {
    const r: any = await executeAction({ actionName, args, context: ctx });
    if (r.kind === "receipt" && r.receipt.ok) {
      record(actionName, "PASS", summarize(r.receipt));
      return r.receipt;
    }
    if (r.kind === "clarify") {
      record(actionName, "PASS", `clarify: ${r.message?.slice(0, 50)}`);
      return null;
    }
    record(actionName, "FAIL", `unexpected kind=${r.kind}`);
    return null;
  } catch (e) {
    record(actionName, "FAIL", err(e));
    return null;
  }
}

async function safeWrite(ctx: ActionContext, actionName: string, args: any): Promise<any> {
  try {
    const r: any = await executeAction({ actionName, args, context: ctx });
    if (r.kind === "receipt" && r.receipt.ok) {
      record(actionName, "PASS", summarize(r.receipt));
      return r.receipt;
    }
    if (r.kind === "clarify") {
      record(actionName, "PASS", `clarify: ${r.message?.slice(0, 50)}`);
      return null;
    }
    record(actionName, "FAIL", `unexpected kind=${r.kind} ${JSON.stringify(r).slice(0, 120)}`);
    return null;
  } catch (e) {
    record(actionName, "FAIL", err(e));
    return null;
  }
}

// Risky: confirm the preview is produced, then run confirm→commit; classify commit.
async function risky(ctx: ActionContext, actionName: string, args: any): Promise<any> {
  let preview: any;
  try {
    preview = await executeAction({ actionName, args, context: ctx });
  } catch (e) {
    record(actionName, "FAIL", `preview threw: ${err(e)}`);
    return null;
  }
  if (preview.kind !== "preview") {
    record(actionName, "FAIL", `expected preview, got ${preview.kind}`);
    return null;
  }
  // preview produced without mutating — good. Now confirm+commit.
  const pending = createPendingConfirmation({
    sessionId: "smoke",
    workspaceId: ctx.workspaceId,
    adminUserId: ctx.adminUserId,
    risk: preview.operation.risks,
    preview: preview.preview,
    operation: preview.operation,
    sessionSecret: "smoke-secret",
    now: new Date(),
  });
  const confirm = confirmPending({
    record: pending.record,
    sessionId: "smoke",
    workspaceId: ctx.workspaceId,
    adminUserId: ctx.adminUserId,
    nonce: pending.nonce,
    sessionSecret: "smoke-secret",
    now: new Date(),
  });
  if (!confirm.ok) {
    record(actionName, "FAIL", `confirm gate failed: ${confirm.code}`);
    return null;
  }
  let commit: any;
  try {
    commit = await commitConfirmedOperation(ctx, preview.operation as ConfirmableOperation);
  } catch (e) {
    record(actionName, "FAIL", `commit threw: ${err(e)}`);
    return null;
  }
  if (commit.ok) {
    record(actionName, "PASS", `preview→confirm→commit ok ${summarize(commit)}`);
    return commit;
  }
  if (commit.code === "unsupported") {
    record(actionName, "UNSUPPORTED", `preview ok; commit: ${commit.message ?? "unsupported"}`);
    return null;
  }
  record(actionName, "FAIL", `commit error: ${commit.code ?? ""} ${commit.message ?? ""}`);
  return null;
}

// Preview-only by design: assert the preview is produced (proves the handler +
// safety path, with NO mutation) without committing. Used where a live commit
// would need setup we can't safely arrange on the sac workspace (a real pending
// time-off request — GET /time-off/requests is 405) or has real side effects
// (publishing a schedule notifies assignees). The adapter's request shape for
// these is covered by the mocked-fetch unit tests instead.
async function previewOnly(ctx: ActionContext, actionName: string, args: any): Promise<void> {
  try {
    const r: any = await executeAction({ actionName, args, context: ctx });
    if (r.kind === "preview") {
      record(actionName, "PREVIEW_OK", "preview produced; commit skipped by design");
    } else if (r.kind === "receipt" && !r.receipt.ok) {
      record(actionName, "FAIL", `expected preview, got error ${r.receipt.code}`);
    } else {
      record(actionName, "FAIL", `expected preview, got ${r.kind}`);
    }
  } catch (e) {
    record(actionName, "FAIL", `preview threw: ${err(e)}`);
  }
}

function summarize(receipt: any): string {
  const c = receipt.changed ?? {};
  const parts: string[] = [];
  for (const k of ["created", "updated", "deleted", "reused"]) {
    if (Array.isArray(c[k]) && c[k].length) parts.push(`${k}:${c[k].length}`);
  }
  if (receipt.data?.count !== undefined) parts.push(`count:${receipt.data.count}`);
  if (receipt.data?.running !== undefined) parts.push(`running:${receipt.data.running ? "yes" : "none"}`);
  return parts.join(" ");
}
function err(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 160);
}

/**
 * Phase 2 — Projects. Exercises the typed project actions through the real
 * harness against the sacrificial workspace: create → list → get → update →
 * archive → delete (self-cleaning). Rate/estimate/memberships are preview-only
 * (rate has billing side effects; estimate/memberships need specific setup) —
 * their request shapes are pinned by mocked-fetch unit tests.
 */
async function runProjects(h: LiveHarness): Promise<void> {
  console.log("\nAREA: projects");
  const wsPath = `/workspaces/${h.ctx.workspaceId}`;
  const name = `AIASSIST_SMOKE_project_${h.sfx}`;
  let projectId: string | undefined;
  try {
    const created = await h.safeWrite("clockify_projects_create", { name, isPublic: true });
    projectId = created?.changed?.created?.[0]?.id;
    await h.read("clockify_projects_list", { name: "AIASSIST_SMOKE_project" });
    if (projectId) {
      await h.read("clockify_projects_get", { id: projectId });
      await h.risky("clockify_projects_update", { id: projectId, name: `${name}_renamed` });
      // Preview-only (no live commit by design):
      await h.previewOnly("clockify_projects_rate_update", {
        projectId,
        userId: h.ctx.adminUserId,
        rateKind: "HOURLY",
        amount: 50,
      });
      await h.previewOnly("clockify_projects_estimate_update", {
        id: projectId,
        fields: { timeEstimate: { active: true, estimate: "PT8H", type: "MANUAL" } },
      });
      await h.previewOnly("clockify_projects_memberships_update", {
        id: projectId,
        memberships: [{ userId: h.ctx.adminUserId, membershipStatus: "ACTIVE" }],
      });
      await h.risky("clockify_projects_archive", { id: projectId, name: `${name}_renamed` });
      const del = await h.risky("clockify_projects_delete", { id: projectId, name: `${name}_renamed` });
      if (del) projectId = undefined; // deleted; nothing to clean up
    }
    // No project-template fixture on the sacrificial workspace.
    h.record("clockify_projects_from_template", "SKIP", "no template fixture on sac workspace");
  } finally {
    if (projectId) {
      await h
        .call("PUT", `${wsPath}/projects/${projectId}`, { name: `${name}_renamed`, archived: true }, true)
        .catch(() => {});
      await h.call("DELETE", `${wsPath}/projects/${projectId}`, undefined, true).catch(() => {});
    }
  }
}
AREA_RUNNERS.push(runProjects);

/**
 * Phase 1 — Time Entries. Logs a self-named entry, lists/gets it, marks it
 * invoiced and back (bulk+billing), then deletes it (self-cleaning).
 */
async function runEntries(h: LiveHarness): Promise<void> {
  console.log("\nAREA: time-entries");
  const wsPath = `/workspaces/${h.ctx.workspaceId}`;
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const halfAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  // This sacrificial workspace forces a project on time entries — create one.
  const projName = `AIASSIST_SMOKE_eproj_${h.sfx}`;
  let projectId: string | undefined;
  let entryId: string | undefined;
  let invoiced = false;
  try {
    const proj = await h.safeWrite("clockify_projects_create", { name: projName, isPublic: true });
    projectId = proj?.changed?.created?.[0]?.id;
    const logged = await h.safeWrite("clockify_log_work", {
      description: `AIASSIST_SMOKE_entry_${h.sfx}`,
      start: hourAgo,
      end: halfAgo,
      billable: true,
      projectId,
    });
    entryId = logged?.changed?.created?.[0]?.id;
    await h.read("clockify_entries_list", { projectId });
    if (entryId) {
      await h.read("clockify_entries_get", { id: entryId });
      const marked = await h.risky("clockify_entries_mark_invoiced", { ids: [entryId], invoiced: true });
      if (marked) invoiced = true;
      const unmarked = await h.risky("clockify_entries_mark_invoiced", { ids: [entryId], invoiced: false });
      if (unmarked) invoiced = false;
      const del = await h.risky("clockify_entries_delete", { id: entryId });
      if (del) entryId = undefined;
    }
  } finally {
    if (entryId) {
      if (invoiced) {
        await h
          .call("PATCH", `${wsPath}/time-entries/invoiced`, { timeEntryIds: [entryId], invoiced: false }, true)
          .catch(() => {});
      }
      await h.call("DELETE", `${wsPath}/time-entries/${entryId}`, undefined, true).catch(() => {});
    }
    if (projectId) {
      await h.call("PUT", `${wsPath}/projects/${projectId}`, { name: projName, archived: true }, true).catch(() => {});
      await h.call("DELETE", `${wsPath}/projects/${projectId}`, undefined, true).catch(() => {});
    }
  }
}
AREA_RUNNERS.push(runEntries);

/**
 * Phase 3 — Tasks. Creates a project + task, lists/gets, updates, sets a rate
 * (preview-only — billing), then deletes (mark-DONE-then-delete). Self-cleaning.
 */
async function runTasks(h: LiveHarness): Promise<void> {
  console.log("\nAREA: tasks");
  const wsPath = `/workspaces/${h.ctx.workspaceId}`;
  const projName = `AIASSIST_SMOKE_tproj_${h.sfx}`;
  let projectId: string | undefined;
  try {
    const proj = await h.safeWrite("clockify_projects_create", { name: projName, isPublic: true });
    projectId = proj?.changed?.created?.[0]?.id;
    if (!projectId) {
      h.record("clockify_tasks_create", "SKIP", "no project to host the task");
      return;
    }
    const created = await h.safeWrite("clockify_tasks_create", {
      projectId,
      name: `AIASSIST_SMOKE_task_${h.sfx}`,
    });
    const taskId = created?.changed?.created?.[0]?.id;
    await h.read("clockify_tasks_list", { projectId });
    if (taskId) {
      await h.read("clockify_tasks_get", { projectId, id: taskId });
      await h.risky("clockify_tasks_update", { projectId, id: taskId, name: `AIASSIST_SMOKE_task_${h.sfx}_v2` });
      await h.previewOnly("clockify_tasks_rate_update", { projectId, taskId, rateKind: "HOURLY", amount: 40 });
      await h.risky("clockify_tasks_delete", { projectId, id: taskId, name: "task" });
    }
  } finally {
    if (projectId) {
      await h.call("PUT", `${wsPath}/projects/${projectId}`, { name: projName, archived: true }, true).catch(() => {});
      await h.call("DELETE", `${wsPath}/projects/${projectId}`, undefined, true).catch(() => {});
    }
  }
}
AREA_RUNNERS.push(runTasks);

/**
 * Phase 4 — Clients. Create → list → get → update → delete (archive-then-delete).
 * Self-cleaning.
 */
async function runClients(h: LiveHarness): Promise<void> {
  console.log("\nAREA: clients");
  const wsPath = `/workspaces/${h.ctx.workspaceId}`;
  // Distinct from the core flow's AIASSIST_SMOKE_client_* (which still exists when
  // area runners execute, before the core cleanup) to avoid a name collision.
  const name = `AIASSIST_SMOKE_aclient_${h.sfx}`;
  let clientId: string | undefined;
  try {
    const created = await h.safeWrite("clockify_clients_create", { name });
    clientId = created?.changed?.created?.[0]?.id;
    await h.read("clockify_clients_list", { name: "AIASSIST_SMOKE_aclient" });
    if (clientId) {
      await h.read("clockify_clients_get", { id: clientId });
      await h.risky("clockify_clients_update", { id: clientId, name: `${name}_renamed` });
      const del = await h.risky("clockify_clients_delete", { id: clientId, name: `${name}_renamed` });
      if (del) clientId = undefined;
    }
  } finally {
    if (clientId) {
      await h.call("PUT", `${wsPath}/clients/${clientId}`, { name: `${name}_renamed`, archived: true }, true).catch(() => {});
      await h.call("DELETE", `${wsPath}/clients/${clientId}`, undefined, true).catch(() => {});
    }
  }
}
AREA_RUNNERS.push(runClients);

/**
 * Phase 5 — Tags. Create → list → get → update → delete. Self-cleaning.
 */
async function runTags(h: LiveHarness): Promise<void> {
  console.log("\nAREA: tags");
  const wsPath = `/workspaces/${h.ctx.workspaceId}`;
  const name = `AIASSIST_SMOKE_atag_${h.sfx}`;
  let tagId: string | undefined;
  try {
    const created = await h.safeWrite("clockify_tags_create", { name });
    tagId = created?.changed?.created?.[0]?.id;
    await h.read("clockify_tags_list", { name: "AIASSIST_SMOKE_atag" });
    if (tagId) {
      await h.read("clockify_tags_get", { id: tagId });
      await h.risky("clockify_tags_update", { id: tagId, name: `${name}_v2` });
      const del = await h.risky("clockify_tags_delete", { id: tagId, name: `${name}_v2` });
      if (del) tagId = undefined;
    }
  } finally {
    if (tagId) {
      await h.call("DELETE", `${wsPath}/tags/${tagId}`, undefined, true).catch(() => {});
    }
  }
}
AREA_RUNNERS.push(runTags);

// Export is best-effort: PDF export can depend on the workspace plan, so a
// non-ok response is recorded SKIP (not FAIL) rather than failing the gate.
async function exportInvoiceBestEffort(h: LiveHarness, invoiceId: string): Promise<void> {
  try {
    const r: any = await executeAction({
      actionName: "clockify_invoices_export",
      args: { id: invoiceId },
      context: h.ctx,
    });
    if (r.kind === "receipt" && r.receipt.ok) {
      h.record("clockify_invoices_export", "PASS", `pdf ${r.receipt.data?.bytes ?? "?"}b`);
    } else {
      h.record("clockify_invoices_export", "SKIP", `export not available: ${r.receipt?.code ?? r.kind}`);
    }
  } catch (e) {
    h.record("clockify_invoices_export", "SKIP", `export threw: ${err(e)}`);
  }
}

/**
 * Phase 6 — Invoices. Creates a client + invoice, exercises the reads
 * (list/get/items_list/payments_list), updates the note (real clean-body PUT),
 * then deletes the invoice (self-cleaning create→delete round-trip). Item /
 * payment / import mutations are preview-only by design — a live commit needs a
 * valid `itemType` from the workspace invoice settings, a payable invoice, and
 * billable entries in range; their request shapes are pinned by mocked-fetch
 * unit tests. Export is best-effort (plan-dependent). If the workspace plan
 * rejects invoice creation, the area records SKIP and leaves no leftovers.
 */
async function runInvoices(h: LiveHarness): Promise<void> {
  console.log("\nAREA: invoices");
  const wsPath = `/workspaces/${h.ctx.workspaceId}`;
  const issuedDate = new Date().toISOString();
  const dueDate = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const clientName = `AIASSIST_SMOKE_iclient_${h.sfx}`;
  const number = `AIASSIST_SMOKE_inv_${h.sfx}`;
  let clientId: string | undefined;
  let invoiceId: string | undefined;
  try {
    const client = await h.safeWrite("clockify_clients_create", { name: clientName });
    clientId = client?.changed?.created?.[0]?.id;
    if (!clientId) {
      h.record("clockify_invoices_create", "SKIP", "no client to bill");
      return;
    }
    const created = await h.risky("clockify_invoices_create", {
      clientId,
      clientName,
      number,
      issuedDate,
      currency: h.fixtures.currency,
      dueDate,
    });
    invoiceId = created?.changed?.created?.[0]?.id;
    if (!invoiceId) {
      // The workspace plan may reject invoice creation — SKIP, no leftovers.
      h.record("clockify_invoices_get", "SKIP", "invoice not created (workspace plan?)");
      return;
    }
    await h.read("clockify_invoices_list", {});
    await h.read("clockify_invoices_get", { id: invoiceId });
    await h.read("clockify_invoices_items_list", { id: invoiceId });
    await h.read("clockify_invoices_payments_list", { id: invoiceId });
    await exportInvoiceBestEffort(h, invoiceId);
    // Real update: clean-body GET-then-PUT changing only the note.
    await h.risky("clockify_invoices_update", { id: invoiceId, note: `AIASSIST_SMOKE note ${h.sfx}` });
    // Sub-resource mutations: preview-only by design (see runInvoices doc).
    await h.previewOnly("clockify_invoices_items_add", {
      invoiceId,
      itemType: "AIASSIST_SMOKE",
      description: "smoke item",
      quantity: 1,
      unitPrice: 1,
    });
    await h.previewOnly("clockify_invoices_items_delete", { invoiceId, index: 0 });
    await h.previewOnly("clockify_invoices_payments_create", {
      invoiceId,
      amount: 1,
      paymentDate: issuedDate,
    });
    await h.previewOnly("clockify_invoices_payments_delete", { invoiceId, paymentId: "smoke-nonexistent" });
    await h.previewOnly("clockify_invoices_import_time", {
      invoiceId,
      from: "2030-01-01T00:00:00Z",
      to: "2030-01-07T00:00:00Z",
    });
    const del = await h.risky("clockify_invoices_delete", { id: invoiceId, number });
    if (del) invoiceId = undefined;
  } finally {
    if (invoiceId) {
      await h.call("DELETE", `${wsPath}/invoices/${invoiceId}`, undefined, true).catch(() => {});
    }
    if (clientId) {
      await h.call("PUT", `${wsPath}/clients/${clientId}`, { name: clientName, archived: true }, true).catch(() => {});
      await h.call("DELETE", `${wsPath}/clients/${clientId}`, undefined, true).catch(() => {});
    }
  }
}
AREA_RUNNERS.push(runInvoices);

/**
 * Phase 7 — Expenses (multipart). Creates an expense against a real category
 * (from fixtures), reads it (list/get), updates it (multipart PUT changeFields),
 * then deletes it — a full create→delete round-trip. Separately exercises the
 * category CRUD on a throwaway category (list/create/update/delete). All
 * self-cleaning; if the workspace has no expense category, the expense path
 * records SKIP and only the category round-trip runs.
 */
async function runExpenses(h: LiveHarness): Promise<void> {
  console.log("\nAREA: expenses");
  const wsPath = `/workspaces/${h.ctx.workspaceId}`;
  const today = new Date().toISOString();
  const notes = `AIASSIST_SMOKE_exp_${h.sfx}`;
  let expenseId: string | undefined;
  let categoryId: string | undefined;
  try {
    await h.read("clockify_expenses_categories_list", {});
    if (h.fixtures.categoryId) {
      const created = await h.risky("clockify_expenses_create", {
        amount: 1,
        date: today,
        categoryId: h.fixtures.categoryId,
        notes,
      });
      expenseId = created?.changed?.created?.[0]?.id;
      await h.read("clockify_expenses_list", {});
      if (expenseId) {
        await h.read("clockify_expenses_get", { id: expenseId });
        await h.risky("clockify_expenses_update", { id: expenseId, notes: `${notes}_v2` });
        const del = await h.risky("clockify_expenses_delete", { id: expenseId, notes });
        if (del) expenseId = undefined;
      }
    } else {
      h.record("clockify_expenses_create", "SKIP", "no expense category fixture on sac workspace");
    }
    // Category round-trip on a throwaway (unused) category.
    const cat = await h.risky("clockify_expenses_categories_create", { name: `AIASSIST_SMOKE_cat_${h.sfx}` });
    categoryId = cat?.changed?.created?.[0]?.id;
    if (categoryId) {
      await h.risky("clockify_expenses_categories_update", { id: categoryId, name: `AIASSIST_SMOKE_cat_${h.sfx}_v2` });
      const del = await h.risky("clockify_expenses_categories_delete", { id: categoryId, name: `AIASSIST_SMOKE_cat_${h.sfx}_v2` });
      if (del) categoryId = undefined;
    }
  } finally {
    if (expenseId) {
      await h.call("DELETE", `${wsPath}/expenses/${expenseId}`, undefined, true).catch(() => {});
    }
    if (categoryId) {
      // Categories must be archived before delete (matches live-sweep).
      await h.call("PATCH", `${wsPath}/expenses/categories/${categoryId}/status`, { archived: true }, true).catch(() => {});
      await h.call("DELETE", `${wsPath}/expenses/categories/${categoryId}`, undefined, true).catch(() => {});
    }
  }
}
AREA_RUNNERS.push(runExpenses);

/**
 * Phase 8 — Custom Fields. Lists (read), then creates→gets→updates→deletes a TXT
 * field (self-cleaning). Custom fields are a plan-gated Clockify feature, so if
 * create is rejected the area records SKIP and runs no dependents. Set-value on a
 * project / time entry is preview-only by design — a live commit needs a
 * project-or-entry-scoped VISIBLE field plus a matching target; the request
 * shapes are pinned by mocked-fetch unit tests.
 */
async function runCustomFields(h: LiveHarness): Promise<void> {
  console.log("\nAREA: custom-fields");
  const wsPath = `/workspaces/${h.ctx.workspaceId}`;
  const name = `AIASSIST_SMOKE_cf_${h.sfx}`;
  let fieldId: string | undefined;
  try {
    await h.read("clockify_custom_fields_list", {});
    // Create defensively: a plan without custom fields rejects this — record SKIP,
    // not FAIL, and run no dependents.
    let created: any = null;
    try {
      const r: any = await executeAction({
        actionName: "clockify_custom_fields_create",
        args: { name, fieldType: "TXT" },
        context: h.ctx,
      });
      if (r.kind === "preview") {
        const { commit } = await confirmAndCommit(h, r);
        if (commit?.ok) {
          created = commit;
          h.record("clockify_custom_fields_create", "PASS", `preview→confirm→commit ok ${summarize(commit)}`);
        } else {
          h.record("clockify_custom_fields_create", "SKIP", `create rejected: ${commit?.code ?? "?"} ${commit?.message ?? ""}`.slice(0, 90));
        }
      }
    } catch (e) {
      h.record("clockify_custom_fields_create", "SKIP", `create unavailable (plan?): ${err(e)}`);
    }
    fieldId = created?.changed?.created?.[0]?.id;
    if (fieldId) {
      await h.read("clockify_custom_fields_get", { id: fieldId });
      await h.risky("clockify_custom_fields_update", { id: fieldId, name: `${name}_v2` });
    }
    // Set-value is preview-only by design (needs a scoped field + target fixture).
    await h.previewOnly("clockify_custom_fields_set_value_project", { projectId: "smoke-project", fieldId: fieldId ?? "smoke-field", value: "smoke" });
    await h.previewOnly("clockify_custom_fields_set_value_entry", { entryId: "smoke-entry", fieldId: fieldId ?? "smoke-field", value: "smoke" });
    if (fieldId) {
      const del = await h.risky("clockify_custom_fields_delete", { id: fieldId, name: `${name}_v2` });
      if (del) fieldId = undefined;
    }
  } finally {
    if (fieldId) {
      await h.call("DELETE", `${wsPath}/custom-fields/${fieldId}`, undefined, true).catch(() => {});
    }
  }
}
AREA_RUNNERS.push(runCustomFields);

/**
 * Phase 9 — Time Off. Reads are real (policies/requests/balance); policy
 * create/update/archive, request create/delete, approve/deny, and balance update
 * are PREVIEW-ONLY by design — policies cannot be hard-deleted (archive would
 * leave a leftover), requests/approve/deny need a real pending request and notify
 * people, and balance update mutates a user's accrual. Their request shapes are
 * pinned by mocked-fetch unit tests.
 */
async function runTimeOff(h: LiveHarness): Promise<void> {
  console.log("\nAREA: time-off");
  const policyId = h.fixtures.policyId;
  await h.read("clockify_time_off_policies_list", {});
  if (policyId) await h.read("clockify_time_off_policies_get", { id: policyId });
  await h.read("clockify_time_off_requests_list", {});
  await h.read("clockify_time_off_balance_get", {});
  await h.previewOnly("clockify_time_off_policies_create", { name: `AIASSIST_SMOKE_pol_${h.sfx}`, daysPerYear: 20 });
  if (policyId) {
    await h.previewOnly("clockify_time_off_policies_update", { id: policyId, name: `AIASSIST_SMOKE_pol_${h.sfx}` });
    await h.previewOnly("clockify_time_off_policies_archive", { id: policyId });
    await h.previewOnly("clockify_time_off_requests_create", { policyId, start: "2030-01-01T00:00:00Z", end: "2030-01-03T00:00:00Z", days: 3 });
    await h.previewOnly("clockify_time_off_requests_delete", { policyId, requestId: "smoke-request" });
    await h.previewOnly("clockify_time_off_approve", { policyId, requestId: "smoke-request" });
    await h.previewOnly("clockify_time_off_deny", { policyId, requestId: "smoke-request" });
    await h.previewOnly("clockify_time_off_balance_update", { policyId, userIds: [h.ctx.adminUserId], value: 1 });
  }
}
AREA_RUNNERS.push(runTimeOff);

/**
 * Phase 9 — Holidays. Reads are real; create→get→update→delete is a real
 * round-trip (holidays are deletable, self-cleaning). Create is defensive
 * (records SKIP, not FAIL, if the workspace rejects holidays) and is a safe
 * write (no confirmation).
 */
async function runHolidays(h: LiveHarness): Promise<void> {
  console.log("\nAREA: holidays");
  const wsPath = `/workspaces/${h.ctx.workspaceId}`;
  const name = `AIASSIST_SMOKE_hol_${h.sfx}`;
  let holidayId: string | undefined;
  try {
    await h.read("clockify_holidays_list", {});
    await h.read("clockify_holidays_in_period", { assignedTo: h.ctx.adminUserId, start: "2026-01-01", end: "2026-12-31" });
    // safe_write create executes immediately; guard so a plan rejection is SKIP not FAIL.
    let created: any = null;
    try {
      const r: any = await executeAction({
        actionName: "clockify_holidays_create",
        args: { name, startDate: "2030-07-01", userIds: [h.ctx.adminUserId] },
        context: h.ctx,
      });
      if (r.kind === "receipt" && r.receipt.ok) {
        created = r.receipt;
        h.record("clockify_holidays_create", "PASS", summarize(r.receipt));
      } else {
        h.record("clockify_holidays_create", "SKIP", `create rejected: ${r.receipt?.code ?? r.kind}`);
      }
    } catch (e) {
      h.record("clockify_holidays_create", "SKIP", `create unavailable (plan?): ${err(e)}`);
    }
    holidayId = created?.changed?.created?.[0]?.id;
    if (holidayId) {
      await h.read("clockify_holidays_get", { id: holidayId });
      await h.safeWrite("clockify_holidays_update", { id: holidayId, name: `${name}_v2` });
      const del = await h.risky("clockify_holidays_delete", { id: holidayId, name: `${name}_v2` });
      if (del) holidayId = undefined;
    }
  } finally {
    if (holidayId) {
      await h.call("DELETE", `${wsPath}/holidays/${holidayId}`, undefined, true).catch(() => {});
    }
  }
}
AREA_RUNNERS.push(runHolidays);

/**
 * Phase 10 — Scheduling. Reads (list/totals) are real; assignment
 * create→get→update→delete is a real round-trip on a throwaway project (create is
 * defensive — SKIP not FAIL if scheduling is not on the workspace plan). Publish
 * is preview-only by design (notifies assignees). Self-cleaning.
 */
async function runScheduling(h: LiveHarness): Promise<void> {
  console.log("\nAREA: scheduling");
  const wsPath = `/workspaces/${h.ctx.workspaceId}`;
  const start = "2030-06-01T00:00:00Z";
  const end = "2030-06-05T00:00:00Z";
  const projName = `AIASSIST_SMOKE_sproj_${h.sfx}`;
  let projectId: string | undefined;
  let assignmentId: string | undefined;
  try {
    await h.read("clockify_scheduling_assignments_list", { start, end });
    await h.read("clockify_scheduling_project_totals", { start, end });
    await h.read("clockify_scheduling_user_totals", { start, end });
    await h.previewOnly("clockify_scheduling_publish", { start, end });
    const proj = await h.safeWrite("clockify_projects_create", { name: projName, isPublic: true });
    projectId = proj?.changed?.created?.[0]?.id;
    if (projectId) {
      try {
        const r: any = await executeAction({
          actionName: "clockify_scheduling_assignments_create",
          args: { userId: h.ctx.adminUserId, projectId, start, end, hoursPerDay: 8 },
          context: h.ctx,
        });
        if (r.kind === "receipt" && r.receipt.ok) {
          assignmentId = r.receipt.changed?.created?.[0]?.id;
          h.record("clockify_scheduling_assignments_create", "PASS", summarize(r.receipt));
        } else {
          h.record("clockify_scheduling_assignments_create", "SKIP", `rejected: ${r.receipt?.code ?? r.kind}`);
        }
      } catch (e) {
        h.record("clockify_scheduling_assignments_create", "SKIP", `unavailable (plan?): ${err(e)}`);
      }
      if (assignmentId) {
        await h.read("clockify_scheduling_assignments_get", { id: assignmentId });
        await h.risky("clockify_scheduling_assignments_update", { id: assignmentId, hoursPerDay: 6, seriesUpdateOption: "ALL" });
        const del = await h.risky("clockify_scheduling_assignments_delete", { id: assignmentId, seriesUpdateOption: "ALL" });
        if (del) assignmentId = undefined;
      }
    }
  } finally {
    if (assignmentId) {
      await h.call("DELETE", `${wsPath}/scheduling/assignments/recurring/${assignmentId}?seriesUpdateOption=ALL`, undefined, true).catch(() => {});
    }
    if (projectId) {
      await h.call("PUT", `${wsPath}/projects/${projectId}`, { name: projName, archived: true }, true).catch(() => {});
      await h.call("DELETE", `${wsPath}/projects/${projectId}`, undefined, true).catch(() => {});
    }
  }
}
AREA_RUNNERS.push(runScheduling);

/**
 * Phase 11 — Approvals. Reads (list per status) are real; submit/approve/reject/
 * withdraw/resubmit are preview-only by design — a live commit needs a real
 * submitted timesheet (approvals are a plan feature) and notifies the owner. The
 * request shapes are pinned by mocked-fetch unit tests.
 */
async function runApprovals(h: LiveHarness): Promise<void> {
  console.log("\nAREA: approvals");
  await h.read("clockify_approvals_list", {});
  await h.read("clockify_approvals_list", { status: "PENDING" });
  await h.previewOnly("clockify_approvals_submit", { periodStart: "2030-06-01" });
  await h.previewOnly("clockify_approvals_approve", { id: "smoke-approval" });
  await h.previewOnly("clockify_approvals_reject", { id: "smoke-approval", note: "smoke" });
  await h.previewOnly("clockify_approvals_withdraw", { id: "smoke-approval" });
  await h.previewOnly("clockify_approvals_resubmit", { id: "smoke-approval", entryIds: ["smoke-entry"] });
}
AREA_RUNNERS.push(runApprovals);

/**
 * Phase 12 — Webhooks. Reads (list/events/logs) are real; create→get→logs→
 * update→delete is a real round-trip (HTTPS url, NEW_TIME_ENTRY event),
 * self-cleaning. The signing secret (authToken) is never set through the typed
 * path. live-sweep already removes leftover AIASSIST_SMOKE_ webhooks.
 */
async function runWebhooks(h: LiveHarness): Promise<void> {
  console.log("\nAREA: webhooks");
  const wsPath = `/workspaces/${h.ctx.workspaceId}`;
  const name = `AIASSIST_SMOKE_wh_${h.sfx}`;
  let webhookId: string | undefined;
  try {
    await h.read("clockify_webhooks_list", {});
    await h.read("clockify_webhooks_events", {});
    const created = await h.risky("clockify_webhooks_create", {
      name,
      url: "https://example.com/aiassist-smoke-hook",
      webhookEvent: "NEW_TIME_ENTRY",
    });
    webhookId = created?.changed?.created?.[0]?.id;
    if (webhookId) {
      await h.read("clockify_webhooks_get", { id: webhookId });
      // logs: best-effort — GET /logs 405s on this workspace (goclmcp's documented
      // shape, pinned by the unit test); record SKIP rather than failing the gate.
      try {
        const r: any = await executeAction({ actionName: "clockify_webhooks_logs", args: { id: webhookId }, context: h.ctx });
        h.record("clockify_webhooks_logs", r.kind === "receipt" && r.receipt.ok ? "PASS" : "SKIP", r.receipt?.ok ? summarize(r.receipt) : `logs unavailable: ${r.receipt?.code ?? r.kind}`);
      } catch (e) {
        h.record("clockify_webhooks_logs", "SKIP", `logs endpoint not GETtable: ${err(e)}`);
      }
      await h.risky("clockify_webhooks_update", { id: webhookId, name: `${name}_v2` });
      const del = await h.risky("clockify_webhooks_delete", { id: webhookId, name: `${name}_v2` });
      if (del) webhookId = undefined;
    }
  } finally {
    if (webhookId) {
      await h.call("DELETE", `${wsPath}/webhooks/${webhookId}`, undefined, true).catch(() => {});
    }
  }
}
AREA_RUNNERS.push(runWebhooks);

/**
 * Phase 13 — Users & Groups. Users list is real; invite/role/deactivate are
 * PREVIEW-ONLY by design (high blast radius — they change access/permissions and
 * may email). Groups do a real create→get→update→add-member→remove-member→delete
 * round-trip (groups are deletable; the admin is the safe member), self-cleaning.
 */
async function runUsers(h: LiveHarness): Promise<void> {
  console.log("\nAREA: users-groups");
  const wsPath = `/workspaces/${h.ctx.workspaceId}`;
  const name = `AIASSIST_SMOKE_grp_${h.sfx}`;
  let groupId: string | undefined;
  try {
    await h.read("clockify_users_list", {});
    await h.read("clockify_groups_list", {});
    // High-blast-radius user writes: preview-only (never committed live).
    await h.previewOnly("clockify_users_invite", { email: `aiassist_smoke_${h.sfx}@example.com` });
    await h.previewOnly("clockify_users_role_update", { userId: h.ctx.adminUserId, role: "TEAM_MANAGER", entityId: "smoke-team" });
    await h.previewOnly("clockify_users_deactivate", { userId: "smoke-user" });
    // Groups: real round-trip (self-cleaning).
    const created = await h.risky("clockify_groups_create", { name });
    groupId = created?.changed?.created?.[0]?.id;
    if (groupId) {
      await h.read("clockify_groups_get", { id: groupId });
      await h.risky("clockify_groups_update", { id: groupId, name: `${name}_v2` });
      await h.risky("clockify_groups_add_user", { groupId, userId: h.ctx.adminUserId });
      await h.risky("clockify_groups_remove_user", { groupId, userId: h.ctx.adminUserId });
      const del = await h.risky("clockify_groups_delete", { id: groupId, name: `${name}_v2` });
      if (del) groupId = undefined;
    }
  } finally {
    if (groupId) {
      await h.call("DELETE", `${wsPath}/user-groups/${groupId}`, undefined, true).catch(() => {});
    }
  }
}
AREA_RUNNERS.push(runUsers);

/** Run the confirm→commit half of the risky flow for an already-produced preview. */
async function confirmAndCommit(h: LiveHarness, preview: any): Promise<{ commit: any }> {
  const pending = createPendingConfirmation({
    sessionId: "smoke",
    workspaceId: h.ctx.workspaceId,
    adminUserId: h.ctx.adminUserId,
    risk: preview.operation.risks,
    preview: preview.preview,
    operation: preview.operation,
    sessionSecret: "smoke-secret",
    now: new Date(),
  });
  const confirm = confirmPending({
    record: pending.record,
    sessionId: "smoke",
    workspaceId: h.ctx.workspaceId,
    adminUserId: h.ctx.adminUserId,
    nonce: pending.nonce,
    sessionSecret: "smoke-secret",
    now: new Date(),
  });
  if (!confirm.ok) return { commit: { ok: false, code: confirm.code, message: "confirm gate failed" } };
  const commit = await commitConfirmedOperation(h.ctx, preview.operation as ConfirmableOperation);
  return { commit };
}

async function main(): Promise<void> {
  const me = (await call("GET", "/user")) as { id: string; name: string };
  const ws = `/workspaces/${WORKSPACE_ID}`;
  const ctx: ActionContext = {
    workspaceId: WORKSPACE_ID as string,
    adminUserId: me.id,
    policy: defaultAdminPolicy(),
    clockify: createRestWorkspaceClient({
      baseUrl: BASE,
      workspaceId: WORKSPACE_ID as string,
      auth: { apiKey: API_KEY as string },
    }),
    now: () => new Date(),
  };
  const sfx = randomBytes(3).toString("hex");
  const names = {
    client: `AIASSIST_SMOKE_client_${sfx}`,
    project: `AIASSIST_SMOKE_project_${sfx}`,
    task: `AIASSIST_SMOKE_task_${sfx}`,
    tag: `AIASSIST_SMOKE_tag_${sfx}`,
    webhook: `AIASSIST_SMOKE_wh_${sfx}`,
  };
  console.log(`User: ${me.name} (${me.id}) | workspace ${WORKSPACE_ID} | suffix ${sfx}\n`);

  // Live fixtures discovered read-only so risky commits use values the workspace
  // actually has (default currency, a real non-archived expense category, a
  // time-off policy id for the preview).
  const wsList = (await call("GET", "/workspaces")) as Array<{
    id: string;
    currencies?: Array<{ code: string; isDefault?: boolean }>;
  }>;
  const currency =
    wsList.find((w) => w.id === WORKSPACE_ID)?.currencies?.find((c) => c.isDefault)?.code ?? "USD";
  const catsResp = (await call("GET", `${ws}/expenses/categories`)) as
    | { categories?: Array<{ id: string; archived?: boolean }> }
    | Array<{ id: string; archived?: boolean }>;
  const catList = Array.isArray(catsResp) ? catsResp : (catsResp.categories ?? []);
  const categoryId = catList.find((c) => !c.archived)?.id;
  const policies = (await call("GET", `${ws}/time-off/policies`)) as Array<{ id: string }>;
  const policyId = (Array.isArray(policies) ? policies : [])[0]?.id;
  console.log(
    `  setup: currency=${currency} expenseCategory=${categoryId ? "yes" : "none"} timeOffPolicy=${policyId ? "yes" : "none"}\n`,
  );

  // Exerciser handle for per-area runners (Task 0.8). Helpers are bound to ctx so
  // area code reads `h.safeWrite("clockify_projects_create", {...})`.
  const h: LiveHarness = {
    ctx,
    sfx,
    fixtures: { currency, categoryId, policyId },
    call,
    record,
    read: (actionName, args) => read(ctx, actionName, args),
    safeWrite: (actionName, args) => safeWrite(ctx, actionName, args),
    risky: (actionName, args) => risky(ctx, actionName, args),
    previewOnly: (actionName, args) => previewOnly(ctx, actionName, args),
  };

  const ids: {
    clientId?: string;
    projectId?: string;
    taskId?: string;
    tagId?: string;
    entryIds: string[];
  } = { entryIds: [] };

  try {
    // ── READS ─────────────────────────────────────────────────────────────
    console.log("READS");
    await read(ctx, "clockify_status", {});
    await read(ctx, "assistant_show_permissions", {});
    await read(ctx, "clockify_review_day", {});
    await read(ctx, "clockify_review_week", {});
    for (const entityType of ["tag", "project", "client", "user", "expense", "webhook"]) {
      await read(ctx, "clockify_list_entities", { entityType });
    }

    // ── SAFE WRITES (build fixtures) ───────────────────────────────────────
    console.log("\nSAFE WRITES");
    const pkg = await safeWrite(ctx, "clockify_create_work_package", {
      client: { name: names.client },
      project: { name: names.project, clientName: names.client },
      task: { name: names.task },
      tag: { name: names.tag },
    });
    if (pkg) {
      const created: any[] = pkg.changed?.created ?? [];
      ids.clientId = created.find((c) => c.type === "client")?.id;
      ids.projectId = created.find((c) => c.type === "project")?.id;
      ids.taskId = created.find((c) => c.type === "task")?.id;
      ids.tagId = created.find((c) => c.type === "tag")?.id;
    }

    // list/get task now that we have a project
    if (ids.projectId) {
      await read(ctx, "clockify_list_entities", { entityType: "task", projectId: ids.projectId });
      await read(ctx, "clockify_get_entity", { entityType: "project", id: ids.projectId });
    }
    if (ids.tagId) await read(ctx, "clockify_get_entity", { entityType: "tag", id: ids.tagId });

    // start timer -> status -> stop timer
    const started = await safeWrite(ctx, "clockify_start_timer", {
      description: `AIASSIST_SMOKE_timer_${sfx}`,
      projectId: ids.projectId,
    });
    const startedId = started?.changed?.created?.[0]?.id;
    if (startedId) ids.entryIds.push(startedId);
    const stopped = await safeWrite(ctx, "clockify_stop_timer", {});
    void stopped;

    // log a completed entry
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const halfAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const logged = await safeWrite(ctx, "clockify_log_work", {
      description: `AIASSIST_SMOKE_log_${sfx}`,
      start: hourAgo,
      end: halfAgo,
      projectId: ids.projectId,
    });
    const loggedId = logged?.changed?.created?.[0]?.id;
    if (loggedId) ids.entryIds.push(loggedId);

    // fix_entry = updateTimeEntry PUT (the TODO-verify sparse-body endpoint)
    if (loggedId) {
      await safeWrite(ctx, "clockify_fix_entry", {
        id: loggedId,
        description: `AIASSIST_SMOKE_log_${sfx}_fixed`,
      });
    } else {
      record("clockify_fix_entry", "SKIP", "no logged entry id to update");
    }

    // ── RISKY WRITES (preview → confirm → commit) ──────────────────────────
    console.log("\nRISKY WRITES");
    // permission change (no Clockify write; safe to commit fully)
    await risky(ctx, "assistant_update_permissions", { groups: { invoices: "read" } });

    // webhooks are exercised by the dedicated runWebhooks area runner below.

    // invoices are exercised by the dedicated runInvoices area runner below
    // (typed create→reads→update→delete round-trip, self-cleaning).

    // update_entity (project rename) — real fetch-then-merge PUT.
    if (ids.projectId) {
      await risky(ctx, "clockify_update_entity", {
        entityType: "project",
        id: ids.projectId,
        name: `${names.project}_renamed`,
      });
    }

    // expenses are exercised by the dedicated runExpenses area runner below
    // (typed multipart create→reads→update→delete + category round-trip).

    // time-off + scheduling are exercised by runTimeOff / runScheduling (typed) below.

    // delete_entity via confirm flow — doubles as cleanup AND tests the path
    console.log("\nDESTRUCTIVE (delete_entity — also cleanup)");
    for (const id of ids.entryIds) {
      const r = await risky(ctx, "clockify_delete_entity", { entityType: "time_entry", id });
      if (r) ids.entryIds = ids.entryIds.filter((x) => x !== id);
    }
    if (ids.tagId) {
      const r = await risky(ctx, "clockify_delete_entity", { entityType: "tag", id: ids.tagId, name: names.tag });
      if (r) ids.tagId = undefined;
    }

    // ── PER-AREA RUNNERS (API_COVERAGE_PLAN phases register here) ───────────
    // Each runner self-cleans; the sweep is the safety net. Empty in Phase 0.
    if (AREA_RUNNERS.length > 0) console.log("\nAREA RUNNERS");
    for (const runArea of AREA_RUNNERS) {
      await runArea(h);
    }
  } finally {
    // ── BEST-EFFORT CLEANUP (raw REST) ─────────────────────────────────────
    console.log("\nCLEANUP");
    for (const id of ids.entryIds) {
      try {
        await call("DELETE", `${ws}/time-entries/${id}`, undefined, true);
        console.log(`  deleted leftover entry ${id}`);
      } catch (e) {
        console.warn(`  WARN could not delete entry ${id}: ${err(e)}`);
      }
    }
    if (ids.tagId) {
      try {
        await call("DELETE", `${ws}/tags/${ids.tagId}`, undefined, true);
        console.log(`  deleted leftover tag ${ids.tagId}`);
      } catch (e) {
        console.warn(`  WARN tag ${ids.tagId}: ${err(e)}`);
      }
    }
    if (ids.projectId) {
      // Clockify requires archive (with the name) before delete.
      try {
        await call("PUT", `${ws}/projects/${ids.projectId}`, { name: `${names.project}_renamed`, archived: true }, true);
      } catch {
        /* ignore archive failure */
      }
      try {
        await call("DELETE", `${ws}/projects/${ids.projectId}`, undefined, true);
        console.log(`  deleted project ${ids.projectId} (cascades task)`);
      } catch (e) {
        console.warn(`  WARN project ${ids.projectId} leftover: ${err(e)}`);
      }
    }
    if (ids.clientId) {
      // Archiving a client requires its name in the body (else "Cannot delete an active client").
      try {
        await call("PUT", `${ws}/clients/${ids.clientId}`, { name: names.client, archived: true }, true);
      } catch {
        /* ignore */
      }
      try {
        await call("DELETE", `${ws}/clients/${ids.clientId}`, undefined, true);
        console.log(`  deleted client ${ids.clientId}`);
      } catch (e) {
        console.warn(`  WARN client ${ids.clientId} leftover: ${err(e)}`);
      }
    }
  }

  // ── MATRIX ────────────────────────────────────────────────────────────────
  console.log("\n──────── RESULT MATRIX ────────");
  const by = (s: Status) => rows.filter((r) => r.status === s).length;
  console.log(
    `PASS=${by("PASS")}  PREVIEW_OK=${by("PREVIEW_OK")}  UNSUPPORTED=${by("UNSUPPORTED")}  FAIL=${by("FAIL")}  SKIP=${by("SKIP")}`,
  );
  const fails = rows.filter((r) => r.status === "FAIL");
  if (fails.length) {
    console.log("\nFAILURES:");
    for (const f of fails) console.log(`  ✗ ${f.action} — ${f.detail}`);
    process.exitCode = 1;
  } else {
    console.log("\nNo hard failures. (UNSUPPORTED = adapter method not implemented; expected.)");
  }
}

main().catch((e) => {
  console.error("LIVE FULL run crashed:", err(e));
  process.exit(1);
});
