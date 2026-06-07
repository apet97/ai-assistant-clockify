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
    webhookId?: string;
    invoiceId?: string;
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

    // webhook create then delete (self-cleaning) — needs webhookEvent + https url
    const wh = await risky(ctx, "clockify_manage_webhook", {
      operation: "create",
      name: names.webhook,
      url: "https://example.com/aiassist-smoke-hook",
      webhookEvent: "NEW_TIME_ENTRY",
    });
    ids.webhookId = wh?.changed?.created?.[0]?.id;
    if (ids.webhookId) {
      const del = await risky(ctx, "clockify_manage_webhook", { operation: "delete", id: ids.webhookId });
      if (del) ids.webhookId = undefined; // deleted
    }

    // invoice create (billing) — capture id; a draft invoice is deletable, so it
    // is removed in cleanup (full create→delete round-trip).
    if (ids.clientId) {
      const inv = await risky(ctx, "clockify_prepare_invoice", {
        clientId: ids.clientId,
        clientName: names.client,
        title: `AIASSIST_SMOKE_inv_${sfx}`,
        currency,
      });
      ids.invoiceId = inv?.changed?.created?.[0]?.id;
    } else {
      record("clockify_prepare_invoice", "SKIP", "no client id");
    }

    // update_entity (project rename) — real fetch-then-merge PUT.
    if (ids.projectId) {
      await risky(ctx, "clockify_update_entity", {
        entityType: "project",
        id: ids.projectId,
        name: `${names.project}_renamed`,
      });
    }

    // expense create then delete (self-cleaning, multipart) — needs a category.
    if (categoryId) {
      const exp = await risky(ctx, "clockify_manage_expense", {
        operation: "create",
        name: `AIASSIST_SMOKE_exp_${sfx}`,
        amount: 1,
        date: new Date().toISOString().slice(0, 10),
        categoryId,
      });
      const expId = exp?.changed?.created?.[0]?.id;
      if (expId) await risky(ctx, "clockify_manage_expense", { operation: "delete", id: expId });
    } else {
      record("clockify_manage_expense", "SKIP", "no expense category available");
    }

    // time-off + schedule: preview-only by design (see previewOnly() rationale).
    await previewOnly(ctx, "clockify_manage_time_off", {
      decision: "approve",
      requestId: "smoke-nonexistent",
      policyId: policyId ?? "smoke-policy",
    });
    await previewOnly(ctx, "clockify_manage_schedule", {
      operation: "publish",
      start: "2030-01-01T00:00:00Z",
      end: "2030-01-07T00:00:00Z",
    });

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
    if (ids.webhookId) {
      try {
        await call("DELETE", `${ws}/webhooks/${ids.webhookId}`, undefined, true);
        console.log(`  deleted leftover webhook ${ids.webhookId}`);
      } catch (e) {
        console.warn(`  WARN webhook ${ids.webhookId}: ${err(e)}`);
      }
    }
    // Delete the invoice BEFORE its client (an active client referenced by an
    // invoice cannot be removed cleanly).
    if (ids.invoiceId) {
      try {
        await call("DELETE", `${ws}/invoices/${ids.invoiceId}`, undefined, true);
        console.log(`  deleted invoice ${ids.invoiceId}`);
        ids.invoiceId = undefined;
      } catch (e) {
        console.warn(`  WARN invoice ${ids.invoiceId} leftover: ${err(e)}`);
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
