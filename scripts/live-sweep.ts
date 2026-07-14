/**
 * Safety-net cleanup: remove any leftover AIASSIST_SMOKE_* resources from the
 * sacrificial workspace (clients, projects, tags, time entries, webhooks).
 * Clients/projects are archived before delete (Clockify requires it).
 *
 * Run (reads .env):  LIVE_CLOCKIFY=1 npx tsx scripts/live-sweep.ts
 */
import { existsSync, readFileSync } from "node:fs";
import type { ListResult } from "../src/clockify/client.js";
import { createRestWorkspaceClient } from "../src/clockify/rest-workspace.js";
import { requireCompleteRows } from "../src/clockify/rest/list-pages.js";
import { writeLiveEvidence } from "./evidence/live-evidence.js";
import { createLiveMutationJournal } from "./live-mutation-journal.js";

function loadDotEnv(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadDotEnv();

const API_KEY = process.env.LIVE_CLOCKIFY_API_KEY;
const WS = process.env.LIVE_WORKSPACE_ID;
const BASE = (process.env.LIVE_BASE_URL ?? "https://api.clockify.me/api/v1").replace(/\/$/, "");
const PFX = "AIASSIST_SMOKE_";
const EVIDENCE_PATH = process.env.LIVE_SWEEP_EVIDENCE_PATH
  ?? "/tmp/ai-assistant-live-smoke-evidence/cleanup.json";
let matched = 0;
let removed = 0;
let cleanupFailures = 0;
let scanFailures = 0;

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "X-Api-Key": API_KEY as string, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    await res.arrayBuffer();
    throw new Error(`${method} request failed with status ${String(res.status)}`);
  }
  if (res.status === 204) return null;
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

async function cleanup(remove: () => Promise<unknown>): Promise<void> {
  matched++;
  try {
    await remove();
    removed++;
  } catch {
    cleanupFailures++;
  }
}

async function scanRows<T>(read: () => Promise<ListResult<T>>, context: string): Promise<T[]> {
  try {
    return requireCompleteRows(await read(), context);
  } catch {
    scanFailures++;
    return [];
  }
}

async function main(): Promise<{ matched: number; removed: number; failures: number; scanFailures: number }> {
  if (process.env.LIVE_CLOCKIFY !== "1" || !API_KEY || !WS) {
    throw new Error("live sweep opt-in and credentials are required");
  }
  const clockify = createRestWorkspaceClient({
    baseUrl: BASE,
    workspaceId: WS,
    auth: { apiKey: API_KEY },
  });
  const journal = createLiveMutationJournal(WS, "live-cleanup");
  const mutate = (actionName: string, detail: unknown, dispatch: () => Promise<unknown>): Promise<void> =>
    journal.runSingle(actionName, detail, dispatch);

  try {
  // invoices FIRST (a client cannot be deleted while it has invoices).
  const invoices = await scanRows(() => clockify.listInvoices(), "find invoices to sweep");
  for (const inv of invoices) {
    if (inv?.number?.startsWith(PFX) || inv?.clientName?.startsWith(PFX)) {
      await cleanup(() => mutate("live_cleanup_invoice", { type: "invoice", id: inv.id }, () => clockify.deleteInvoiceAtomic(inv.id)));
    }
  }
  const expenses = await scanRows(() => clockify.listExpenses(), "find expenses to sweep");
  for (const e of expenses) {
    if (typeof e?.notes === "string" && e.notes.startsWith(PFX)) {
      await cleanup(() => mutate("live_cleanup_expense", { type: "expense", id: e.id }, () => clockify.deleteExpenseAtomic(e.id)));
    }
  }
  const cats = [
    ...await scanRows(() => clockify.listExpenseCategories({ archived: false }), "find active expense categories to sweep"),
    ...await scanRows(() => clockify.listExpenseCategories({ archived: true }), "find archived expense categories to sweep"),
  ];
  for (const c of cats) {
    if (typeof c?.name === "string" && c.name.startsWith(PFX)) {
      await cleanup(async () => {
        if (!c.archived) await mutate("live_cleanup_expense_category_archive", { type: "expense_category", id: c.id }, () => clockify.setExpenseCategoryArchivedAtomic(c.id, true));
        await mutate("live_cleanup_expense_category_delete", { type: "expense_category", id: c.id }, () => clockify.deleteExpenseCategoryAtomic(c.id));
      });
    }
  }

  // time entries (user-scoped to the API key's own user; match description prefix)
  let me: { id?: string } | undefined;
  try {
    me = await call("GET", "/user") as { id?: string } | undefined;
    if (!me?.id) scanFailures++;
  } catch {
    scanFailures++;
  }
  if (me?.id) {
    const entries = await scanRows(
      () => clockify.getEntries({ userId: me!.id! }),
      "find time entries to sweep",
    );
    for (const e of entries) {
      if (typeof e?.description === "string" && e.description.startsWith(PFX)) {
        await cleanup(async () => {
          await mutate("live_cleanup_time_entry_uninvoice", { type: "time_entry", id: e.id }, () => clockify.markEntriesInvoicedAtomic({ ids: [e.id], invoiced: false })).catch(() => {});
          await mutate("live_cleanup_time_entry_delete", { type: "time_entry", id: e.id }, () => clockify.deleteTimeEntryAtomic(e.id));
        });
      }
    }
  }
  const customFields = await scanRows(() => clockify.listCustomFields(), "find custom fields to sweep");
  for (const cf of customFields) {
    if (typeof cf?.name === "string" && cf.name.startsWith(PFX)) {
      await cleanup(() => mutate("live_cleanup_custom_field", { type: "custom_field", id: cf.id }, () => clockify.deleteCustomFieldAtomic(cf.id)));
    }
  }
  const holidays = await scanRows(() => clockify.listHolidays(), "find holidays to sweep");
  for (const hol of holidays) {
    if (typeof hol?.name === "string" && hol.name.startsWith(PFX)) {
      await cleanup(() => mutate("live_cleanup_holiday", { type: "holiday", id: hol.id }, () => clockify.deleteHolidayAtomic(hol.id)));
    }
  }
  const groups = await scanRows(() => clockify.listGroups(), "find user groups to sweep");
  for (const g of groups) {
    if (typeof g?.name === "string" && g.name.startsWith(PFX)) {
      await cleanup(() => mutate("live_cleanup_group", { type: "group", id: g.id }, () => clockify.deleteGroupAtomic(g.id)));
    }
  }
  const tags = await scanRows(() => clockify.listTags(), "find tags to sweep");
  for (const t of tags) {
    if (t.name?.startsWith(PFX)) {
      await cleanup(() => mutate("live_cleanup_tag", { type: "tag", id: t.id }, () => clockify.deleteTagAtomic(t.id)));
    }
  }
  const projects = [
    ...await scanRows(() => clockify.listProjects(), "find active projects to sweep"),
    ...await scanRows(() => clockify.listProjects({ archived: true }), "find archived projects to sweep"),
  ];
  for (const p of projects) {
    if (p.name?.startsWith(PFX)) {
      await cleanup(async () => {
        if (!p.archived) {
          const body = await clockify.prepareProjectUpdate(p.id, { archived: true });
          await mutate("live_cleanup_project_archive", { type: "project", id: p.id, body }, () => clockify.archiveProjectAtomic(p.id, body));
        }
        await mutate("live_cleanup_project_delete", { type: "project", id: p.id }, () => clockify.deleteProjectAtomic(p.id));
      });
    }
  }
  const clients = [
    ...await scanRows(() => clockify.listClients(), "find active clients to sweep"),
    ...await scanRows(() => clockify.listClients({ archived: true }), "find archived clients to sweep"),
  ];
  for (const c of clients) {
    if (c.name?.startsWith(PFX)) {
      await cleanup(async () => {
        if (!c.archived) {
          const body = await clockify.prepareClientUpdate(c.id, { archived: true });
          await mutate("live_cleanup_client_archive", { type: "client", id: c.id, body }, () => clockify.updateClientAtomic(c.id, body));
        }
        await mutate("live_cleanup_client_delete", { type: "client", id: c.id }, () => clockify.deleteClientAtomic(c.id));
      });
    }
  }
  const hooks = await scanRows(() => clockify.listWebhooks(), "find webhooks to sweep");
  for (const w of hooks) {
    if (typeof w?.name === "string" && w.name.startsWith(PFX)) {
      await cleanup(() => mutate("live_cleanup_webhook", { type: "webhook", id: w.id }, () => clockify.deleteWebhookAtomic(w.id)));
    }
  }
  const failures = cleanupFailures + scanFailures;
  console.log(`Sweep matched ${matched}, removed ${removed}, cleanup failures ${cleanupFailures}, scan failures ${scanFailures}.`);
  if (failures > 0) throw new Error("one or more live cleanup scans or attempts failed");
  return { matched, removed, failures, scanFailures };
  } finally {
    journal.close();
  }
}
main().then((counts) => {
  writeLiveEvidence(EVIDENCE_PATH, {
    resourcePrefixes: [PFX],
    counts,
    passed: true,
  });
}).catch(() => {
  writeLiveEvidence(EVIDENCE_PATH, {
    resourcePrefixes: [PFX],
    counts: {
      matched,
      removed,
      failures: Math.max(cleanupFailures + scanFailures, 1),
      scanFailures,
    },
    passed: false,
  });
  console.error("LIVE SWEEP FAILED");
  process.exitCode = 1;
});
