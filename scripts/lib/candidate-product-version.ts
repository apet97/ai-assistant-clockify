import { execFileSync } from "node:child_process";

/**
 * The one answer to "what product version must this deployment identify as?"
 *
 * D12. Every deployed-identity gate used to hard-require the literal `"1.0.0"`.
 * Bumping the product version to 2.0.0 would have made a CORRECT deploy fail
 * those gates — but replacing the literal with `"2.0.0"` is equally wrong,
 * because the tested `ASSISTANT_ENGINE=v1` rollback redeploys the v1 candidate,
 * whose own `package.json` says `1.0.0`. Neither literal is right for both.
 *
 * The expectation is therefore not a constant at all: it is a property OF THE
 * CANDIDATE BEING DEPLOYED. Read it out of that commit's tree, never out of the
 * mutable working checkout — the uploaded artifact is a `git archive` of the
 * candidate, so the checkout's version is not what is running. A v1 rollback
 * yields `1.0.0` and a v2 deploy yields `2.0.0` with no branch and no flag.
 */

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/u;

/** Read `package.json`'s `version` from an exact commit, without checking it out. */
export function candidateProductVersion(releaseSha: string, cwd = process.cwd()): string {
  if (!SHA_PATTERN.test(releaseSha)) {
    throw new Error("candidate product version requires a full lowercase commit SHA");
  }
  const raw = execFileSync("git", ["show", `${releaseSha}:package.json`], {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1_048_576,
  });
  const parsed: unknown = JSON.parse(raw);
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== "string" || !SEMVER_PATTERN.test(version)) {
    throw new Error(`candidate ${releaseSha} does not declare an exact semver product version`);
  }
  return version;
}

/** Validate a version supplied from outside this module (env var, staged tree). */
export function assertProductVersion(value: unknown, label: string): string {
  if (typeof value !== "string" || !SEMVER_PATTERN.test(value)) {
    throw new Error(`${label} must be an exact semver product version`);
  }
  return value;
}
