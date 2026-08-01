import { describe, expect, it } from "vitest";

import {
  runSecurePrivateProduction,
  type SecurePerformanceChildLauncher,
  type SecurePerformanceFetch,
} from "../../scripts/performance/run-private-production-secure.js";

const SHA = "a".repeat(40);
const BUILD = "b".repeat(64);
const SERVER_ARTIFACT = "c".repeat(64);
const PRODUCTION_ORIGIN = "https://ai-assistant-production-c2e6.up.railway.app";

type FakeResponse = {
  status: number;
  ok: boolean;
  text(): Promise<string>;
};

function response(status: number, body: unknown): FakeResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => text,
  };
}

function environment(): Record<string, string> {
  return {
    PATH: "/node22/bin:/usr/bin:/bin",
    HOME: "/Users/operator",
    LIVE_CLOCKIFY: "1",
    LIVE_PERFORMANCE: "1",
    LIVE_SACRIFICIAL_WORKSPACE: "1",
    LIVE_RELEASE_SHA: SHA,
    LIVE_RELEASE_BUILD_HASH: BUILD,
    LIVE_WORKSPACE_ID: "workspace-secret-id",
    PERF_EVIDENCE_DIR: "/tmp/private-performance",
  };
}

function deployedVersion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "1.0.0",
    releaseSha: SHA,
    buildHash: BUILD,
    serverArtifactSha256: SERVER_ARTIFACT,
    sourceRelationship: "exact_head",
    sourceBindingSha256: null,
    ...overrides,
  };
}

describe("secure private-production performance launcher", () => {
  it("mints an admin credential in memory and places the component URL only in the child environment", async () => {
    const addonCredential = "installation-secret-credential";
    const adminCredential = "admin-secret-credential";
    const adminIdentifier = "admin-secret-id";
    const workspaceIdentifier = "workspace-secret-id";
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const replies = [
      response(200, deployedVersion()),
      response(200, [{
        id: adminIdentifier,
        memberships: [{
          targetId: workspaceIdentifier,
          membershipType: "WORKSPACE",
          membershipStatus: "ACTIVE",
        }],
        roles: [{ role: "WORKSPACE_OWN", entityId: workspaceIdentifier }],
      }]),
      response(200, JSON.stringify(adminCredential)),
    ];
    const fetchImpl: SecurePerformanceFetch = async (url, init) => {
      requests.push({ url: String(url), init });
      return replies.shift()!;
    };
    let child: Parameters<SecurePerformanceChildLauncher>[0] | undefined;
    const launchChild: SecurePerformanceChildLauncher = async (input) => {
      child = input;
      return 0;
    };

    await expect(runSecurePrivateProduction({
      addonBaseUrl: PRODUCTION_ORIGIN,
      backendUrl: "https://developer.clockify.me/api",
      workspaceId: workspaceIdentifier,
      addonCredential,
      parentEnvironment: environment(),
      gitHead: SHA,
      worktreeRoot: "/repo",
      productVersionResolver: () => "1.0.0",
      nodeExecutable: "/node22/bin/node",
      fetchImpl,
      launchChild,
    })).resolves.toBe(0);

    expect(requests).toHaveLength(3);
    expect(requests[0]?.url).toBe(`${PRODUCTION_ORIGIN}/version`);
    expect(requests[0]?.init).toMatchObject({ method: "GET", redirect: "error" });
    expect(requests[0]?.init?.headers).not.toHaveProperty("X-Addon-Token");
    expect(requests[1]?.init?.headers).toMatchObject({ "X-Addon-Token": addonCredential });
    expect(requests[2]?.url).toContain(`/addon/user/${adminIdentifier}/token`);
    expect(child).toBeDefined();
    expect(child?.command).toBe("/node22/bin/node");
    expect(child?.args).toEqual(["--import", "tsx", "/repo/scripts/performance/private-production-gate.ts"]);
    expect(child?.environment.LIVE_COMPONENT_URL).toContain("/component/assistant?auth_token=");
    expect(child?.environment.LIVE_COMPONENT_URL).toContain(encodeURIComponent(adminCredential));
    expect(child?.environment).not.toHaveProperty("LIVE_ADDON_TOKEN");
    expect(child?.environment).not.toHaveProperty("LIVE_BACKEND_URL");
    expect(child?.environment).not.toHaveProperty("LIVE_ADDON_BASE_URL");
    const processMetadata = JSON.stringify({ command: child?.command, args: child?.args });
    for (const forbidden of [addonCredential, adminCredential, adminIdentifier, workspaceIdentifier, "auth_token"] as const) {
      expect(processMetadata).not.toContain(forbidden);
    }
  });

  it("fails closed without an explicit active admin or when exchange fails, without launching a child", async () => {
    let launches = 0;
    const launchChild: SecurePerformanceChildLauncher = async () => {
      launches += 1;
      return 0;
    };
    const base = {
      addonBaseUrl: PRODUCTION_ORIGIN,
      backendUrl: "https://developer.clockify.me/api",
      workspaceId: "workspace-secret-id",
      addonCredential: "installation-secret-credential",
      parentEnvironment: environment(),
      gitHead: SHA,
      worktreeRoot: "/repo",
      productVersionResolver: () => "1.0.0",
      launchChild,
    };
    await expect(runSecurePrivateProduction({
      ...base,
      fetchImpl: async (url) => String(url).endsWith("/version")
        ? response(200, deployedVersion())
        : response(200, [{ id: "member", status: "ACTIVE", role: "MEMBER" }]),
    })).rejects.toThrow(/^private_production_secure_launch_failed$/u);

    const replies = [
      response(200, deployedVersion()),
      response(200, [{ id: "admin", status: "ACTIVE", role: "ADMIN" }]),
      response(401, "denied"),
    ];
    await expect(runSecurePrivateProduction({
      ...base,
      fetchImpl: async () => replies.shift()!,
    })).rejects.toThrow(/^private_production_secure_launch_failed$/u);
    expect(launches).toBe(0);
  });

  it.each([
    "https://assistant.example.test",
    "https://attacker-production.up.railway.app",
    `${PRODUCTION_ORIGIN}:443`,
    `${PRODUCTION_ORIGIN}:8443`,
    `${PRODUCTION_ORIGIN}/preview`,
    `${PRODUCTION_ORIGIN}?target=preview`,
    `${PRODUCTION_ORIGIN}#preview`,
    "https://operator@ai-assistant-production-c2e6.up.railway.app",
  ])("rejects an untrusted or non-root production origin before any request or child launch: %s", async (addonBaseUrl) => {
    let requests = 0;
    let launches = 0;
    await expect(runSecurePrivateProduction({
      addonBaseUrl,
      backendUrl: "https://developer.clockify.me/api",
      workspaceId: "workspace-secret-id",
      addonCredential: "installation-secret-credential",
      parentEnvironment: environment(),
      gitHead: SHA,
      worktreeRoot: "/repo",
      productVersionResolver: () => "1.0.0",
      fetchImpl: async () => {
        requests += 1;
        return response(200, deployedVersion());
      },
      launchChild: async () => {
        launches += 1;
        return 0;
      },
    })).rejects.toThrow(/^private_production_secure_launch_failed$/u);
    expect(requests).toBe(0);
    expect(launches).toBe(0);
  });

  it("preflights exact deployed identity without credentials before any Clockify request or child launch", async () => {
    const addonCredential = "installation-secret-credential";
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let launches = 0;
    await expect(runSecurePrivateProduction({
      addonBaseUrl: PRODUCTION_ORIGIN,
      backendUrl: "https://developer.clockify.me/api",
      workspaceId: "workspace-secret-id",
      addonCredential,
      parentEnvironment: environment(),
      gitHead: SHA,
      worktreeRoot: "/repo",
      productVersionResolver: () => "1.0.0",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return response(200, deployedVersion({ releaseSha: "9".repeat(40) }));
      },
      launchChild: async () => {
        launches += 1;
        return 0;
      },
    })).rejects.toThrow(/^private_production_secure_launch_failed$/u);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${PRODUCTION_ORIGIN}/version`);
    expect(requests[0]?.init).toMatchObject({ method: "GET", redirect: "error" });
    expect(JSON.stringify(requests[0]?.init?.headers)).not.toContain(addonCredential);
    expect(launches).toBe(0);
  });
});
