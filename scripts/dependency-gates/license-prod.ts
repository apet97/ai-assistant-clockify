import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { inspectProductionLicenses } from "./license.js";

const repositoryRoot = new URL("../../", import.meta.url);
const reportDirectory = new URL("evidence/dependency-gates/", repositoryRoot);
const reportUrl = new URL("production-licenses.json", reportDirectory);
const temporaryReportUrl = new URL("production-licenses.json.tmp", reportDirectory);
const failureReport = {
  schemaVersion: 1,
  passed: false,
  packages: [],
  blockingPackages: [],
  summary: { allowed: 0, exceptions: 0, blocked: 0 },
  failure: { code: "license_gate_failed" },
} as const;

function writeEvidence(serialized: string): void {
  mkdirSync(reportDirectory, { recursive: true });
  writeFileSync(temporaryReportUrl, serialized, "utf8");
  renameSync(temporaryReportUrl, reportUrl);
}

function removeEvidence(): void {
  rmSync(temporaryReportUrl, { force: true });
  rmSync(reportUrl, { force: true });
}

try {
  mkdirSync(reportDirectory, { recursive: true });
  removeEvidence();
  const result = spawnSync("npm", ["ls", "--omit=dev", "--all", "--json", "--long"], {
    cwd: fileURLToPath(repositoryRoot),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm ls failed with exit code ${String(result.status)}: ${result.stderr.trim()}`);
  }

  const exceptions = JSON.parse(readFileSync(
    new URL("config/dependency-gates/license-exceptions.json", repositoryRoot),
    "utf8",
  )) as unknown;
  const report = inspectProductionLicenses(result.stdout, exceptions, new Date());
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  writeEvidence(serialized);
  process.stdout.write(serialized);
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const serialized = `${JSON.stringify(failureReport, null, 2)}\n`;
  try {
    writeEvidence(serialized);
  } catch {
    try {
      removeEvidence();
    } catch {
      // A filesystem failure is already fatal; do not mask the original gate error.
    }
  }
  process.stdout.write(serialized);
  process.stderr.write(`license:prod failed: ${message}\n`);
  process.exitCode = 1;
}
