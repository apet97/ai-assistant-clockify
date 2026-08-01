/**
 * Prove the deployed embedded component denies a real active workspace member.
 *
 * The installation credential, selected member id, exchanged user credential,
 * URLs, headers, and response bodies stay in memory only. The sole persisted
 * result is the strict, identifier-free MemberDenialEvidence contract.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveClockifyApiBase } from "../src/clockify/api-base.js";
import { validateClockifyServiceUrl } from "../src/clockify/service-url.js";
import { privateProductionRailwayOrigin } from "./lib/private-production-origin.js";
import { candidateProductVersion } from "./lib/candidate-product-version.js";
import {
  type LiveEvidenceSource,
  type MemberDenialEvidence,
} from "./evidence/live-browser-acceptance.js";

const MAX_VERSION_BYTES = 65_536;
const MAX_USERS_BYTES = 2 * 1_048_576;
const MAX_CREDENTIAL_BYTES = 16_384;
const MAX_COMPONENT_BYTES = 65_536;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MEMBER_ROLE_PATTERN = /^(?:MEMBER|USER|REGULAR|WORKSPACE_MEMBER|WORKSPACE_USER)$/u;
const ADMIN_ROLE_PATTERN = /(?:^|_)(?:ADMIN|ADMINISTRATOR|OWN|OWNER)$/u;

type JsonObject = Record<string, unknown>;

export interface MemberDenialProbeResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type MemberDenialProbeFetch = (
  url: string | URL,
  init?: RequestInit,
) => Promise<MemberDenialProbeResponse>;

export interface MemberDenialProbeInput {
  addonBaseUrl: string;
  backendUrl: string;
  workspaceId: string;
  addonCredential: string;
  expectedSource: LiveEvidenceSource;
  /** The product version `expectedSource.commitSha` declares. Supplied rather
   * than hardcoded so the v1 rollback candidate (1.0.0) and the v2 candidate
   * (2.0.0) are both validated correctly — see
   * `scripts/lib/candidate-product-version.ts`. It is deliberately NOT a field
   * on `LiveEvidenceSource`: that shape is recorded in immutable v1 evidence
   * artifacts and its schema must not change. */
  expectedProductVersion: string;
  now?: () => Date;
  fetchImpl?: MemberDenialProbeFetch;
}

function fail(): never {
  throw new Error("member_denial_probe_failed");
}

function isProductVersion(value: unknown): boolean {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/u.test(value);
}

function addonBase(raw: string): URL {
  return privateProductionRailwayOrigin(raw) ?? fail();
}

function clockifyBackend(raw: string): URL {
  try {
    return validateClockifyServiceUrl(raw, "api");
  } catch {
    return fail();
  }
}

function sourceMatches(actual: unknown, expected: LiveEvidenceSource, expectedVersion: string): boolean {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const row = actual as JsonObject;
  return row.version === expectedVersion
    && row.releaseSha === expected.commitSha
    && row.buildHash === expected.releaseBuildHash
    && row.serverArtifactSha256 === expected.serverArtifactSha256
    && row.sourceRelationship === expected.sourceRelationship
    && row.sourceBindingSha256 === expected.sourceBindingSha256;
}

async function boundedText(
  fetchImpl: MemberDenialProbeFetch,
  url: URL,
  init: RequestInit,
  maximumBytes: number,
): Promise<{ response: MemberDenialProbeResponse; text: string }> {
  const response = await fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maximumBytes) return fail();
  return { response, text };
}

function json(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fail();
  }
}

function roleValue(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.trim().toUpperCase();
}

function scopedRole(row: JsonObject, workspaceId: string): string | undefined {
  const topLevel = roleValue(row.role);
  if (topLevel !== undefined) return topLevel;
  if (!Array.isArray(row.roles)) return undefined;
  const roles = row.roles.filter(
    (value): value is JsonObject => Boolean(value) && typeof value === "object" && !Array.isArray(value),
  );
  const scoped = roles.find((entry) => {
    if (entry.entityId === workspaceId) return true;
    if (entry.entity && typeof entry.entity === "object" && !Array.isArray(entry.entity)) {
      const entity = entry.entity as JsonObject;
      if (entity.id === workspaceId || roleValue(entity.type) === "WORKSPACE") return true;
    }
    if (Array.isArray(entry.entities) && entry.entities.some(
      (entity) => Boolean(entity) && typeof entity === "object" && !Array.isArray(entity)
        && (entity as JsonObject).id === workspaceId,
    )) return true;
    return roleValue(entry.sourceType) === "WORKSPACE";
  });
  if (!scoped) return undefined;
  return roleValue(scoped.role ?? scoped.name ?? scoped.formatterRoleName);
}

function activeWorkspaceMembership(row: JsonObject, workspaceId: string): boolean {
  const topLevel = roleValue(row.status);
  if (topLevel !== undefined) return topLevel === "ACTIVE";
  if (!Array.isArray(row.memberships)) return false;
  return row.memberships.some((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const membership = value as JsonObject;
    return membership.targetId === workspaceId
      && roleValue(membership.membershipType) === "WORKSPACE"
      && roleValue(membership.membershipStatus) === "ACTIVE";
  });
}

function explicitActiveMember(rows: unknown, workspaceId: string): string {
  if (!Array.isArray(rows)) return fail();
  for (const value of rows) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as JsonObject;
    if (typeof row.id !== "string" || row.id === "" || !activeWorkspaceMembership(row, workspaceId)) continue;
    const role = scopedRole(row, workspaceId);
    if (role && MEMBER_ROLE_PATTERN.test(role) && !ADMIN_ROLE_PATTERN.test(role)) return row.id;
    if (row.role === undefined && Array.isArray(row.roles) && row.roles.length === 0) return row.id;
  }
  return fail();
}

function exchangedCredential(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return fail();
  if (trimmed.startsWith("\"")) {
    const parsed = json(trimmed);
    if (typeof parsed !== "string" || parsed.trim() === "") return fail();
    return parsed.trim();
  }
  if (/\s/u.test(trimmed)) return fail();
  return trimmed;
}

export async function runMemberDenialProbe(input: MemberDenialProbeInput): Promise<MemberDenialEvidence> {
  try {
    if (
      input.workspaceId.trim() === ""
      || input.addonCredential.trim() === ""
      || !isProductVersion(input.expectedProductVersion)
      || !SHA_PATTERN.test(input.expectedSource.commitSha)
      || !SHA256_PATTERN.test(input.expectedSource.releaseBuildHash)
      || !SHA256_PATTERN.test(input.expectedSource.serverArtifactSha256)
      || (input.expectedSource.sourceRelationship === "source_bound_builder"
        ? typeof input.expectedSource.sourceBindingSha256 !== "string"
          || !SHA256_PATTERN.test(input.expectedSource.sourceBindingSha256)
        : input.expectedSource.sourceBindingSha256 !== null)
    ) return fail();

    const fetchImpl = input.fetchImpl ?? (fetch as unknown as MemberDenialProbeFetch);
    const componentBase = addonBase(input.addonBaseUrl);
    const backend = clockifyBackend(input.backendUrl);
    const apiBase = resolveClockifyApiBase({ backendUrl: backend.toString() });

    const deployed = await boundedText(
      fetchImpl,
      new URL("version", componentBase),
      { method: "GET", headers: { accept: "application/json" }, redirect: "error" },
      MAX_VERSION_BYTES,
    );
    if (
      !deployed.response.ok
      || !sourceMatches(json(deployed.text), input.expectedSource, input.expectedProductVersion)
    ) return fail();

    const query = new URLSearchParams({
      page: "1",
      "page-size": "5000",
      memberships: "WORKSPACE",
      "include-roles": "true",
    });
    const usersUrl = new URL(
      `${apiBase}/workspaces/${encodeURIComponent(input.workspaceId)}/users?${query.toString()}`,
    );
    const users = await boundedText(fetchImpl, usersUrl, {
      method: "GET",
      headers: { accept: "application/json", "X-Addon-Token": input.addonCredential },
      redirect: "error",
    }, MAX_USERS_BYTES);
    if (!users.response.ok) return fail();
    const memberId = explicitActiveMember(json(users.text), input.workspaceId);

    const exchangeRoot = `${backend.origin}${backend.pathname === "/" ? "/api" : backend.pathname}`.replace(/\/+$/u, "");
    const exchange = await boundedText(
      fetchImpl,
      new URL(`${exchangeRoot}/addon/user/${encodeURIComponent(memberId)}/token`),
      {
        method: "POST",
        headers: {
          accept: "application/json, text/plain",
          "content-type": "application/json",
          "X-Addon-Token": input.addonCredential,
        },
        redirect: "error",
      },
      MAX_CREDENTIAL_BYTES,
    );
    if (!exchange.response.ok) return fail();
    const memberCredential = exchangedCredential(exchange.text);

    const componentUrl = new URL("component/assistant", componentBase);
    componentUrl.searchParams.set("auth_token", memberCredential);
    const component = await boundedText(fetchImpl, componentUrl, {
      method: "GET",
      headers: { accept: "text/html" },
      redirect: "manual",
    }, MAX_COMPONENT_BYTES);
    const sessionCookieIssued = component.response.headers.get("set-cookie") !== null;
    const adminOnlyResponse = /admins?\s+and\s+owners?\s+only/iu.test(component.text);
    if (component.response.status !== 403 || sessionCookieIssued || !adminOnlyResponse) return fail();

    return {
      schemaVersion: 1,
      kind: "production_member_denial",
      conclusion: "passed",
      source: input.expectedSource,
      observedAt: (input.now ?? (() => new Date()))().toISOString(),
      role: "MEMBER",
      authorityPath: "verified_installation_to_member_exchange",
      componentStatus: 403,
      sessionCookieIssued: false,
      adminOnlyResponse: true,
    };
  } catch {
    return fail();
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) return fail();
  return value;
}

function releaseArchiveHash(cwd: string, releaseSha: string): string {
  const archive = execFileSync("git", ["archive", "--format=tar", releaseSha], {
    cwd,
    encoding: "buffer",
    maxBuffer: 128 * 1024 * 1024,
  });
  return createHash("sha256").update(archive).digest("hex");
}

function deployedSource(
  value: unknown,
  releaseSha: string,
  buildHash: string,
  expectedVersion: string,
): LiveEvidenceSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const row = value as JsonObject;
  const relationship = row.sourceRelationship;
  const binding = row.sourceBindingSha256;
  if (
    row.version !== expectedVersion
    || row.releaseSha !== releaseSha
    || row.buildHash !== buildHash
    || typeof row.serverArtifactSha256 !== "string"
    || !SHA256_PATTERN.test(row.serverArtifactSha256)
    || (relationship !== "exact_head" && relationship !== "evidence_descendant" && relationship !== "source_bound_builder")
    || (relationship === "source_bound_builder"
      ? typeof binding !== "string" || !SHA256_PATTERN.test(binding)
      : binding !== null)
  ) return fail();
  return {
    commitSha: releaseSha,
    releaseBuildHash: buildHash,
    serverArtifactSha256: row.serverArtifactSha256,
    sourceRelationship: relationship,
    sourceBindingSha256: relationship === "source_bound_builder" ? binding as string : null,
  };
}

async function fetchDeployedSource(
  addonBaseUrl: string,
  releaseSha: string,
  buildHash: string,
  expectedVersion: string,
): Promise<LiveEvidenceSource> {
  const result = await boundedText(
    fetch as unknown as MemberDenialProbeFetch,
    new URL("version", addonBase(addonBaseUrl)),
    { method: "GET", headers: { accept: "application/json" }, redirect: "error" },
    MAX_VERSION_BYTES,
  );
  if (!result.response.ok) return fail();
  return deployedSource(json(result.text), releaseSha, buildHash, expectedVersion);
}

function writeEvidence(path: string, evidence: MemberDenialEvidence): void {
  const absolute = resolve(path);
  if (existsSync(absolute)) {
    const info = lstatSync(absolute);
    if (!info.isFile() || info.isSymbolicLink()) return fail();
  }
  mkdirSync(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, absolute);
}

async function main(): Promise<void> {
  if (
    process.versions.node.split(".")[0] !== "22"
    || process.env.LIVE_CLOCKIFY !== "1"
    || process.env.LIVE_MEMBER_DENIAL !== "1"
    || process.env.LIVE_SACRIFICIAL_WORKSPACE !== "1"
  ) return fail();
  const cwd = process.cwd();
  const releaseSha = required("LIVE_RELEASE_SHA");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  if (!SHA_PATTERN.test(releaseSha) || releaseSha !== head) return fail();
  if (execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd, encoding: "utf8" }).trim() !== "") {
    return fail();
  }
  const releaseBuildHash = releaseArchiveHash(cwd, releaseSha);
  // From the candidate commit, never the checkout: a v1 rollback attests 1.0.0
  // and a v2 deploy attests 2.0.0, and the probe must accept exactly one.
  const expectedProductVersion = candidateProductVersion(releaseSha, cwd);
  const addonBaseUrl = process.env.LIVE_ADDON_BASE_URL ?? process.env.BASE_URL ?? "";
  const expectedSource = await fetchDeployedSource(
    addonBaseUrl,
    releaseSha,
    releaseBuildHash,
    expectedProductVersion,
  );
  const evidence = await runMemberDenialProbe({
    addonBaseUrl,
    backendUrl: required("LIVE_BACKEND_URL"),
    workspaceId: required("LIVE_WORKSPACE_ID"),
    addonCredential: required("LIVE_ADDON_TOKEN"),
    expectedSource,
    expectedProductVersion,
  });
  writeEvidence(required("MEMBER_DENIAL_EVIDENCE_PATH"), evidence);
  process.stdout.write("Member-denial evidence passed.\n");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    process.stderr.write("Member-denial evidence failed.\n");
    process.exitCode = 1;
  });
}
