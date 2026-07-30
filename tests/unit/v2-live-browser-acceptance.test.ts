import { describe, expect, it } from "vitest";

import {
  V2_BROWSER_JOURNEY_IDS,
  validateV2LiveBrowserAcceptanceEvidence,
  validateV2LiveBrowserAcceptanceEvidenceFromEnvironment,
} from "../../scripts/evidence/v2-live-browser-acceptance.js";

const SHA = "a".repeat(40);

/** The subset of the real `/version` payload (src/server.ts) the v2 check binds. */
function deployedVersion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "1.0.0",
    releaseSha: SHA,
    buildHash: "c".repeat(64),
    serverArtifactSha256: "d".repeat(64),
    sourceRelationship: "source_bound_builder",
    sourceBindingSha256: "e".repeat(64),
    modelConfiguration: { assistantEngine: "v2" },
    ...overrides,
  };
}

function browserEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "v2_production_browser_acceptance",
    conclusion: "passed",
    candidateSha: SHA,
    startedAt: "2026-07-30T10:00:00.000Z",
    completedAt: "2026-07-30T11:00:00.000Z",
    runtime: {
      browser: "Google Chrome",
      browserVersion: "126.0.6478.61",
      surface: "clockify_embedded_iframe",
    },
    journeys: V2_BROWSER_JOURNEY_IDS.map((id) => ({ id, passed: true })),
    cleanup: {
      resourcePrefix: "AIASSIST_SMOKE_",
      created: 3,
      deletionProven: 3,
      remaining: 0,
      pendingPreviews: 0,
    },
    ...overrides,
  };
}

function validate(
  evidence: unknown,
  deployed: unknown = deployedVersion(),
  target: "v1" | "v2" = "v2",
): ReturnType<typeof validateV2LiveBrowserAcceptanceEvidence> {
  return validateV2LiveBrowserAcceptanceEvidence({
    evidence,
    deployedVersion: deployed,
    expectedCandidateSha: SHA,
  }, target);
}

describe("B6: the v2 live browser acceptance sibling", () => {
  it("pins the fifteen real-server journey ids in their pinned order", () => {
    expect(V2_BROWSER_JOURNEY_IDS).toHaveLength(15);
    expect(new Set(V2_BROWSER_JOURNEY_IDS).size).toBe(15);
    expect(V2_BROWSER_JOURNEY_IDS[0]).toBe("read_grounded_answer_card_reload");
    expect(V2_BROWSER_JOURNEY_IDS[14]).toBe("member_rejected_before_session");
  });

  it("accepts a complete fifteen-journey run bound to a deployed v2 candidate", () => {
    const validation = validate(browserEvidence());
    expect(validation).toEqual({
      assistantEngine: "v2",
      evidenceStatus: "current",
      validForV2: true,
      schemaVersion: 1,
      kind: "v2-live-browser-acceptance-validation",
      conclusion: "passed",
      sourceCandidateSha: SHA,
      releaseBuildHash: "c".repeat(64),
      serverArtifactSha256: "d".repeat(64),
      browser: "Google Chrome",
      browserVersion: "126.0.6478.61",
      surface: "clockify_embedded_iframe",
      startedAt: "2026-07-30T10:00:00.000Z",
      completedAt: "2026-07-30T11:00:00.000Z",
      journeyCount: 15,
      cleanup: {
        resourcePrefix: "AIASSIST_SMOKE_",
        created: 3,
        deletionProven: 3,
        remaining: 0,
        pendingPreviews: 0,
      },
    });
  });

  it("rejects a v1 target before any artifact is parsed", () => {
    expect(() => validate("not even parsed", deployedVersion(), "v1")).toThrow(
      /current v2 evidence is not valid for v1/iu,
    );
  });

  it("rejects one failed journey", () => {
    const journeys = V2_BROWSER_JOURNEY_IDS.map((id) => ({
      id,
      passed: id !== "cancel_settles_preview",
    }));
    expect(() => validate(browserEvidence({ journeys }))).toThrow(/cancel_settles_preview/u);
  });

  it("rejects a missing or reordered journey", () => {
    const missing = V2_BROWSER_JOURNEY_IDS.slice(0, 14).map((id) => ({ id, passed: true }));
    expect(() => validate(browserEvidence({ journeys: missing }))).toThrow(/journey/iu);
    const reordered = [...V2_BROWSER_JOURNEY_IDS].reverse().map((id) => ({ id, passed: true }));
    expect(() => validate(browserEvidence({ journeys: reordered }))).toThrow(/journey/iu);
  });

  it("rejects unknown keys anywhere in the artifact", () => {
    expect(() => validate(browserEvidence({ extra: true }))).toThrow(/malformed/iu);
    const journeys = V2_BROWSER_JOURNEY_IDS.map((id) => ({ id, passed: true, note: "x" }));
    expect(() => validate(browserEvidence({ journeys }))).toThrow(/malformed/iu);
  });

  it("rejects a candidate mismatch and a deployed v1 engine", () => {
    expect(() => validate(browserEvidence({ candidateSha: "b".repeat(40) }))).toThrow(/candidate/iu);
    expect(() => validate(
      browserEvidence(),
      deployedVersion({ modelConfiguration: { assistantEngine: "v1" } }),
    )).toThrow(/deployed assistant engine is not v2/u);
  });

  it("rejects an incomplete cleanup and an invalid time window", () => {
    expect(() => validate(browserEvidence({
      cleanup: {
        resourcePrefix: "AIASSIST_SMOKE_",
        created: 3,
        deletionProven: 2,
        remaining: 1,
        pendingPreviews: 0,
      },
    }))).toThrow(/cleanup/iu);
    expect(() => validate(browserEvidence({
      startedAt: "2026-07-30T12:00:00.000Z",
      completedAt: "2026-07-30T11:00:00.000Z",
    }))).toThrow(/time window/iu);
  });

  it("validates end to end from environment paths with injected reads", () => {
    const files: Record<string, unknown> = {
      "browser.json": browserEvidence(),
      "deployed-version.json": deployedVersion(),
    };
    const { outputPath, validation } = validateV2LiveBrowserAcceptanceEvidenceFromEnvironment({
      V2_LIVE_BROWSER_VALIDATION_PATH: "/tmp/out/v2-browser.json",
      V2_LIVE_BROWSER_EVIDENCE_PATH: "browser.json",
      V2_LIVE_BROWSER_DEPLOYED_VERSION_PATH: "deployed-version.json",
      V2_LIVE_BROWSER_EXPECTED_CANDIDATE_SHA: SHA,
    }, (path) => {
      if (!(path in files)) throw new Error(`fixture file not found: ${path}`);
      return JSON.stringify(files[path]);
    });
    expect(outputPath).toBe("/tmp/out/v2-browser.json");
    expect(validation.journeyCount).toBe(15);
  });

  it("requires every environment path", () => {
    expect(() => validateV2LiveBrowserAcceptanceEvidenceFromEnvironment({}, () => "{}")).toThrow(
      /V2_LIVE_BROWSER_VALIDATION_PATH/u,
    );
  });
});
