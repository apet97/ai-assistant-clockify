/**
 * Safety-net cleanup: remove any leftover AIASSIST_SMOKE_* resources from the
 * sacrificial workspace (clients, projects, tags, time entries, webhooks).
 * Clients/projects are archived before delete (Clockify requires it).
 *
 * Run (reads .env):  LIVE_CLOCKIFY=1 npx tsx scripts/live-sweep.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { createRestWorkspaceClient } from "../src/clockify/rest-workspace.js";
import { requireCompleteRows } from "../src/clockify/rest/list-pages.js";

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
if (process.env.LIVE_CLOCKIFY !== "1" || !API_KEY || !WS) {
  console.error("Need LIVE_CLOCKIFY=1, LIVE_CLOCKIFY_API_KEY, LIVE_WORKSPACE_ID.");
  process.exit(2);
}
const PFX = "AIASSIST_SMOKE_";
const clockify = createRestWorkspaceClient({
  baseUrl: BASE,
  workspaceId: WS,
  auth: { apiKey: API_KEY },
});

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "X-Api-Key": API_KEY as string, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 160)}`);
  if (res.status === 204) return null;
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

async function main(): Promise<void> {
  const ws = `/workspaces/${WS}`;
  let removed = 0;

  // invoices FIRST (a client cannot be deleted while it has invoices).
  const invoices = requireCompleteRows(await clockify.listInvoices(), "find invoices to sweep");
  for (const inv of invoices) {
    if (inv?.number?.startsWith(PFX) || inv?.clientName?.startsWith(PFX)) {
      await clockify.deleteInvoice(inv.id).catch((e) => console.warn(`  invoice ${inv.id}: ${e.message}`));
      console.log(`  removed invoice ${inv.number ?? inv.id}`); removed++;
    }
  }
  const expenses = requireCompleteRows(await clockify.listExpenses(), "find expenses to sweep");
  for (const e of expenses) {
    if (typeof e?.notes === "string" && e.notes.startsWith(PFX)) {
      await clockify.deleteExpense(e.id).catch((err) => console.warn(`  expense ${e.id}: ${err.message}`));
      console.log(`  removed expense ${e.notes}`); removed++;
    }
  }
  const cats = requireCompleteRows(await clockify.listExpenseCategories(), "find expense categories to sweep");
  for (const c of cats) {
    if (typeof c?.name === "string" && c.name.startsWith(PFX)) {
      await clockify.deleteExpenseCategory(c.id).catch((err) => console.warn(`  category ${c.id}: ${err.message}`));
      console.log(`  removed expense category ${c.name}`); removed++;
    }
  }

  // time entries (user-scoped to the API key's own user; match description prefix)
  const me = (await call("GET", "/user").catch(() => null)) as { id?: string } | null;
  if (me?.id) {
    const entries = requireCompleteRows(
      await clockify.getEntries({ userId: me.id }),
      "find time entries to sweep",
    );
    for (const e of entries) {
      if (typeof e?.description === "string" && e.description.startsWith(PFX)) {
        await call("PATCH", `${ws}/time-entries/invoiced`, { timeEntryIds: [e.id], invoiced: false }).catch(() => {});
        await call("DELETE", `${ws}/time-entries/${e.id}`).catch((err) => console.warn(`  entry ${e.id}: ${err.message}`));
        console.log(`  removed time entry ${e.description}`); removed++;
      }
    }
  }
  const customFields = requireCompleteRows(await clockify.listCustomFields(), "find custom fields to sweep");
  for (const cf of customFields) {
    if (typeof cf?.name === "string" && cf.name.startsWith(PFX)) {
      await clockify.deleteCustomField(cf.id).catch((e) => console.warn(`  custom field ${cf.id}: ${e.message}`));
      console.log(`  removed custom field ${cf.name}`); removed++;
    }
  }
  const holidays = requireCompleteRows(await clockify.listHolidays(), "find holidays to sweep");
  for (const hol of holidays) {
    if (typeof hol?.name === "string" && hol.name.startsWith(PFX)) {
      await clockify.deleteHoliday(hol.id).catch((e) => console.warn(`  holiday ${hol.id}: ${e.message}`));
      console.log(`  removed holiday ${hol.name}`); removed++;
    }
  }
  const groups = requireCompleteRows(await clockify.listGroups(), "find user groups to sweep");
  for (const g of groups) {
    if (typeof g?.name === "string" && g.name.startsWith(PFX)) {
      await clockify.deleteGroup(g.id).catch((e) => console.warn(`  group ${g.id}: ${e.message}`));
      console.log(`  removed user group ${g.name}`); removed++;
    }
  }
  const tags = requireCompleteRows(await clockify.listTags(), "find tags to sweep");
  for (const t of tags) {
    if (t.name?.startsWith(PFX)) {
      await clockify.deleteTag(t.id).catch((e) => console.warn(`  tag ${t.id}: ${e.message}`));
      console.log(`  removed tag ${t.name}`); removed++;
    }
  }
  const projects = [
    ...requireCompleteRows(await clockify.listProjects(), "find active projects to sweep"),
    ...requireCompleteRows(await clockify.listProjects({ archived: true }), "find archived projects to sweep"),
  ];
  for (const p of projects) {
    if (p.name?.startsWith(PFX)) {
      await clockify.deleteProject(p.id).catch((e) => console.warn(`  project ${p.id}: ${e.message}`));
      console.log(`  removed project ${p.name}`); removed++;
    }
  }
  const clients = [
    ...requireCompleteRows(await clockify.listClients(), "find active clients to sweep"),
    ...requireCompleteRows(await clockify.listClients({ archived: true }), "find archived clients to sweep"),
  ];
  for (const c of clients) {
    if (c.name?.startsWith(PFX)) {
      await clockify.deleteClient(c.id).catch((e) => console.warn(`  client ${c.id}: ${e.message}`));
      console.log(`  removed client ${c.name}`); removed++;
    }
  }
  const hooks = requireCompleteRows(await clockify.listWebhooks(), "find webhooks to sweep");
  for (const w of hooks) {
    if (typeof w?.name === "string" && w.name.startsWith(PFX)) {
      await clockify.deleteWebhook(w.id).catch((e) => console.warn(`  webhook ${w.id}: ${e.message}`));
      console.log(`  removed webhook ${w.name}`); removed++;
    }
  }
  console.log(removed ? `\nSweep removed ${removed} leftover(s).` : "\nNo AIASSIST_SMOKE_ leftovers found. Clean.");
}
main().catch((e) => { console.error("sweep failed:", e.message); process.exit(1); });
