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
 * whether auth was ACCEPTED (2xx or an endpoint-specific expected 4xx), REJECTED
 * (401/403), or INCONCLUSIVE (throttle, server, unexpected 4xx, or transport).
 * It prefers the add-on token (LIVE_ADDON_TOKEN) when present and
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
 * token captured → release evidence incomplete). Rerun this spike with LIVE_ADDON_TOKEN to
 * settle the audit host; if it reports AUTH_BLOCKED there, Phase 15 is blocked on
 * the add-on path and must be re-scoped.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRestCore, type ClockifyAuth, type ClockifyHost } from "../src/clockify/rest/core.js";
import {
  extractHttpStatus,
  toSecretFreeProbeResult,
  type SecretFreeProbeResult,
} from "./lib/live-evidence.js";

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
const releaseSha = process.env.LIVE_RELEASE_SHA;
const checkedOutSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!releaseSha || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(releaseSha) || releaseSha !== checkedOutSha) {
  throw new Error("host_auth_release_sha_mismatch");
}
const core = createRestCore({ apiBase: API_BASE, auth });

/** Run one request and return only a secret-free, fail-closed classification. */
async function probe(
  host: ClockifyHost,
  label: string,
  method: string,
  path: string,
  body?: unknown,
  expected4xx: readonly number[] = [],
): Promise<SecretFreeProbeResult> {
  try {
    if (method === "POST" && (host === "reports" || host === "audit")) {
      await core.postQuery(host, path, body);
    } else if (["GET", "HEAD", "OPTIONS"].includes(method)) {
      await core.call(host, method, path, body);
    } else {
      await core.mutate(host, method, path, body);
    }
    return toSecretFreeProbeResult({ key: label, host, method, status: "2xx", expected4xx, workspaceId: WS, path });
  } catch (error) {
    return toSecretFreeProbeResult({
      key: label, host, method, status: extractHttpStatus(error), expected4xx,
      workspaceId: WS, path, error,
    });
  }
}

async function main(): Promise<void> {
  const now = new Date();
  const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const iso = (d: Date) => d.toISOString();

  console.log(`Multi-host auth spike — auth=${authKind}`);
  console.log("target identifiers and request paths are redacted\n");

  const probes: SecretFreeProbeResult[] = [];
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
    }, [400, 422]),
  );

  console.log("RESULTS");
  for (const p of probes) {
    const icon = { AUTH_OK: "✓", AUTH_BLOCKED: "✗", INCONCLUSIVE: "!" }[p.verdict];
    console.log(`  ${icon} ${p.verdict.padEnd(12)} ${p.host.padEnd(8)} ${p.key} — ${p.status}`);
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
    if ([reports, audit].every((result) => result?.verdict === "AUTH_OK")) {
      console.log("\n  ✅ Add-on token accepted by reports + audit hosts → Phases 14–15 unblocked.");
    } else {
      console.log("\n  ⛔ Add-on-token clearance was not established for every sibling host.");
    }
  }
  const productionClear = Boolean(ADDON_TOKEN) && probes.every(({ verdict }) => verdict === "AUTH_OK");
  const evidencePath = process.env.HOST_AUTH_EVIDENCE_PATH;
  if (evidencePath) {
    writeFileSync(evidencePath, `${JSON.stringify({
      schemaVersion: 1,
      releaseSha,
      auth: ADDON_TOKEN ? "X-Addon-Token" : "development-fallback",
      results: probes,
      conclusion: productionClear ? "passed" : "failed",
    }, null, 2)}\n`, "utf8");
  }
  if (!productionClear) process.exitCode = 1;
}

main().catch(() => {
  console.error("spike crashed; no evidence was produced");
  process.exit(1);
});
