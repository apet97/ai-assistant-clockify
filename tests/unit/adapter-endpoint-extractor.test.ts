import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  adapterEndpointKey,
  correlateAdapterEndpointPaths,
  extractAdapterEndpoints,
} from "../../scripts/lib/adapter-endpoints.js";

const fixtureRoots: string[] = [];

function fixtureRepository(): string {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "adapter-endpoints-"));
  fixtureRoots.push(repositoryRoot);
  const restRoot = join(repositoryRoot, "src/clockify/rest");
  mkdirSync(restRoot, { recursive: true });
  writeFileSync(join(restRoot, "alpha.ts"), [
    "const ws = `/workspaces/${workspaceId}`;",
    'core.call("api", "GET", `${ws}/projects/${projectId}?archived=true`);',
    'core.paginate("api", `${ws}/clients`);',
    'core.paginateEnvelope("api", `${ws}/expenses`, "expenses.expenses");',
    'core.postQuery("reports", `${ws}/reports/detailed`, body);',
    'core.mutate("api", "POST", `${ws}/projects`, body);',
  ].join("\n"));
  writeFileSync(join(restRoot, "beta.ts"), [
    "const ws = `/workspaces/${workspaceId}`;",
    'core.call("api", "GET", `${ws}/projects/${projectId}`);',
  ].join("\n"));
  return repositoryRoot;
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("raw adapter endpoint extraction", () => {
  it("retains wire shape, source identity, and pagination form", () => {
    const endpoints = extractAdapterEndpoints(fixtureRepository());

    expect(endpoints).toEqual([
      expect.objectContaining({
        access: "read",
        host: "api",
        method: "GET",
        rawPath: "/workspaces/{workspaceId}/clients",
        sourceModule: "alpha.ts",
        sourceLine: 3,
        pagination: "plain",
      }),
      expect.objectContaining({
        access: "read",
        host: "api",
        method: "GET",
        rawPath: "/workspaces/{workspaceId}/expenses",
        sourceModule: "alpha.ts",
        sourceLine: 4,
        pagination: "envelope",
      }),
      expect.objectContaining({
        access: "read",
        host: "api",
        method: "GET",
        rawPath: "/workspaces/{workspaceId}/projects/{projectId}",
        sourceModule: "alpha.ts",
        sourceLine: 2,
        pagination: "none",
      }),
      expect.objectContaining({
        access: "write",
        host: "api",
        method: "POST",
        rawPath: "/workspaces/{workspaceId}/projects",
        sourceModule: "alpha.ts",
        sourceLine: 6,
        pagination: "none",
      }),
      expect.objectContaining({
        access: "read",
        host: "reports",
        method: "POST",
        rawPath: "/workspaces/{workspaceId}/reports/detailed",
        sourceModule: "alpha.ts",
        sourceLine: 5,
        pagination: "none",
      }),
      expect.objectContaining({
        access: "read",
        host: "api",
        method: "GET",
        rawPath: "/workspaces/{workspaceId}/projects/{projectId}",
        sourceModule: "beta.ts",
        sourceLine: 2,
        pagination: "none",
      }),
    ]);

    const duplicatePath = endpoints.filter(({ rawPath }) =>
      rawPath === "/workspaces/{workspaceId}/projects/{projectId}");
    expect(duplicatePath).toHaveLength(2);
    const [alpha, beta] = duplicatePath;
    if (!alpha || !beta) throw new Error("fixture endpoints were not extracted");
    expect(adapterEndpointKey(alpha)).not.toBe(adapterEndpointKey(beta));
  });

  it("keeps future correlation transforms pure and separate from raw paths", () => {
    const rawPath = "/workspaces/{workspaceId}/projects/{kind}";

    const correlated = correlateAdapterEndpointPaths(
      rawPath,
      (path) => path.replace("{workspaceId}", "{workspace}"),
      (path) => [path.replace("{kind}", "hourly-rate"), path.replace("{kind}", "cost-rate")],
    );

    expect(correlated).toEqual([
      "/workspaces/{workspace}/projects/cost-rate",
      "/workspaces/{workspace}/projects/hourly-rate",
    ]);
    expect(rawPath).toBe("/workspaces/{workspaceId}/projects/{kind}");
  });
});
