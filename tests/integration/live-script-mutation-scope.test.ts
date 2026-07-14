import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runLiveScript(
  script: "live-smoke.ts" | "live-sweep.ts",
  extraEnv: Record<string, string> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "live-scope-"));
  roots.push(root);
  const logPath = join(root, "requests.log");
  const evidencePath = join(root, "evidence.json");
  const preload = resolve("tests/helpers/live-fetch-preload.mjs");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", `scripts/${script}`],
    {
      cwd: resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "production",
        LIVE_CLOCKIFY: "1",
        LIVE_CLOCKIFY_API_KEY: "test-key",
        LIVE_WORKSPACE_ID: "ws-1",
        LIVE_BASE_URL: "https://api.clockify.me/api/v1",
        LIVE_TEST_REQUEST_LOG: logPath,
        ...(script === "live-sweep.ts" ? { LIVE_TEST_SEED_TAG: "1" } : {}),
        LIVE_SMOKE_EVIDENCE_PATH: evidencePath,
        LIVE_SWEEP_EVIDENCE_PATH: evidencePath,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${preload}`.trim(),
        ...extraEnv,
      },
    },
  );
  const log = readFileSync(logPath, "utf8");
  return {
    result,
    log,
    evidence: JSON.parse(readFileSync(evidencePath, "utf8")) as {
      status: string;
      counts: Record<string, number>;
    },
  };
}

describe("live scripts honor the production mutation scope", () => {
  it("runs the smoke create and confirmed cleanup through journaled exact scopes", () => {
    const { result, log, evidence } = runLiveScript("live-smoke.ts");
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(evidence.status).toBe("passed");
    expect(log.match(/^POST .*\/tags$/gm)).toHaveLength(1);
    expect(log.match(/^DELETE .*\/tags\/tag-live$/gm)).toHaveLength(1);
  });

  it("runs every matching sweep deletion through an independent exact scope", () => {
    const { result, log, evidence } = runLiveScript("live-sweep.ts");
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(evidence.status).toBe("passed");
    expect(log.match(/^DELETE .*\/tags\/tag-live$/gm)).toHaveLength(1);
  });

  it("continues later cleanup after an early scan fails and reports the scan failure", () => {
    const { result, log, evidence } = runLiveScript("live-sweep.ts", {
      LIVE_TEST_FAIL_INVOICE_LIST: "1",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(evidence).toMatchObject({
      status: "failed",
      counts: { matched: 1, removed: 1, failures: 1, scanFailures: 1 },
    });
    expect(log.match(/^GET .*\/invoices$/gm)).toHaveLength(1);
    expect(log.match(/^DELETE .*\/tags\/tag-live$/gm)).toHaveLength(1);
  });
});
