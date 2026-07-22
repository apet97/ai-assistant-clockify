import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  adapterEndpointKey,
  adapterRequestShapeKey,
  correlateAdapterEndpointPaths,
  extractAdapterEndpoints,
} from "../../scripts/lib/adapter-endpoints.js";

const fixtureRoots: string[] = [];

interface FixtureModule {
  sourceModule: string;
  lines: readonly string[];
}

function fixtureRepositoryFrom(modules: readonly FixtureModule[]): string {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "adapter-endpoints-"));
  fixtureRoots.push(repositoryRoot);
  const restRoot = join(repositoryRoot, "src/clockify/rest");
  mkdirSync(restRoot, { recursive: true });
  for (const module of modules) {
    writeFileSync(join(restRoot, module.sourceModule), module.lines.join("\n"));
  }
  return repositoryRoot;
}

function fixtureRepository(): string {
  return fixtureRepositoryFrom([
    {
      sourceModule: "alpha.ts",
      lines: [
        "const ws = `/workspaces/${workspaceId}`;",
        'core.call("api", "GET", `${ws}/projects/${projectId}?archived=true`);',
        'core.paginate("api", `${ws}/clients`);',
        'core.paginateEnvelope("api", `${ws}/expenses`, "expenses.expenses");',
        'core.postQuery("reports", `${ws}/reports/detailed`, body);',
        'core.mutate("api", "POST", `${ws}/projects`, body);',
      ],
    },
    {
      sourceModule: "beta.ts",
      lines: [
        "const ws = `/workspaces/${workspaceId}`;",
        'core.call("api", "GET", `${ws}/projects/${projectId}`);',
      ],
    },
  ]);
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

  it("keeps duplicate call sites and literal control-flow branches distinct in stable order", () => {
    const endpoints = extractAdapterEndpoints(fixtureRepositoryFrom([
      {
        sourceModule: "branch.ts",
        lines: [
          "const ws = `/workspaces/${workspaceId}`;",
          'if (rateKind === "cost") {',
          '  core.call("api", "GET", `${ws}/projects/${projectId}/cost-rate`);',
          "} else {",
          '  core.call("api", "GET", `${ws}/projects/${projectId}/hourly-rate`);',
          "}",
        ],
      },
      {
        sourceModule: "duplicate.ts",
        lines: [
          "const ws = `/workspaces/${workspaceId}`;",
          'core.call("api", "GET", `${ws}/projects/${projectId}`);',
          'core.call("api", "GET", `${ws}/projects/${projectId}`);',
        ],
      },
    ]));

    expect(endpoints.map(({ sourceModule, sourceLine, rawPath }) =>
      [sourceModule, sourceLine, rawPath])).toEqual([
      ["branch.ts", 3, "/workspaces/{workspaceId}/projects/{projectId}/cost-rate"],
      ["branch.ts", 5, "/workspaces/{workspaceId}/projects/{projectId}/hourly-rate"],
      ["duplicate.ts", 2, "/workspaces/{workspaceId}/projects/{projectId}"],
      ["duplicate.ts", 3, "/workspaces/{workspaceId}/projects/{projectId}"],
    ]);

    const duplicates = endpoints.filter(({ sourceModule }) => sourceModule === "duplicate.ts");
    const [first, second] = duplicates;
    if (!first || !second) throw new Error("duplicate fixture call sites were not extracted");
    expect(adapterEndpointKey(first)).not.toBe(adapterEndpointKey(second));
    expect(adapterRequestShapeKey(first)).toBe(adapterRequestShapeKey(second));
  });

  it("classifies every RestCore pagination variant", () => {
    const endpoints = extractAdapterEndpoints(fixtureRepositoryFrom([
      {
        sourceModule: "pagination.ts",
        lines: [
          "const ws = `/workspaces/${workspaceId}`;",
          'core.getBinary("api", `${ws}/binary`);',
          'core.call("api", "GET", `${ws}/call`);',
          'core.mutate("api", "POST", `${ws}/mutation`, body);',
          'core.paginateEnvelope("api", `${ws}/paginated-envelope`, "items");',
          'core.paginate("api", `${ws}/paginated-plain`);',
          'core.call("api", "GET", `${ws}/shared`);',
          'core.paginate("api", `${ws}/shared`);',
          'core.postQuery("reports", `${ws}/search`, body);',
        ],
      },
    ]));

    expect(endpoints.map(({ access, host, method, rawPath, pagination }) =>
      [access, host, method, rawPath, pagination])).toEqual([
      ["read", "api", "GET", "/workspaces/{workspaceId}/binary", "none"],
      ["read", "api", "GET", "/workspaces/{workspaceId}/call", "none"],
      ["read", "api", "GET", "/workspaces/{workspaceId}/paginated-envelope", "envelope"],
      ["read", "api", "GET", "/workspaces/{workspaceId}/paginated-plain", "plain"],
      ["read", "api", "GET", "/workspaces/{workspaceId}/shared", "none"],
      ["read", "api", "GET", "/workspaces/{workspaceId}/shared", "plain"],
      ["write", "api", "POST", "/workspaces/{workspaceId}/mutation", "none"],
      ["read", "reports", "POST", "/workspaces/{workspaceId}/search", "none"],
    ]);
  });
});
