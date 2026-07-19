/**
 * Fresh-install aggregate manifest-scope reachability probe. Uses a newly
 * issued production X-Addon-Token plus a server-minted installation attestation
 * bound to the exact installation generation, release bytes, and deployed
 * manifest. Write scopes
 * are checked with impossible all-zero resource ids,
 * so Clockify reaches authorization/routing but cannot mutate a real resource.
 * Only 2xx or an endpoint-specific expected 4xx proves that auth passed.
 * Authentication failures, throttles, server errors, and transport failures
 * fail the probe without leaking request paths or response detail.
 *
 * LIVE_CLOCKIFY=1 LIVE_SCOPE_FRESH_INSTALL=1 LIVE_ADDON_TOKEN=... \
 * LIVE_WORKSPACE_ID=... LIVE_API_URL=... LIVE_RELEASE_SHA=<full-sha> \
 * LIVE_ADDON_BASE_URL=https://deployed.example npm run probe:scopes
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRestCore, type ClockifyHost } from "../src/clockify/rest/core.js";
import {
  resolveClockifyApiBase,
  resolveClockifyAuditBase,
  resolveClockifyReportsBase,
} from "../src/clockify/api-base.js";
import {
  CLOCKIFY_SCOPE_ENFORCEMENT_SHA256,
  CLOCKIFY_SCOPE_ENFORCEMENT_SOURCE,
  REQUIRED_SCOPES,
} from "../src/addon/scope-contract.js";
import { buildManifest } from "../src/addon/manifest.js";
import {
  createAuthenticatedFreshInstallEvidence,
  extractHttpStatus,
  hashCanonicalJson,
  toSecretFreeProbeResult,
  verifyDeployedReleaseBinding,
  type SecretFreeProbeResult,
} from "./lib/live-evidence.js";
import { privateProductionRailwayOrigin } from "./lib/private-production-origin.js";
import {
  requireScopeProbeArtifactPaths,
  writeScopeProbeArtifacts,
} from "./lib/scope-probe-artifacts.js";

function loadDotEnv(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}
if (process.env.LIVE_CLOCKIFY !== "1" || process.env.LIVE_SCOPE_FRESH_INSTALL !== "1") {
  console.error("Refusing to run: set LIVE_CLOCKIFY=1 and LIVE_SCOPE_FRESH_INSTALL=1.");
  process.exit(2);
}

function decodeClaims(token: string): Record<string, unknown> {
  try {
    const payload = token.split(".")[1];
    return payload ? JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const releaseSha = process.env.LIVE_RELEASE_SHA;
const checkoutRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const checkedOutSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!releaseSha || !/^[0-9a-f]{40}$/.test(releaseSha) || releaseSha !== checkedOutSha) {
  throw new Error("scope_probe_release_sha_mismatch");
}
if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) {
  throw new Error("scope_probe_requires_clean_checkout");
}
const artifactPaths = requireScopeProbeArtifactPaths(process.env, checkoutRoot);
const rawAddonBaseUrl = process.env.LIVE_ADDON_BASE_URL ?? process.env.BASE_URL;
if (!rawAddonBaseUrl) {
  throw new Error("scope_probe_deployed_base_url_required");
}
const deployedBaseUrl = privateProductionRailwayOrigin(rawAddonBaseUrl);
if (!deployedBaseUrl) {
  throw new Error("scope_probe_deployed_base_url_invalid");
}
const addonBaseUrl = deployedBaseUrl.origin;
loadDotEnv();
const workspaceId = process.env.LIVE_WORKSPACE_ID;
const addonToken = process.env.LIVE_ADDON_TOKEN;
const apiUrl = process.env.LIVE_API_URL ?? process.env.LIVE_BACKEND_URL;
if (!workspaceId || !addonToken || !apiUrl) {
  console.error("Missing LIVE_WORKSPACE_ID, LIVE_ADDON_TOKEN, or LIVE_API_URL.");
  process.exit(2);
}

async function fetchDeployedJson(path: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(new URL(path, deployedBaseUrl), {
      ...init,
      headers: { accept: "application/json", ...init.headers },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("scope_probe_deployment_binding_unavailable");
  }
  if (!response.ok) throw new Error("scope_probe_deployment_binding_unavailable");
  const text = await response.text();
  if (Buffer.byteLength(text) > 65_536) throw new Error("scope_probe_deployment_binding_too_large");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("scope_probe_deployment_binding_malformed");
  }
}

const startedAt = new Date();
const manifestSha256 = hashCanonicalJson(buildManifest(addonBaseUrl));
const [deployedManifest, deployedVersion] = await Promise.all([
  fetchDeployedJson("manifest"),
  fetchDeployedJson("version"),
]);
verifyDeployedReleaseBinding({
  expectedReleaseSha: releaseSha,
  expectedManifestSha256: manifestSha256,
  deployedManifest,
  deployedVersion,
});
if (!deployedVersion || typeof deployedVersion !== "object" || Array.isArray(deployedVersion)) {
  throw new Error("scope_probe_deployment_binding_malformed");
}
const version = deployedVersion as Record<string, unknown>;
const releaseBuildHash = version.buildHash;
const serverArtifactSha256 = version.serverArtifactSha256;
const sourceRelationship = version.sourceRelationship;
const sourceBindingSha256 = version.sourceBindingSha256;
if (
  typeof releaseBuildHash !== "string" || !/^[a-f0-9]{64}$/u.test(releaseBuildHash)
  || typeof serverArtifactSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(serverArtifactSha256)
  || !["exact_head", "evidence_descendant", "source_bound_builder"].includes(String(sourceRelationship))
  || (sourceRelationship === "source_bound_builder"
    ? typeof sourceBindingSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sourceBindingSha256)
    : sourceBindingSha256 !== null)
) throw new Error("scope_probe_deployment_binding_malformed");
const expectedBinding = {
  releaseSha,
  releaseBuildHash,
  serverArtifactSha256,
  sourceRelationship: sourceRelationship as "exact_head" | "evidence_descendant" | "source_bound_builder",
  sourceBindingSha256: sourceBindingSha256 as string | null,
  manifestSha256,
};
const authenticatedResponse = await fetchDeployedJson(
  `release/install-attestation/${encodeURIComponent(workspaceId)}`,
  { headers: { "X-Addon-Token": addonToken } },
);
if (!authenticatedResponse || typeof authenticatedResponse !== "object" || Array.isArray(authenticatedResponse)) {
  throw new Error("scope_probe_install_attestation_malformed");
}
const verificationEnvelope = (authenticatedResponse as Record<string, unknown>).verificationEnvelope;
const remoteVerification = await fetchDeployedJson("release/install-attestation/verify", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(verificationEnvelope),
});
const freshInstall = createAuthenticatedFreshInstallEvidence({
  expected: expectedBinding,
  authenticatedResponse,
  remoteVerification,
  now: startedAt,
});
const claims = decodeClaims(addonToken);
const reportsUrl = typeof claims.reportsUrl === "string" ? claims.reportsUrl : undefined;
const installationUrls = { apiUrl, ...(reportsUrl ? { reportsUrl } : {}) };
const core = createRestCore({
  apiBase: resolveClockifyApiBase(installationUrls),
  reportsBase: resolveClockifyReportsBase(installationUrls),
  auditBase: resolveClockifyAuditBase(installationUrls),
  auth: { addonToken },
});

const ws = `/workspaces/${workspaceId}`;
const nil = "000000000000000000000000";
interface ProbeSpec {
  key?: string;
  scope: string;
  host: ClockifyHost;
  method: string;
  path: string;
  body?: unknown;
  expected4xx?: readonly number[];
}

const INVALID_TARGET_4XX = [400, 404, 409, 422] as const;

const probes: ProbeSpec[] = [
  { scope: "CLIENT_READ", host: "api", method: "GET", path: `${ws}/clients?page-size=1` },
  { scope: "CLIENT_WRITE", host: "api", method: "DELETE", path: `${ws}/clients/${nil}`, expected4xx: INVALID_TARGET_4XX },
  { scope: "PROJECT_READ", host: "api", method: "GET", path: `${ws}/projects?page-size=1` },
  { scope: "PROJECT_WRITE", host: "api", method: "DELETE", path: `${ws}/projects/${nil}`, expected4xx: INVALID_TARGET_4XX },
  { scope: "TAG_READ", host: "api", method: "GET", path: `${ws}/tags?page-size=1` },
  { scope: "TAG_WRITE", host: "api", method: "DELETE", path: `${ws}/tags/${nil}`, expected4xx: INVALID_TARGET_4XX },
  { scope: "TASK_READ", host: "api", method: "GET", path: `${ws}/projects/${nil}/tasks?page-size=1`, expected4xx: [404] },
  { scope: "TASK_WRITE", host: "api", method: "DELETE", path: `${ws}/projects/${nil}/tasks/${nil}`, expected4xx: INVALID_TARGET_4XX },
  { scope: "TIME_ENTRY_READ", host: "api", method: "GET", path: `${ws}/user/${nil}/time-entries?page-size=1`, expected4xx: [404] },
  { scope: "TIME_ENTRY_WRITE", host: "api", method: "DELETE", path: `${ws}/time-entries/${nil}`, expected4xx: INVALID_TARGET_4XX },
  { scope: "EXPENSE_READ", host: "api", method: "GET", path: `${ws}/expenses?page-size=1` },
  { scope: "EXPENSE_WRITE", host: "api", method: "DELETE", path: `${ws}/expenses/${nil}`, expected4xx: INVALID_TARGET_4XX },
  { scope: "INVOICE_READ", host: "api", method: "GET", path: `${ws}/invoices?page-size=1` },
  { scope: "INVOICE_WRITE", host: "api", method: "DELETE", path: `${ws}/invoices/${nil}`, expected4xx: INVALID_TARGET_4XX },
  { scope: "USER_READ", host: "api", method: "GET", path: `${ws}/users?page-size=1` },
  { scope: "USER_WRITE", host: "api", method: "PUT", path: `${ws}/users/${nil}`, body: { status: "INACTIVE" }, expected4xx: INVALID_TARGET_4XX },
  { scope: "GROUP_READ", host: "api", method: "GET", path: `${ws}/user-groups?page-size=1` },
  { scope: "GROUP_WRITE", host: "api", method: "DELETE", path: `${ws}/user-groups/${nil}`, expected4xx: INVALID_TARGET_4XX },
  { scope: "WORKSPACE_READ", host: "api", method: "GET", path: `${ws}/holidays` },
  { scope: "WORKSPACE_WRITE", host: "api", method: "DELETE", path: `${ws}/holidays/${nil}`, expected4xx: INVALID_TARGET_4XX },
  { scope: "CUSTOM_FIELDS_READ", host: "api", method: "GET", path: `${ws}/custom-fields?page-size=1` },
  { scope: "CUSTOM_FIELDS_WRITE", host: "api", method: "DELETE", path: `${ws}/custom-fields/${nil}`, expected4xx: INVALID_TARGET_4XX },
  { scope: "APPROVAL_READ", host: "api", method: "GET", path: `${ws}/approval-requests?page-size=1` },
  { scope: "APPROVAL_WRITE", host: "api", method: "PATCH", path: `${ws}/approval-requests/${nil}`, body: { state: "APPROVED" }, expected4xx: INVALID_TARGET_4XX },
  { scope: "SCHEDULING_READ", host: "api", method: "GET", path: `${ws}/scheduling/assignments/all?page-size=1` },
  { scope: "SCHEDULING_WRITE", host: "api", method: "DELETE", path: `${ws}/scheduling/assignments/recurring/${nil}`, expected4xx: INVALID_TARGET_4XX },
  {
    scope: "REPORTS_READ",
    host: "reports",
    method: "POST",
    path: `${ws}/reports/summary`,
    body: {
      dateRangeStart: "2026-01-01T00:00:00.000Z",
      dateRangeEnd: "2026-01-02T00:00:00.000Z",
      summaryFilter: { groups: ["PROJECT"] },
    },
  },
  { scope: "TIME_OFF_READ", host: "api", method: "GET", path: `${ws}/time-off/policies?page-size=1` },
  { scope: "TIME_OFF_WRITE", host: "api", method: "DELETE", path: `${ws}/time-off/policies/${nil}/requests/${nil}`, expected4xx: INVALID_TARGET_4XX },
];

const expectedScopes = new Set(REQUIRED_SCOPES);
const probedScopes = new Set(probes.map(({ scope }) => scope));
const missing = [...expectedScopes].filter((scope) => !probedScopes.has(scope));
const extra = [...probedScopes].filter((scope) => !expectedScopes.has(scope as never));
if (missing.length || extra.length || probes.length !== expectedScopes.size) {
  throw new Error(`scope_probe_contract_drift:missing=${missing.join(",")};extra=${extra.join(",")}`);
}

async function runProbe(probe: ProbeSpec): Promise<SecretFreeProbeResult> {
  try {
    await core.call(probe.host, probe.method, probe.path, probe.body);
    return toSecretFreeProbeResult({
      key: probe.key ?? probe.scope.toLowerCase(), scope: probe.scope, host: probe.host,
      method: probe.method, status: "2xx", expected4xx: probe.expected4xx ?? [],
      workspaceId, path: probe.path,
    });
  } catch (error) {
    return toSecretFreeProbeResult({
      key: probe.key ?? probe.scope.toLowerCase(), scope: probe.scope, host: probe.host,
      method: probe.method, status: extractHttpStatus(error),
      expected4xx: probe.expected4xx ?? [], workspaceId, path: probe.path, error,
    });
  }
}

const results: SecretFreeProbeResult[] = [];
for (const probe of probes) results.push(await runProbe(probe));
const auditHost = await runProbe({
  key: "workspace_read_audit_host",
  scope: "WORKSPACE_READ",
  host: "audit",
  method: "POST",
  path: `${ws}/audit-log`,
  body: {
    start: new Date(startedAt.getTime() - 60 * 60 * 1000).toISOString(),
    end: startedAt.toISOString(),
    page: 1,
    "page-size": 1,
  },
});
const finishedAt = new Date();

for (const result of results) {
  console.log(`${result.verdict.padEnd(12)} ${(result.scope ?? result.key).padEnd(20)} ${result.host.toUpperCase()} ${result.method} (${result.status})`);
}
console.log(`${auditHost.verdict.padEnd(12)} AUDIT_HOST           AUDIT POST (${auditHost.status})`);

const failures = results.filter(({ verdict }) => verdict !== "AUTH_OK");
if (auditHost.verdict !== "AUTH_OK") failures.push(auditHost);
const evidence = {
  schemaVersion: 2,
  conclusion: failures.length === 0 ? "passed" : "failed",
  releaseSha,
  releaseBuildHash,
  serverArtifactSha256,
  sourceRelationship,
  sourceBindingSha256,
  manifestSha256,
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  freshInstall,
  auth: "X-Addon-Token",
  workspaceBound: true,
  tokenIncluded: false,
  coverage: {
    mode: "exact_endpoint_per_scope_fresh_install",
    perScopeNecessity: "platform_resource_action_contract",
    platformContract: {
      source: CLOCKIFY_SCOPE_ENFORCEMENT_SOURCE,
      sha256: CLOCKIFY_SCOPE_ENFORCEMENT_SHA256,
    },
  },
  results,
  auditHost,
};
if (failures.length > 0) {
  console.error(`Fresh-install aggregate scope/AUDIT probe failed for: ${failures.map(({ key }) => key).join(", ")}`);
  process.exit(1);
}
writeScopeProbeArtifacts(artifactPaths, {
  scopeEvidence: evidence,
  deployedManifest,
  remoteVerification,
});
console.log(`Fresh-install exact endpoint-per-scope/AUDIT probe passed: ${results.length}/${results.length} retained scopes plus AUDIT host.`);
