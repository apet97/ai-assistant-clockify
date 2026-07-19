/**
 * Secure launcher for the private-production performance gate.
 *
 * The installation credential is used only by this parent process. A real
 * active admin is selected through Clockify's role-bearing workspace list, a
 * short-lived user credential is exchanged in memory, and the authenticated
 * component URL is supplied only in the performance child's environment. It is
 * never placed in argv, stdout/stderr, a file, the clipboard, or evidence.
 */
import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveClockifyApiBase } from "../../src/clockify/api-base.js";
import { validateClockifyServiceUrl } from "../../src/clockify/service-url.js";
import { privateProductionRailwayOrigin } from "../lib/private-production-origin.js";
import {
  validateDeployedRelease,
  validatePrivateProductionEnvironment,
} from "./private-production-contract.js";

const MAX_VERSION_BYTES = 65_536;
const MAX_USERS_BYTES = 2 * 1_048_576;
const MAX_CREDENTIAL_BYTES = 16_384;
const ADMIN_ROLE_PATTERN = /(?:^|_)(?:ADMIN|ADMINISTRATOR|OWN|OWNER)$/u;
const OWNER_ROLE_PATTERN = /(?:^|_)(?:OWN|OWNER)$/u;

type JsonObject = Record<string, unknown>;

export interface SecurePerformanceResponse {
  status: number;
  ok: boolean;
  text(): Promise<string>;
}

export type SecurePerformanceFetch = (
  url: string | URL,
  init?: RequestInit,
) => Promise<SecurePerformanceResponse>;

export interface SecurePerformanceChildInput {
  command: string;
  args: readonly string[];
  cwd: string;
  environment: Record<string, string>;
}

export type SecurePerformanceChildLauncher = (
  input: SecurePerformanceChildInput,
) => Promise<number>;

export interface SecurePrivateProductionInput {
  addonBaseUrl: string;
  backendUrl: string;
  workspaceId: string;
  addonCredential: string;
  parentEnvironment: Record<string, string | undefined>;
  gitHead: string;
  worktreeRoot: string;
  nodeExecutable?: string;
  fetchImpl?: SecurePerformanceFetch;
  launchChild?: SecurePerformanceChildLauncher;
}

function fail(): never {
  throw new Error("private_production_secure_launch_failed");
}

function addonBase(raw: string): URL {
  return privateProductionRailwayOrigin(raw) ?? fail();
}

function backendUrl(raw: string): URL {
  try {
    return validateClockifyServiceUrl(raw, "api");
  } catch {
    return fail();
  }
}

async function boundedText(
  fetchImpl: SecurePerformanceFetch,
  url: URL,
  init: RequestInit,
  maximumBytes: number,
): Promise<{ response: SecurePerformanceResponse; text: string }> {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maximumBytes) return fail();
  return { response, text };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fail();
  }
}

function normalizedRole(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.trim().toUpperCase();
}

function workspaceRole(row: JsonObject, workspaceId: string): string | undefined {
  const direct = normalizedRole(row.role);
  if (direct !== undefined) return direct;
  if (!Array.isArray(row.roles)) return undefined;
  const roles = row.roles.filter(
    (entry): entry is JsonObject => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
  );
  const scoped = roles.find((entry) => {
    if (entry.entityId === workspaceId) return true;
    if (entry.entity && typeof entry.entity === "object" && !Array.isArray(entry.entity)) {
      const entity = entry.entity as JsonObject;
      if (entity.id === workspaceId || normalizedRole(entity.type) === "WORKSPACE") return true;
    }
    if (Array.isArray(entry.entities) && entry.entities.some(
      (entity) => Boolean(entity) && typeof entity === "object" && !Array.isArray(entity)
        && (entity as JsonObject).id === workspaceId,
    )) return true;
    return normalizedRole(entry.sourceType) === "WORKSPACE";
  });
  return scoped ? normalizedRole(scoped.role ?? scoped.name ?? scoped.formatterRoleName) : undefined;
}

function activeWorkspaceMembership(row: JsonObject, workspaceId: string): boolean {
  const topLevel = normalizedRole(row.status);
  if (topLevel !== undefined) return topLevel === "ACTIVE";
  if (!Array.isArray(row.memberships)) return false;
  return row.memberships.some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const membership = entry as JsonObject;
    return membership.targetId === workspaceId
      && normalizedRole(membership.membershipType) === "WORKSPACE"
      && normalizedRole(membership.membershipStatus) === "ACTIVE";
  });
}

function explicitActiveAdmin(value: unknown, workspaceId: string): string {
  if (!Array.isArray(value)) return fail();
  const candidates = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as JsonObject;
    const role = workspaceRole(row, workspaceId);
    if (
      typeof row.id !== "string"
      || row.id === ""
      || !activeWorkspaceMembership(row, workspaceId)
      || role === undefined
      || !ADMIN_ROLE_PATTERN.test(role)
    ) return [];
    return [{ id: row.id, rank: OWNER_ROLE_PATTERN.test(role) ? 0 : 1 }];
  }).sort((left, right) => left.rank - right.rank);
  return candidates[0]?.id ?? fail();
}

function exchangedCredential(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return fail();
  if (trimmed.startsWith("\"")) {
    const parsed = parseJson(trimmed);
    if (typeof parsed !== "string" || parsed.trim() === "") return fail();
    return parsed.trim();
  }
  if (/\s/u.test(trimmed)) return fail();
  return trimmed;
}

const CHILD_ENVIRONMENT_KEYS = [
  "HOME",
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "CI",
  "PLAYWRIGHT_BROWSERS_PATH",
  "LIVE_CLOCKIFY",
  "LIVE_PERFORMANCE",
  "LIVE_SACRIFICIAL_WORKSPACE",
  "LIVE_RELEASE_SHA",
  "LIVE_RELEASE_BUILD_HASH",
  "LIVE_WORKSPACE_ID",
  "PERF_EVIDENCE_DIR",
] as const;

function childEnvironment(
  parent: Record<string, string | undefined>,
  componentUrl: string,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of CHILD_ENVIRONMENT_KEYS) {
    const value = parent[key];
    if (value !== undefined && value !== "") environment[key] = value;
  }
  environment.LIVE_COMPONENT_URL = componentUrl;
  return environment;
}

const defaultLaunchChild: SecurePerformanceChildLauncher = async (input) => await new Promise<number>((resolveChild, reject) => {
  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    env: input.environment,
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("close", (code, signal) => {
    if (signal !== null || code === null) reject(new Error("child_failed"));
    else resolveChild(code);
  });
});

export async function runSecurePrivateProduction(input: SecurePrivateProductionInput): Promise<number> {
  try {
    if (input.workspaceId.trim() === "" || input.addonCredential.trim() === "") return fail();
    const fetchImpl = input.fetchImpl ?? (fetch as unknown as SecurePerformanceFetch);
    const base = addonBase(input.addonBaseUrl);
    const backend = backendUrl(input.backendUrl);
    const expectedReleaseSha = input.parentEnvironment.LIVE_RELEASE_SHA?.trim() ?? "";
    const expectedBuildHash = input.parentEnvironment.LIVE_RELEASE_BUILD_HASH?.trim() ?? "";
    if (expectedReleaseSha !== input.gitHead) return fail();

    // Authenticate the destination before minting a short-lived admin token.
    // `/version` is public, redirect-blocked, and must identify the exact clean
    // candidate/build. Only after this succeeds may any credential-bearing
    // component URL be constructed or a child process be launched.
    const deployed = await boundedText(
      fetchImpl,
      new URL("version", base),
      { method: "GET", headers: { accept: "application/json" }, redirect: "error" },
      MAX_VERSION_BYTES,
    );
    if (!deployed.response.ok) return fail();
    try {
      validateDeployedRelease(parseJson(deployed.text), input.gitHead, expectedBuildHash);
    } catch {
      return fail();
    }

    const apiBase = resolveClockifyApiBase({ backendUrl: backend.toString() });
    const query = new URLSearchParams({
      page: "1",
      "page-size": "5000",
      memberships: "WORKSPACE",
      "include-roles": "true",
    });
    const users = await boundedText(
      fetchImpl,
      new URL(`${apiBase}/workspaces/${encodeURIComponent(input.workspaceId)}/users?${query.toString()}`),
      {
        method: "GET",
        headers: { accept: "application/json", "X-Addon-Token": input.addonCredential },
        redirect: "error",
      },
      MAX_USERS_BYTES,
    );
    if (!users.response.ok) return fail();
    const adminId = explicitActiveAdmin(parseJson(users.text), input.workspaceId);

    const backendRoot = `${backend.origin}${backend.pathname === "/" ? "/api" : backend.pathname}`.replace(/\/+$/u, "");
    const exchange = await boundedText(
      fetchImpl,
      new URL(`${backendRoot}/addon/user/${encodeURIComponent(adminId)}/token`),
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
    const userCredential = exchangedCredential(exchange.text);
    const component = new URL("component/assistant", base);
    component.searchParams.set("auth_token", userCredential);

    const environment = childEnvironment(input.parentEnvironment, component.toString());
    validatePrivateProductionEnvironment(environment, input.gitHead, input.worktreeRoot);
    const childInput: SecurePerformanceChildInput = {
      command: input.nodeExecutable ?? process.execPath,
      args: ["--import", "tsx", resolve(input.worktreeRoot, "scripts/performance/private-production-gate.ts")],
      cwd: resolve(input.worktreeRoot),
      environment,
    };
    const exitCode = await (input.launchChild ?? defaultLaunchChild)(childInput);
    if (exitCode !== 0) return fail();
    return exitCode;
  } catch {
    return fail();
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) return fail();
  return value;
}

async function main(): Promise<void> {
  if (process.versions.node.split(".")[0] !== "22" || process.env.LIVE_COMPONENT_URL !== undefined) return fail();
  const worktreeRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const gitHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" }).trim() !== "") {
    return fail();
  }
  await runSecurePrivateProduction({
    addonBaseUrl: required("LIVE_ADDON_BASE_URL"),
    backendUrl: required("LIVE_BACKEND_URL"),
    workspaceId: required("LIVE_WORKSPACE_ID"),
    addonCredential: required("LIVE_ADDON_TOKEN"),
    parentEnvironment: process.env,
    gitHead,
    worktreeRoot,
  });
  process.stdout.write("Secure private-production performance gate passed.\n");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    process.stderr.write("Secure private-production performance gate failed.\n");
    process.exitCode = 1;
  });
}
