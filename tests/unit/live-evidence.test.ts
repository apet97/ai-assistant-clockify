import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildLiveEvidence,
  writeLiveEvidence,
} from "../../scripts/evidence/live-evidence.js";

describe("live workflow evidence", () => {
  it("emits only approved prefixes, counts, and pass/fail status", () => {
    const evidence = buildLiveEvidence({
      resourcePrefixes: ["AIASSIST_SMOKE_", "AIASSIST_SMOKE_"],
      counts: {
        created: 1,
        remaining: 0,
        scanFailures: 0,
        apiToken: "LIVE_TOKEN_MUST_NOT_APPEAR",
        workspaceId: "workspace-id-must-not-appear",
      },
      passed: true,
      name: "resource-name-must-not-appear",
      responseBody: "response-body-must-not-appear",
      prompt: "prompt-must-not-appear",
      payload: { raw: "payload-must-not-appear" },
    } as never);

    expect(evidence).toEqual({
      resourcePrefixes: ["AIASSIST_SMOKE_"],
      counts: { created: 1, remaining: 0, scanFailures: 0 },
      status: "passed",
    });
    expect(JSON.stringify(evidence)).not.toMatch(
      /LIVE_TOKEN|workspace-id|resource-name|response-body|prompt-must|payload-must/,
    );
  });

  it("writes deterministic failure evidence without unsafe input fields", () => {
    const directory = mkdtempSync(join(tmpdir(), "live-evidence-"));
    const path = join(directory, "nested", "smoke.json");

    try {
      writeLiveEvidence(path, {
        resourcePrefixes: ["AIASSIST_SMOKE_"],
        counts: { created: 0, failures: 1 },
        passed: false,
        error: "raw API response must not be written",
      } as never);

      const serialized = readFileSync(path, "utf8");
      expect(JSON.parse(serialized)).toEqual({
        resourcePrefixes: ["AIASSIST_SMOKE_"],
        counts: { created: 0, failures: 1 },
        status: "failed",
      });
      expect(serialized.endsWith("\n")).toBe(true);
      expect(serialized).not.toContain("raw API response");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("omits a remaining count until cleanup actually measures it", () => {
    expect(buildLiveEvidence({
      resourcePrefixes: ["AIASSIST_SMOKE_"],
      counts: { created: 0, remaining: undefined, failures: 1 },
      passed: false,
    })).toEqual({
      resourcePrefixes: ["AIASSIST_SMOKE_"],
      counts: { created: 0, failures: 1 },
      status: "failed",
    });
  });

  it("rejects non-prefix data and invalid counts", () => {
    expect(() => buildLiveEvidence({
      resourcePrefixes: ["customer-name-or-id"],
      counts: { remaining: 0 },
      passed: false,
    })).toThrow(/resource prefix/);
    expect(() => buildLiveEvidence({
      resourcePrefixes: ["AIASSIST_SMOKE_"],
      counts: { remaining: -1 },
      passed: false,
    })).toThrow(/count/);
  });
});
