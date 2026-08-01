import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D15 item 3 — the deploy-time flip cannot be forgotten.
 *
 * The deployed candidate is recorded in PROSE ONLY. There is no in-tree
 * constant to compare against: `RELEASE_SHA` is a runtime environment variable
 * validated by regex (`src/config.ts`), and the only machine-recorded
 * `ad06c08` lives in `evidence/eval/v2-api-discovery-diagnostic-ad06c08.*`,
 * which is the EVAL diagnostic candidate — not the deployment — and must not be
 * repurposed as one.
 *
 * So this test pins the PAIR: `docs/V2_CUTOVER_RECORD.md` is the recorded
 * deployment, and every contributor-facing document that STATES what production
 * serves must agree with it. The SHA is EXTRACTED from the record, never
 * hard-coded here — a hard-coded literal would still pass after a deploy flip,
 * which is precisely the failure this test exists to prevent.
 *
 * What "cannot be forgotten" means concretely:
 *  - Flip the prose first  -> the prose no longer contains the recorded SHA -> RED.
 *  - Deploy without touching the prose -> the record moves, the prose is stale -> RED.
 * Either way the next deploy must update the recorded cutover and the prose in
 * the same change. This is independent of the product version: production still
 * serves 1.0.0 while `package.json` is 2.0.0, and those flip on different
 * schedules, so no version string is asserted here.
 */

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const read = (relativePath: string): string =>
  readFileSync(`${repositoryRoot}/${relativePath}`, "utf8");

const CUTOVER_RECORD = "docs/V2_CUTOVER_RECORD.md";

/**
 * Documents that assert what production serves today. `docs/V2_BUILD_LOG.md` is
 * deliberately EXCLUDED: it is an append-only chronology whose old entries keep
 * their original SHAs by design, so a substring check there would stay green
 * across a flip and add no protection.
 */
const CANDIDATE_CLAIMANTS = [
  "CLAUDE.md",
  "AGENTS.md",
  "README.md",
  "MARKETPLACE_READINESS.md",
] as const;

/** The `- **Deployed:** …` statement each agent-guidance file leads with. */
const DEPLOYED_STATEMENT_FILES = ["CLAUDE.md", "AGENTS.md"] as const;

function recordedDeployedSha(): string {
  const record = read(CUTOVER_RECORD);
  const rows = [...record.matchAll(/^\| Release SHA \| `([0-9a-f]{40})` \|$/gmu)];
  // Exactly one recorded deployment. A future cutover that appends a second row
  // fails here on purpose: someone must decide which one the prose describes
  // rather than letting the pin silently follow the wrong one.
  expect(rows, `${CUTOVER_RECORD} must record exactly one Release SHA`).toHaveLength(1);
  return rows[0]![1]!;
}

describe("D15: the deployed candidate statement matches the recorded cutover", () => {
  it("extracts one full 40-hex release SHA from the cutover record", () => {
    expect(recordedDeployedSha()).toMatch(/^[0-9a-f]{40}$/u);
  });

  it("states the recorded candidate in every document that claims one", () => {
    const sha = recordedDeployedSha();
    const shortSha = sha.slice(0, 7);

    const drifted: string[] = [];
    for (const relativePath of CANDIDATE_CLAIMANTS) {
      const contents = read(relativePath);
      if (!contents.includes(`\`${shortSha}\``)) {
        drifted.push(`${relativePath}: does not state the recorded candidate \`${shortSha}\``);
      }
    }

    expect(drifted).toEqual([]);
  });

  it("binds the recorded candidate to the actual Deployed statement, not to any mention", () => {
    const shortSha = recordedDeployedSha().slice(0, 7);

    const drifted: string[] = [];
    for (const relativePath of DEPLOYED_STATEMENT_FILES) {
      const contents = read(relativePath);
      const index = contents.indexOf("- **Deployed:**");
      if (index === -1) {
        drifted.push(`${relativePath}: has no "- **Deployed:**" statement`);
        continue;
      }
      // The statement is one bullet: up to the next top-level bullet.
      const rest = contents.slice(index + 1);
      const end = rest.indexOf("\n- ");
      const statement = end === -1 ? rest : rest.slice(0, end);
      if (!statement.includes(`\`${shortSha}\``)) {
        drifted.push(`${relativePath}: the Deployed statement does not name \`${shortSha}\``);
      }
    }

    expect(drifted).toEqual([]);
  });

  it("keeps the cutover record itself reachable from the claimants", () => {
    const missing = CANDIDATE_CLAIMANTS.filter(
      (relativePath) => !read(relativePath).includes(CUTOVER_RECORD),
    );
    expect(missing).toEqual([]);
  });
});
