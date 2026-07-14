import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { inspectProductionLicenses } from "../../scripts/dependency-gates/license.js";

const NOW = new Date("2026-07-14T12:00:00.000Z");

const emptyExceptions = (): unknown => ({
  version: 1,
  entries: [],
});

interface FixturePackage {
  name: string;
  version: string;
  license?: string;
  dependencies?: Record<string, FixturePackage>;
}

const productionTree = (dependencies: Record<string, FixturePackage>): string => JSON.stringify({
  name: "fixture-app",
  version: "1.0.0",
  path: "/ignored/repository/path",
  dependencies,
});

describe("production license gate", () => {
  it("atomically replaces stale passing evidence with deterministic failure evidence", () => {
    const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
    const reportPath = join(repositoryRoot, "evidence/dependency-gates/production-licenses.json");
    const originalReport = readFileSync(reportPath, "utf8");
    const tempRoot = mkdtempSync(join(tmpdir(), "license-prod-entrypoint-"));
    const fakeNpm = join(tempRoot, "bin", "npm");
    mkdirSync(dirname(fakeNpm), { recursive: true });
    writeFileSync(fakeNpm, "#!/bin/sh\nprintf 'dependency tree unavailable\\n' >&2\nexit 1\n", "utf8");
    chmodSync(fakeNpm, 0o755);

    const runEntrypoint = (): string => {
      const result = spawnSync(
        process.execPath,
        ["node_modules/tsx/dist/cli.mjs", "scripts/dependency-gates/license-prod.ts"],
        {
          cwd: repositoryRoot,
          env: { ...process.env, PATH: `${dirname(fakeNpm)}:${process.env.PATH ?? ""}` },
          encoding: "utf8",
        },
      );
      expect(result.status, result.stderr).toBe(1);
      return readFileSync(reportPath, "utf8");
    };

    try {
      writeFileSync(reportPath, JSON.stringify({ passed: true, stale: true }), "utf8");
      const firstFailure = runEntrypoint();
      const secondFailure = runEntrypoint();

      expect(JSON.parse(firstFailure)).toEqual({
        schemaVersion: 1,
        passed: false,
        packages: [],
        blockingPackages: [],
        summary: { allowed: 0, exceptions: 0, blocked: 0 },
        failure: { code: "license_gate_failed" },
      });
      expect(secondFailure).toBe(firstFailure);
      expect(firstFailure).not.toContain(repositoryRoot);
      expect(firstFailure).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(existsSync(`${reportPath}.tmp`)).toBe(false);
    } finally {
      writeFileSync(reportPath, originalReport, "utf8");
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it.each([
    [undefined, "UNKNOWN"],
    ["MIT AND", "MIT AND"],
  ])("rejects an unknown or unparseable license %#", (license, reportedLicense) => {
    const report = inspectProductionLicenses(productionTree({
      mystery: {
        name: "mystery",
        version: "1.0.0",
        ...(license === undefined ? {} : { license }),
      },
    }), emptyExceptions(), NOW);

    expect(report.passed).toBe(false);
    expect(report.blockingPackages).toEqual([expect.objectContaining({
      package: "mystery",
      version: "1.0.0",
      license: reportedLicense,
      reason: "unknown_or_unparseable",
    })]);
  });

  it.each([
    "GPL-3.0-only",
    "GPL-3.0-or-later",
    "AGPL-1.0-only",
    "AGPL-3.0-or-later",
  ])("rejects forbidden production license %s", (license) => {
    const report = inspectProductionLicenses(productionTree({
      copyleft: { name: "copyleft", version: "2.0.0", license },
    }), emptyExceptions(), NOW);

    expect(report.passed).toBe(false);
    expect(report.blockingPackages).toEqual([expect.objectContaining({
      package: "copyleft",
      license,
      reason: "forbidden_license",
    })]);
  });

  it("rejects malformed exception entries", () => {
    const exceptions = {
      version: 1,
      entries: [{
        package: "copyleft",
        license: "GPL-3.0-only",
        owner: "security@example.com",
        justification: "",
        expiry: "2026-08-01",
      }],
    };

    expect(() => inspectProductionLicenses(productionTree({}), exceptions, NOW))
      .toThrow(/malformed license exception/i);
  });

  it("rejects every expired exception, even when it is unused", () => {
    const exceptions = {
      version: 1,
      entries: [{
        package: "copyleft",
        license: "GPL-3.0-only",
        owner: "security@example.com",
        justification: "Approved only until replacement landed",
        expiry: "2026-07-13",
      }],
    };

    expect(() => inspectProductionLicenses(productionTree({}), exceptions, NOW))
      .toThrow(/expired license exception/i);
  });

  it("permits an exact, unexpired exception", () => {
    const exceptions = {
      version: 1,
      entries: [{
        package: "copyleft",
        license: "GPL-3.0-only",
        owner: "security@example.com",
        justification: "Isolated process approved while replacement is tested",
        expiry: "2026-08-01",
      }],
    };
    const report = inspectProductionLicenses(productionTree({
      copyleft: { name: "copyleft", version: "2.0.0", license: "GPL-3.0-only" },
    }), exceptions, NOW);

    expect(report.passed).toBe(true);
    expect(report.blockingPackages).toEqual([]);
    expect(report.packages).toEqual([expect.objectContaining({ status: "exception" })]);
  });

  it("passes and deterministically reports the complete nested production tree", () => {
    const first = inspectProductionLicenses(productionTree({
      zeta: {
        name: "zeta",
        version: "3.0.0",
        license: "MIT",
        dependencies: {
          alpha: { name: "alpha", version: "1.0.0", license: "Apache-2.0" },
        },
      },
      beta: { name: "beta", version: "2.0.0", license: "(MIT OR Apache-2.0)" },
    }), emptyExceptions(), NOW);
    const reordered = inspectProductionLicenses(productionTree({
      beta: { name: "beta", version: "2.0.0", license: "(MIT OR Apache-2.0)" },
      zeta: {
        name: "zeta",
        version: "3.0.0",
        license: "MIT",
        dependencies: {
          alpha: { name: "alpha", version: "1.0.0", license: "Apache-2.0" },
        },
      },
    }), emptyExceptions(), NOW);

    expect(first.passed).toBe(true);
    expect(first.blockingPackages).toEqual([]);
    expect(first.packages.map(({ package: packageName, version, license }) => ({
      package: packageName,
      version,
      license,
    }))).toEqual([
      { package: "alpha", version: "1.0.0", license: "Apache-2.0" },
      { package: "beta", version: "2.0.0", license: "(MIT OR Apache-2.0)" },
      { package: "zeta", version: "3.0.0", license: "MIT" },
    ]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(reordered));
  });
});
