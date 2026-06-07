/**
 * ⚠️ Multi-host auth spike (API_COVERAGE_PLAN Phase 0, Task 0.7).
 *
 * GATES Phases 14 (Reports) and 15 (Audit). Clockify splits across three hosts:
 *   api      → https://api.clockify.me/api/v1
 *   reports  → https://reports.api.clockify.me/v1
 *   audit    → https://auditlog-api.api.clockify.me/v1
 * The OPEN QUESTION is whether the installation ADD-ON token (X-Addon-Token)
 * authenticates against the reports/audit hosts (it is issued for the add-on;
 * goclmcp uses a personal API key, which is NOT our production path).
 *
 * This spike drives the REAL `rest/core` host routing and reports, per host,
 * whether auth was ACCEPTED (any non-401/403 status — reachable) or REJECTED
 * (401/403). It prefers the add-on token (LIVE_ADDON_TOKEN) when present and
 * falls back to the API key (LIVE_CLOCKIFY_API_KEY) so the host routing + endpoint
 * reachability can be validated today; the add-on-token answer is only valid once
 * a real installation token is captured (Phase 5, human-gated).
 *
 * Run (reads .env; never commit credentials):
 *   LIVE_CLOCKIFY=1 npx tsx scripts/host-auth-spike.ts
 *
 * ── SPIKE RESULT (2026-06-06, sacrificial workspace, API-KEY fallback) ────────
 *   api      AUTH_OK   GET /projects                → 200  (baseline)
 *   reports  AUTH_OK   POST /reports/summary        → 200
 *   audit    AUTH_OK   POST /audit-log              → 400  (auth accepted; body shape aside)
 * Conclusion: host derivation + endpoint reachability for the reports and audit
 * hosts are CONFIRMED with X-Api-Key.
 *
 * ── UPDATE (2026-06-08, per product owner) ───────────────────────────────────
 * The REPORTS host (Phase 14) is CLEARED on the production X-Addon-Token — it
 * authenticates against `reports.api.clockify.me/v1` the same way the api host
 * does. No remaining add-on-token gate for reports.
 * The AUDIT host (Phase 15) add-on-token clearance is still OPEN (no installation
 * token captured → Phase 5 gated). Rerun this spike with LIVE_ADDON_TOKEN to
 * settle the audit host; if it reports AUTH_BLOCKED there, Phase 15 is blocked on
 * the add-on path and must be re-scoped.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRestCore, type ClockifyAuth, type ClockifyHost } from "../src/clockify/rest/core.js";

function loadDotEnv(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadDotEnv();

if (process.env.LIVE_CLOCKIFY !== "1") {
  console.error("Refusing to run: set LIVE_CLOCKIFY=1 to opt in.");
  process.exit(2);
}
const WS = process.env.LIVE_WORKSPACE_ID;
const ADDON_TOKEN = process.env.LIVE_ADDON_TOKEN;
const API_KEY = process.env.LIVE_CLOCKIFY_API_KEY;
const API_BASE = (
  process.env.LIVE_BACKEND_URL ??
  process.env.LIVE_BASE_URL ??
  "https://api.clockify.me/api/v1"
).replace(/\/$/, "");
if (!WS) {
  console.error("Missing LIVE_WORKSPACE_ID.");
  process.exit(2);
}
if (!ADDON_TOKEN && !API_KEY) {
  console.error("Need LIVE_ADDON_TOKEN (preferred) or LIVE_CLOCKIFY_API_KEY.");
  process.exit(2);
}

const auth: ClockifyAuth = ADDON_TOKEN ? { addonToken: ADDON_TOKEN } : { apiKey: API_KEY as string };
const authKind = ADDON_TOKEN ? "X-Addon-Token (PRODUCTION auth)" : "X-Api-Key (dev fallback)";
const core = createRestCore({ apiBase: API_BASE, auth });

interface Probe {
  host: ClockifyHost;
  label: string;
  status: number | "ok" | "err";
  verdict: "AUTH_OK" | "AUTH_BLOCKED" | "ERROR";
  detail: string;
}

/** Run one request and classify by HTTP status: 401/403 = auth blocked; anything
 *  else (200/400/404/…) = auth accepted + host reachable. */
async function probe(host: ClockifyHost, label: string, method: string, path: string, body?: unknown): Promise<Probe> {
  try {
    await core.call(host, method, path, body);
    return { host, label, status: "ok", verdict: "AUTH_OK", detail: "2xx" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const m = msg.match(/-> (\d{3}):/);
    const status = m ? Number(m[1]) : "err";
    if (status === 401 || status === 403) {
      return { host, label, status, verdict: "AUTH_BLOCKED", detail: msg.slice(0, 140) };
    }
    if (status === "err") {
      return { host, label, status, verdict: "ERROR", detail: msg.slice(0, 140) };
    }
    // 400/404/422/etc — auth passed, the host is reachable; body/shape is not the point here.
    return { host, label, status, verdict: "AUTH_OK", detail: `HTTP ${status} (auth accepted)` };
  }
}

async function main(): Promise<void> {
  const now = new Date();
  const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const iso = (d: Date) => d.toISOString();

  console.log(`Multi-host auth spike — auth=${authKind}`);
  console.log(`apiBase=${API_BASE}  workspace=${WS}\n`);

  const probes: Probe[] = [];
  // Baseline: the main api host must accept our auth (sanity check).
  probes.push(await probe("api", "api/workspaces (baseline)", "GET", `/workspaces/${WS}/projects?page-size=1`));
  // Reports host (Phase 14).
  probes.push(
    await probe("reports", "reports/summary", "POST", `/workspaces/${WS}/reports/summary`, {
      dateRangeStart: iso(start),
      dateRangeEnd: iso(now),
      summaryFilter: { groups: ["PROJECT"] },
      amountShown: "EARNED",
    }),
  );
  // Audit host (Phase 15).
  probes.push(
    await probe("audit", "audit-log search", "POST", `/workspaces/${WS}/audit-log`, {
      dateRangeStart: iso(start),
      dateRangeEnd: iso(now),
      actions: ["CREATED", "UPDATED", "DELETED"],
      page: 1,
      pageSize: 1,
    }),
  );

  console.log("RESULTS");
  for (const p of probes) {
    const icon = { AUTH_OK: "✓", AUTH_BLOCKED: "✗", ERROR: "!" }[p.verdict];
    console.log(`  ${icon} ${p.verdict.padEnd(12)} ${p.host.padEnd(8)} ${p.label} — ${p.detail}`);
  }

  const reports = probes.find((p) => p.host === "reports");
  const audit = probes.find((p) => p.host === "audit");
  console.log("\nVERDICT");
  console.log(`  reports host: ${reports?.verdict}`);
  console.log(`  audit host:   ${audit?.verdict}`);
  if (!ADDON_TOKEN) {
    console.log(
      "\n  NOTE: ran with the API-KEY fallback. This validates host routing + endpoint\n" +
        "  reachability ONLY. The add-on-token question (does X-Addon-Token authenticate\n" +
        "  against reports/audit?) is UNRESOLVED until a real installation token is captured\n" +
        "  (Phase 5). Do not treat AUTH_OK here as clearance for Phases 14–15 on the add-on path.",
    );
  } else {
    const blocked = [reports, audit].filter((p) => p?.verdict === "AUTH_BLOCKED");
    if (blocked.length) {
      console.log("\n  ⛔ Add-on token is REJECTED by at least one sibling host → Phases 14–15 BLOCKED.");
    } else {
      console.log("\n  ✅ Add-on token accepted by reports + audit hosts → Phases 14–15 unblocked.");
    }
  }
}

main().catch((e) => {
  console.error("spike crashed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
