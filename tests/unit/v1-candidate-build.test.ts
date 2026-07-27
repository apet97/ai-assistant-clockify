import { describe, expect, it } from "vitest";

import {
  classifyCandidateBuild,
  frozenCandidateSha,
} from "../../scripts/evidence/v1-candidate-build.js";

const CANDIDATE = "0b1c6794a6038ca465e812294df824b2fc694ee7";
const DESCENDANT = "bbd4c29db521bb268ddea9e6b43093241a86f613";
const UNRELATED = "9".repeat(40);

describe("frozen v1 candidate build applicability probe", () => {
  it("treats the frozen candidate commit itself as a candidate build", () => {
    expect(classifyCandidateBuild({
      headSha: CANDIDATE,
      candidateSha: CANDIDATE,
      isDescendant: true,
      changedPaths: [],
    })).toEqual({
      isV1CandidateBuild: true,
      reason: "head is the frozen v1 release candidate",
    });
  });

  it("treats an evidence-only descendant as a candidate build", () => {
    expect(classifyCandidateBuild({
      headSha: DESCENDANT,
      candidateSha: CANDIDATE,
      isDescendant: true,
      changedPaths: [
        "evidence/performance/deepseek-release-binding.json",
        "docs/marketplace/evidence/visual-review.json",
      ],
    })).toEqual({
      isV1CandidateBuild: true,
      reason: "head is an evidence-only descendant of the frozen v1 release candidate",
    });
  });

  it("is not a candidate build when head does not descend from the candidate", () => {
    expect(classifyCandidateBuild({
      headSha: UNRELATED,
      candidateSha: CANDIDATE,
      isDescendant: false,
      changedPaths: [],
    })).toEqual({
      isV1CandidateBuild: false,
      reason: "head does not descend from the frozen v1 release candidate",
    });
  });

  it("is not a candidate build once any executable path changed", () => {
    // One executable file is enough: the gates require the whole post-candidate
    // diff to be evidence, so a single source change makes them inapplicable.
    expect(classifyCandidateBuild({
      headSha: DESCENDANT,
      candidateSha: CANDIDATE,
      isDescendant: true,
      changedPaths: ["evidence/performance/deepseek-release-binding.json", "src/server.ts"],
    })).toEqual({
      isV1CandidateBuild: false,
      reason: "1 non-evidence path(s) changed since the frozen v1 release candidate",
    });

    expect(classifyCandidateBuild({
      headSha: DESCENDANT,
      candidateSha: CANDIDATE,
      isDescendant: true,
      changedPaths: ["src/server.ts", "package.json", "evidence/x.json", ".github/workflows/ci.yml"],
    }).reason).toBe("3 non-evidence path(s) changed since the frozen v1 release candidate");
  });

  it("does not mistake a lookalike path for release evidence", () => {
    // `evidence/` and `docs/marketplace/evidence/` are the only evidence roots;
    // a path that merely contains the word must not buy a skip.
    for (const path of ["src/evidence/thing.ts", "docs/evidence/x.json", "tests/evidence.ts"]) {
      expect(classifyCandidateBuild({
        headSha: DESCENDANT,
        candidateSha: CANDIDATE,
        isDescendant: true,
        changedPaths: [path],
      }).isV1CandidateBuild, path).toBe(false);
    }
  });

  it("reads the candidate from the binding and rejects an unusable one", () => {
    expect(frozenCandidateSha(JSON.stringify({ candidate: { testedSha: CANDIDATE } })))
      .toBe(CANDIDATE);

    // The probe must THROW rather than resolve to a value on unusable input: a
    // silent `false` would skip the very gates it guards.
    expect(() => frozenCandidateSha("null")).toThrow("release binding must be an object");
    expect(() => frozenCandidateSha(JSON.stringify({})))
      .toThrow("release binding must carry a candidate object");
    for (const testedSha of [undefined, "", "0B1C6794A6038CA465E812294DF824B2FC694EE7", "0b1c679", 12]) {
      expect(() => frozenCandidateSha(JSON.stringify({ candidate: { testedSha } })))
        .toThrow("release binding candidate.testedSha must be an exact lowercase 40-character sha");
    }
    expect(() => frozenCandidateSha("{not json")).toThrow();
  });

  it("agrees with the checked-in binding that this branch is not a candidate build", () => {
    // The repository's own binding names the frozen v1 candidate, and this v2
    // branch changes hundreds of executable files since it -- which is exactly
    // why the two candidate-bound CI gates must not run here.
    const binding = frozenCandidateSha(
      JSON.stringify({ candidate: { testedSha: CANDIDATE } }),
    );
    expect(binding).toBe(CANDIDATE);
    expect(classifyCandidateBuild({
      headSha: "053bf34137f064fa782385a8b501ec2a84bfbb7e",
      candidateSha: CANDIDATE,
      isDescendant: true,
      changedPaths: ["src/routes/api.ts"],
    }).isV1CandidateBuild).toBe(false);
  });
});
