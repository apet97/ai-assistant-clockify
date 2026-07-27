/** Decides whether the checked-out commit is the FROZEN v1 release candidate, or
 * an evidence-only descendant of it.
 *
 * Two CI gates -- the Marketplace media binding and the machine-bound DeepSeek
 * benchmark validation -- bind their evidence to that exact candidate and require
 * every change since it to be evidence-only. Both are therefore structurally
 * inapplicable to a build that is not that candidate: a v2 rewrite changes
 * hundreds of executable files by definition, so the gates could never pass and
 * blocked every branch, `main` included.
 *
 * This probe decides APPLICABILITY ONLY. It weakens neither gate: when it reports
 * `true`, both run unchanged and enforce their own full checks (exact evidence
 * commit, clean checkout, ancestry, and the evidence-only diff). The path rule is
 * imported from the gate itself rather than restated, so the two cannot drift.
 *
 * Prints exactly `true` or `false` and exits 0. On ANY error it exits nonzero
 * instead of printing `false`, so a broken probe fails the build rather than
 * silently skipping the gates it guards. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isReleaseEvidencePath } from "./deepseek-release-evidence.js";

const BINDING_PATH = process.env.DEEPSEEK_BINDING_PATH
  ?? "evidence/performance/deepseek-release-binding.json";

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** The frozen v1 candidate, read from the same checked-in binding both gates
 * read it from. */
export function frozenCandidateSha(bindingJson: string): string {
  const parsed = JSON.parse(bindingJson) as unknown;
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("release binding must be an object");
  }
  const candidate = (parsed as { candidate?: unknown }).candidate;
  if (candidate === null || typeof candidate !== "object") {
    throw new Error("release binding must carry a candidate object");
  }
  const testedSha = (candidate as { testedSha?: unknown }).testedSha;
  if (typeof testedSha !== "string" || !/^[0-9a-f]{40}$/u.test(testedSha)) {
    throw new Error("release binding candidate.testedSha must be an exact lowercase 40-character sha");
  }
  return testedSha;
}

export interface CandidateBuildProbe {
  isV1CandidateBuild: boolean;
  reason: string;
}

/** Mirrors the applicability half of the gates' own `assertEvidenceCommit`: the
 * candidate itself qualifies, and so does a descendant whose entire diff is
 * evidence. Everything else is simply not a v1-candidate build. */
export function classifyCandidateBuild(input: {
  headSha: string;
  candidateSha: string;
  isDescendant: boolean;
  changedPaths: readonly string[];
}): CandidateBuildProbe {
  if (input.headSha === input.candidateSha) {
    return { isV1CandidateBuild: true, reason: "head is the frozen v1 release candidate" };
  }
  if (!input.isDescendant) {
    return {
      isV1CandidateBuild: false,
      reason: "head does not descend from the frozen v1 release candidate",
    };
  }
  const executable = input.changedPaths.filter((path) => !isReleaseEvidencePath(path));
  if (executable.length > 0) {
    return {
      isV1CandidateBuild: false,
      reason: `${String(executable.length)} non-evidence path(s) changed since the frozen v1 release candidate`,
    };
  }
  return {
    isV1CandidateBuild: true,
    reason: "head is an evidence-only descendant of the frozen v1 release candidate",
  };
}

/** `git merge-base --is-ancestor` exits 0 for yes and exactly 1 for no. Any other
 * status is a real git failure and is rethrown rather than read as "no": treating
 * a broken git as "not a candidate build" would silently skip the guarded gates. */
function isAncestor(candidateSha: string, headSha: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", candidateSha, headSha], { stdio: "ignore" });
    return true;
  } catch (error) {
    if ((error as { status?: unknown }).status === 1) return false;
    throw error;
  }
}

function probe(): CandidateBuildProbe {
  const candidateSha = frozenCandidateSha(readFileSync(BINDING_PATH, "utf8"));
  const headSha = git(["rev-parse", "HEAD"]);
  const isDescendant = isAncestor(candidateSha, headSha);
  const changedPaths = isDescendant && headSha !== candidateSha
    ? git(["diff", "--name-only", `${candidateSha}..${headSha}`]).split("\n").filter(Boolean)
    : [];
  return classifyCandidateBuild({ headSha, candidateSha, isDescendant, changedPaths });
}

// A bare `tsx scripts/evidence/v1-candidate-build.ts` prints the boolean on
// stdout and the reason on stderr, so a CI step can capture the decision without
// the explanation polluting it. An error propagates: stdout stays empty and the
// exit code is nonzero, so the guarded gates are never skipped by a failed probe.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = probe();
  process.stderr.write(`${result.reason}\n`);
  process.stdout.write(result.isV1CandidateBuild ? "true" : "false");
}
