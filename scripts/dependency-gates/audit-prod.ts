import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { inspectProductionAudit } from "./audit.js";

const repositoryRoot = new URL("../../", import.meta.url);

try {
  const result = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
    cwd: fileURLToPath(repositoryRoot),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.signal !== null) throw new Error(`npm audit terminated by ${result.signal}`);

  const allowlist = JSON.parse(readFileSync(
    new URL("config/dependency-gates/audit-allowlist.json", repositoryRoot),
    "utf8",
  )) as unknown;
  const report = inspectProductionAudit(result.stdout, allowlist, new Date());
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`audit:prod failed: ${message}\n`);
  process.exitCode = 1;
}
