import { describe, expect, it } from "vitest";

import { buildReleaseEvidence } from "../../scripts/evidence/release-evidence.js";

describe("release evidence", () => {
  it("records machine conclusions while keeping every human gate unevaluated", () => {
    const evidence = buildReleaseEvidence({
      commitSha: "a".repeat(40),
      machineConclusions: {
        verify: "success",
        audit: "failure",
        license: "cancelled",
        codeql: "skipped",
        secretScan: "success",
        scriptedSafetyCorpus: "success",
        sbom: "success",
        liveSmoke: "success",
      },
      humanConclusions: {
        securityReview: "passed",
        marketplaceApproval: "passed",
      },
      token: "RELEASE_TOKEN_MUST_NOT_APPEAR",
    } as never);

    expect(evidence.commitSha).toBe("a".repeat(40));
    expect(evidence.machineGates).toEqual({
      verify: "passed",
      audit: "failed",
      license: "cancelled",
      codeql: "skipped",
      secretScan: "passed",
      scriptedSafetyCorpus: "passed",
      sbom: "passed",
      liveSmoke: "passed",
    });
    expect(new Set(Object.values(evidence.humanGates))).toEqual(new Set(["not_evaluated"]));
    expect(JSON.stringify(evidence)).not.toContain("RELEASE_TOKEN_MUST_NOT_APPEAR");
  });

  it("rejects an invalid commit SHA and maps unknown machine results safely", () => {
    expect(() => buildReleaseEvidence({
      commitSha: "not-a-commit",
      machineConclusions: {},
    })).toThrow(/commit SHA/);

    const evidence = buildReleaseEvidence({
      commitSha: "b".repeat(40),
      machineConclusions: { verify: "passed" },
    });
    expect(evidence.machineGates.verify).toBe("unknown");
  });
});
