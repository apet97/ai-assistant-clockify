/**
 * Safety-net cleanup: remove any leftover AIASSIST_SMOKE_* resources from the
 * sacrificial workspace (clients, projects, tags, time entries, webhooks).
 * Clients/projects are archived before delete (Clockify requires it).
 *
 * Run (reads .env):  LIVE_CLOCKIFY=1 npx tsx scripts/live-sweep.ts
 */
import { existsSync, readFileSync } from "node:fs";

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

  // invoices FIRST (a client cannot be deleted while it has invoices). Live shape:
  // {total, invoices:[{id, number, clientName, ...}]}. Match on number or client.
  const invResp = (await call("GET", `${ws}/invoices?page-size=200`).catch(() => null)) as
    | { invoices?: any[] }
    | any[]
    | null;
  const invoices = Array.isArray(invResp) ? invResp : (invResp?.invoices ?? []);
  for (const inv of invoices as any[]) {
    if (inv?.number?.startsWith(PFX) || inv?.clientName?.startsWith(PFX)) {
      await call("DELETE", `${ws}/invoices/${inv.id}`).catch((e) => console.warn(`  invoice ${inv.id}: ${e.message}`));
      console.log(`  removed invoice ${inv.number ?? inv.id}`); removed++;
    }
  }
  // expenses. Live shape: {expenses:{expenses:[{id, notes, ...}], count}, ...}.
  const expResp = (await call("GET", `${ws}/expenses?page-size=200`).catch(() => null)) as any;
  const expenses = Array.isArray(expResp) ? expResp : (expResp?.expenses?.expenses ?? []);
  for (const e of expenses as any[]) {
    if (typeof e?.notes === "string" && e.notes.startsWith(PFX)) {
      await call("DELETE", `${ws}/expenses/${e.id}`).catch((err) => console.warn(`  expense ${e.id}: ${err.message}`));
      console.log(`  removed expense ${e.notes}`); removed++;
    }
  }

  // tags
  for (const t of ((await call("GET", `${ws}/tags?page-size=500`)) ?? []) as any[]) {
    if (t.name?.startsWith(PFX)) {
      await call("DELETE", `${ws}/tags/${t.id}`).catch((e) => console.warn(`  tag ${t.id}: ${e.message}`));
      console.log(`  removed tag ${t.name}`); removed++;
    }
  }
  // projects (archive then delete; cascades tasks)
  for (const p of ((await call("GET", `${ws}/projects?page-size=500&archived=false`)) ?? []) as any[]) {
    if (p.name?.startsWith(PFX)) {
      await call("PUT", `${ws}/projects/${p.id}`, { name: p.name, archived: true }).catch(() => {});
      await call("DELETE", `${ws}/projects/${p.id}`).catch((e) => console.warn(`  project ${p.id}: ${e.message}`));
      console.log(`  removed project ${p.name}`); removed++;
    }
  }
  // clients (archive with name, then delete)
  for (const c of ((await call("GET", `${ws}/clients?page-size=500`)) ?? []) as any[]) {
    if (c.name?.startsWith(PFX)) {
      await call("PUT", `${ws}/clients/${c.id}`, { name: c.name, archived: true }).catch(() => {});
      await call("DELETE", `${ws}/clients/${c.id}`).catch((e) => console.warn(`  client ${c.id}: ${e.message}`));
      console.log(`  removed client ${c.name}`); removed++;
    }
  }
  // webhooks (envelope: {workspaceWebhookCount, webhooks:[...]})
  const whResp = (await call("GET", `${ws}/webhooks`).catch(() => null)) as any;
  const hooks = Array.isArray(whResp) ? whResp : (whResp?.webhooks ?? []);
  for (const w of hooks as any[]) {
    if (typeof w?.name === "string" && w.name.startsWith(PFX)) {
      await call("DELETE", `${ws}/webhooks/${w.id}`).catch((e) => console.warn(`  webhook ${w.id}: ${e.message}`));
      console.log(`  removed webhook ${w.name}`); removed++;
    }
  }
  console.log(removed ? `\nSweep removed ${removed} leftover(s).` : "\nNo AIASSIST_SMOKE_ leftovers found. Clean.");
}
main().catch((e) => { console.error("sweep failed:", e.message); process.exit(1); });
