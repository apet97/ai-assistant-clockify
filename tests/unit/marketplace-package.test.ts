import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = async (path: string): Promise<string> => readFile(resolve(path), "utf8");

/**
 * D12. One product version lives in `package.json`; everything that states it
 * publicly must agree, and everything that is v1 rollback history must NOT.
 *
 * Anti-vacuity: every assertion below extracts a capture group and compares it
 * to the package version. A deleted row/line yields `undefined`, which fails —
 * a `toContain(VERSION)` would instead have quietly stopped checking anything.
 * The version itself is not hard-coded here (that would make a bump a two-place
 * edit, which is the drift this test exists to prevent); it is constrained to
 * be well-formed semver and to never be `1.0.0`, the retired v1 version whose
 * materials are immutable history.
 */
describe("product version contract", () => {
  const one = (source: string, pattern: RegExp, what: string): string => {
    const matches = [...source.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))];
    expect(matches, `${what} must appear exactly once`).toHaveLength(1);
    return matches[0]![1]!;
  };

  it("states one product version everywhere a live claim carries it", async () => {
    const [pkg, server, listing, banner, generator, privacy, readiness] = await Promise.all([
      read("package.json"),
      read("src/server.ts"),
      read("docs/marketplace/01-listing-package.md"),
      read("docs/marketplace/assets/banner.svg"),
      read("scripts/generate-marketplace-media.ts"),
      read("PRIVACY.md"),
      read("MARKETPLACE_READINESS.md"),
    ]);

    const VERSION = (JSON.parse(pkg) as { version: string }).version;
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/u);
    // 1.0.0 is the retired v1 release. Reusing it would make the immutable-history
    // assertions in the next test agree with the live ones for the wrong reason.
    expect(VERSION).not.toBe("1.0.0");

    // The deployed release-identity endpoint.
    expect(one(server, /^\s*version: "([^"]+)",$/mu, "the /version literal")).toBe(VERSION);

    // The paste-ready listing.
    expect(one(listing, /^# Marketplace listing package - version (.+)$/mu, "listing title")).toBe(VERSION);
    expect(one(listing, /^\| Version \| ([^|]+) \|$/mu, "listing portal Version row").trim()).toBe(VERSION);
    expect(one(listing, /^- Confirm version (\S+) in package\/portal metadata/mu, "listing portal check"))
      .toBe(VERSION);

    // The listing banner is a hand-authored capture SOURCE, not generated output.
    expect(one(banner, />v(\d+\.\d+\.\d+) · /u, "banner version label")).toBe(VERSION);

    // The demo video carries the version in its delivery filename. The generator
    // literal is the source of truth for the NEXT `npm run media:marketplace`
    // run; the listing's asset row names the same file.
    const videoFilename = `ai-assistant-${VERSION}-demo.mp4`;
    expect(one(generator, /^const DEMO_VIDEO_FILENAME = "([^"]+)";$/mu, "generator demo filename"))
      .toBe(videoFilename);
    expect(listing).toContain(`assets/video/${videoFilename}`);

    // The Railway deployment label is NOT pinned to this version: it must track
    // the staged candidate instead. The "no hardcoded version" test below owns it.

    // Public sub-processor disclosure.
    expect(one(privacy, /^Version (\S+) sends model turns to DeepSeek/mu, "PRIVACY sub-processor line"))
      .toBe(VERSION);

    // The paste-ready What's New sibling for exactly this version.
    const whatsNewPath = `docs/marketplace/04-whats-new-${VERSION}.md`;
    const whatsNew = await read(whatsNewPath);
    expect(one(whatsNew, /^# What's New - version (.+)$/mu, "What's New title")).toBe(VERSION);
    expect(one(whatsNew, /^## Version\n\n`([^`]+)`$/mu, "What's New version block")).toBe(VERSION);
    expect(listing).toContain(`(./04-whats-new-${VERSION}.md)`);
    expect(readiness).toContain(`(./${whatsNewPath})`);

    // A bump must not leave the SUPERSEDED entry linked beside the new one. The
    // only two What's New files either document may reference are this version
    // and 1.0.0, which is deliberately retained as v1 history.
    const linkedVersions = (source: string): string[] => [
      ...new Set([...source.matchAll(/04-whats-new-(\d+\.\d+\.\d+)\.md/gu)].map(([, v]) => v!)),
    ].sort();
    expect(linkedVersions(listing)).toEqual(["1.0.0", VERSION].sort());
    expect(linkedVersions(readiness)).toEqual(["1.0.0", VERSION].sort());
  });

  it("leaves the immutable v1 1.0.0 materials at 1.0.0", async () => {
    // The other direction. A bulk find-and-replace of the version is the exact
    // mistake that would rewrite v1 rollback evidence, which CLAUDE.md forbids.
    const [candidate, whatsNewV1, reviewer, runbook, readiness] = await Promise.all([
      read("docs/marketplace/evidence/release-candidate.md"),
      read("docs/marketplace/04-whats-new-1.0.0.md"),
      read("docs/marketplace/02-reviewer-package.md"),
      read("docs/marketplace/03-operations-evidence-rollback-package.md"),
      read("MARKETPLACE_READINESS.md"),
    ]);

    expect(candidate).toContain("# Historical v1 release-candidate evidence - version 1.0.0");
    expect(candidate).toContain("| Package version | `1.0.0` |");
    expect(whatsNewV1).toContain("# What's New - version 1.0.0");
    expect(whatsNewV1).toContain("- Version is exactly `1.0.0`.");
    expect(reviewer).toContain("# Independent security and recovery reviewer package - version 1.0.0");
    expect(runbook).toContain(
      "# Release, incident, reconciliation, and rollback runbook - version 1.0.0 (v1)",
    );
    expect(readiness).toContain("# Marketplace readiness - historical v1 version 1.0.0");

    // Titles alone would let a BODY-only bulk replace through: the v1 runbook
    // carries seven further 1.0.0 statements below its heading, including its
    // own deployed-identity snippet at :460. That snippet is deliberately NOT
    // in the "no hardcoded version" gate list below — D1 gave this page an
    // explicit "do not release or deploy from this page" scope banner, so it is
    // frozen history, not an executable release gate. Do not "fix" it.
    //
    // These counts pin HISTORY, not prose style. A legitimate edit to a v1 file
    // updates the number here in the same commit as the edit; a drive-by bulk
    // replace does not, and fails. MARKETPLACE_READINESS.md is excluded on
    // purpose — it is a live document whose 1.0.0 references legitimately move.
    const occurrences = (source: string): number => source.match(/1\.0\.0/gu)?.length ?? 0;
    expect(occurrences(reviewer), "02-reviewer-package.md").toBe(1);
    expect(occurrences(runbook), "03-operations-evidence-rollback-package.md").toBe(9);
    expect(occurrences(whatsNewV1), "04-whats-new-1.0.0.md").toBe(3);
    expect(occurrences(candidate), "evidence/release-candidate.md").toBe(3);
    expect(occurrences(await read("docs/marketplace/evidence/README.md")), "evidence/README.md").toBe(1);
  });

  it("lets no deployed-identity gate hardcode a product version", async () => {
    // D12/F1. `/version` reports the version of the CANDIDATE that is running,
    // so every gate comparing against it must derive the expectation from that
    // candidate. A literal is wrong for one of the two supported engines: the
    // v1 rollback candidate declares 1.0.0 and the v2 candidate declares 2.0.0.
    // These four are reached from the LIVE deploy checklist, not the v1-only
    // runbook, so a literal here fails a correct deploy.
    const gates = [
      "DEPLOYMENT.md",
      // D9's v2 fork is reached from a LIVE deploy checklist, unlike the v1-only
      // page above, so it belongs here: it derives EXPECTED_PRODUCT_VERSION from
      // the staged candidate and a literal in it would fail a correct v2 deploy
      // exactly as one in DEPLOYMENT.md would.
      "docs/marketplace/03-operations-v2-runbook.md",
      "scripts/performance/private-production-contract.ts",
      "scripts/live-member-denial-probe.ts",
      "scripts/deploy-private-production.ts",
    ];
    for (const path of gates) {
      const source = await read(path);
      // Any semver literal sitting next to a version comparison or label.
      expect(source, `${path} must not hardcode a product version`)
        .not.toMatch(/(?:version\s*[!=]==?\s*|marketplace-)["']?\d+\.\d+\.\d+["']?/u);
    }

    // The runbook's assertion must read the STAGED candidate, not the checkout.
    const deployment = await read("DEPLOYMENT.md");
    expect(deployment).toContain('value.version !== process.env.EXPECTED_PRODUCT_VERSION');
    expect(deployment).toContain('"$RELEASE_STAGING/package.json"');
    expect(deployment).toContain("export EXPECTED_PRODUCT_VERSION");
    // Ordering: derived and exported before the assertion that consumes it.
    expect(deployment.indexOf("export EXPECTED_PRODUCT_VERSION"))
      .toBeLessThan(deployment.indexOf("value.version !== process.env.EXPECTED_PRODUCT_VERSION"));

    // The deploy label comes from the staged tree, so a v1 rollback is not
    // mislabelled with the checkout's version.
    const deploy = await read("scripts/deploy-private-production.ts");
    expect(deploy).toContain('join(staging, "package.json")');
    expect(deploy).toContain("marketplace-${stagedProductVersion}");
  });

  it("ties every advertised API-action count to the real model catalog", async () => {
    // "127" appears as prose in three public surfaces. Bind them to the catalog
    // so a 128th reviewed action cannot silently falsify the listing or banner.
    const { MODEL_API_ACTION_CATALOG } = await import("../../src/harness/api-catalog.js");
    const count = String(MODEL_API_ACTION_CATALOG.actions.length);
    const [banner, listing, whatsNew] = await Promise.all([
      read("docs/marketplace/assets/banner.svg"),
      read("docs/marketplace/01-listing-package.md"),
      read("docs/marketplace/04-whats-new-2.0.0.md"),
    ]);
    expect(one(banner, />v\d+\.\d+\.\d+ · (\d+) REVIEWED API ACTIONS/u, "banner action count")).toBe(count);
    expect(one(listing, /catalog of\n> (\d+) typed Clockify API actions\./u, "listing action count")).toBe(count);
    expect(one(whatsNew, /> (\d+) reviewed read and write operations\./u, "What's New action count")).toBe(count);
  });
});

/**
 * D11. Two artifacts stated the media review's status independently, and they
 * had drifted: the generated JSON is the machine-readable status, and
 * `evidence/release-candidate.md` asserts in prose that it "is intentionally
 * pending". D10's regeneration made that prose true again. This pins the
 * agreement so it cannot silently re-diverge.
 *
 * Neither artifact may be edited to satisfy this test: the JSON is generated by
 * `npm run media:marketplace`, and `release-candidate.md` is immutable v1
 * history. The pin is therefore asymmetric ON PURPOSE, and the asymmetry is
 * documented below rather than hidden.
 */
describe("marketplace media review agreement", () => {
  /** The canonical ids and order `marketplace-media-binding.ts` enforces. */
  const REVIEW_CHECK_IDS = [
    "icon-boundary-and-alpha",
    "banner-copy-and-legibility",
    "all-permission-groups-visible",
    "screenshots-readable-and-secret-free",
    "video-storyboard-readable-and-secret-free",
  ];

  const cells = (source: string, label: string, what: string): string[] => {
    const row = new RegExp(`^\\| ${label} \\|([^|]*)\\|([^|]*)\\|([^|]*)\\|$`, "mu").exec(source);
    // A deleted or renamed row yields null. Without this the branches below would
    // read `undefined` and every `toContain` would throw on a moved row rather
    // than reporting which document lost its status line.
    expect(row, `${what} row must exist exactly as one four-column table row`).not.toBeNull();
    return row!.slice(1).map((cell) => cell.trim());
  };

  it("keeps the generated review status and the documents that state it in agreement", async () => {
    const [reviewJson, v1Record, v2Record] = await Promise.all([
      read("docs/marketplace/assets/media-engineering-review.json"),
      read("docs/marketplace/evidence/release-candidate.md"),
      read("docs/marketplace/evidence/release-candidate-v2.md"),
    ]);
    const review = JSON.parse(reviewJson) as {
      status: string;
      reviewer: unknown;
      reviewedAt: unknown;
      checks: Array<{ id: string; status: string }>;
    };

    // --- Unconditional premises. These run today whichever branch is live, so a
    // typo in the not-yet-reachable `passed` branch cannot hide behind it. ---

    // A closed set: an invented third value must fail immediately rather than
    // falling through both branches and asserting nothing.
    expect(["pending", "passed"]).toContain(review.status);
    expect(review.checks.map((check) => check.id)).toEqual(REVIEW_CHECK_IDS);
    // Partial promotion is not a legal state: `buildMarketplaceMediaReleaseBinding`
    // requires the top-level status AND all five checks to be `passed` together,
    // so a `passed` header over a `pending` check is a lie this catches here.
    for (const check of review.checks) {
      expect(check.status, `check ${check.id} must match the top-level status`).toBe(review.status);
    }

    const v1Cells = cells(v1Record, "Icon and banner", "the v1 record's media");
    const v2Cells = cells(v2Record, "Marketplace media binding", "the v2 record's media");
    // Each row must really be ABOUT this artifact, or "they agree" is a claim
    // about two unrelated sentences.
    expect(v1Cells[2]).toContain("media-engineering-review.json");
    expect(v2Cells[2]).toContain("media-engineering-review.json");

    // The premise of the exemption granted in the `passed` branch below. Asserted
    // unconditionally: if this disclaimer is ever removed, the v1 record becomes
    // a live claim and the exemption's justification is gone.
    expect(v1Record).toContain("HISTORICAL V1 TEMPLATE - NO ROW IMPLIES A PASS; NOT VALID FOR V2");

    if (review.status === "pending") {
      // The state at this commit. The JSON must be pending in every field...
      expect(review.reviewer).toBeNull();
      expect(review.reviewedAt).toBeNull();
      // ...the v1 record's prose must say so...
      expect(v1Cells[2], "the v1 record must describe the review as pending").toContain(
        "is intentionally pending",
      );
      expect(v1Cells[1], "the v1 record's status cell must not read as a pass").toMatch(/^PENDING\b/u);
      // ...and the live v2 record must not claim the binding passed.
      expect(v2Cells[1], "the v2 record must report the media binding as pending").toMatch(/^PENDING\b/u);
    } else {
      // A human promoted the review by hand-editing the generated JSON, which is
      // the documented path (`generate-marketplace-media.ts` writes it pending,
      // and its own `instructions` field says to set status/checks/reviewer/
      // reviewedAt together).
      expect(typeof review.reviewer).toBe("string");
      expect((review.reviewer as string).trim()).not.toBe("");
      expect(typeof review.reviewedAt).toBe("string");
      expect(Number.isFinite(Date.parse(review.reviewedAt as string))).toBe(true);
      // The LIVE record must stop saying pending. This is the direction the pin
      // exists for, and it is enforced against the v2 record because that is the
      // status source for v2 and it is editable.
      expect(v2Cells[1], "the v2 record must record the promotion").not.toMatch(/^PENDING\b/u);
      // The v1 record is deliberately NOT asserted here. It is immutable v1
      // history whose own header disclaims live validity (pinned above), so
      // demanding an edit to it on promotion would make this test unsatisfiable
      // rather than useful.
    }
  });
});

describe("marketplace submission package", () => {
  it("supplies final portal pricing, Terms URL, and paste-ready 2.0.0 release notes", async () => {
    const [listing, whatsNew, terms] = await Promise.all([
      read("docs/marketplace/01-listing-package.md"),
      read("docs/marketplace/04-whats-new-2.0.0.md"),
      read("TERMS.md"),
    ]);

    expect(listing).toContain("| Pricing | Free add-on; Clockify Pro required |");
    expect(listing).toContain("plus `/terms`");
    expect(listing).not.toContain("if that field is present");
    expect(whatsNew).toContain("# What's New - version 2.0.0");
    expect(whatsNew).toContain("## Paste-ready release summary");
    expect(whatsNew).toContain("admin-only");
    expect(terms).toContain("# Terms of Use - AI Assistant for Clockify");
    expect(terms).toContain("partial or unknown outcome");

    const shortDescription = /\| Short description \| ([^|]+) \|/.exec(listing)?.[1]?.trim() ?? "";
    const fullDescription = /## Full description\n\n([\s\S]*?)\n\n## Privacy disclosure copy/
      .exec(listing)?.[1]
      ?.split("\n")
      .map((line) => line.replace(/^> ?/, ""))
      .join("\n")
      .trim() ?? "";
    expect(shortDescription.length).toBeGreaterThan(0);
    expect(shortDescription.length).toBeLessThanOrEqual(140);
    expect(fullDescription.length).toBeGreaterThan(0);
    expect(fullDescription.length).toBeLessThanOrEqual(1_500);
  });

  it("describes authorization truthfully as preceding an action rather than every Clockify read", async () => {
    const listing = await read("docs/marketplace/01-listing-package.md");

    expect(listing).not.toContain("risk before contacting Clockify");
    expect(listing).toContain("risk before executing the requested Clockify action");
  });

  it("documents post-commit media binding without a self-referential checked-in SHA", async () => {
    const listing = await read("docs/marketplace/01-listing-package.md");

    expect(listing).toContain("post-commit workflow artifact");
    expect(listing).toContain("`github.sha`");
    expect(listing).not.toContain("asset-evidence.json` binds the captures to the release SHA/archive hash");
  });

  it("makes the release runbook validate an explicit HTTPS BASE_URL before deployment checks", async () => {
    const [runbook, pkg] = await Promise.all([
      read("docs/marketplace/03-operations-evidence-rollback-package.md"),
      read("package.json"),
    ]);

    const baseUrlGuard = runbook.indexOf(': "${BASE_URL:?');
    const validator = runbook.indexOf("release:validate-base-url");
    const firstUse = runbook.indexOf('"$BASE_URL/version"');
    expect(baseUrlGuard).toBeGreaterThan(0);
    expect(validator).toBeGreaterThan(baseUrlGuard);
    expect(firstUse).toBeGreaterThan(validator);
    expect(JSON.parse(pkg).scripts["release:validate-base-url"]).toBe("tsx scripts/validate-release-base-url.ts");

    const tsx = resolve("node_modules/.bin/tsx");
    const script = resolve("scripts/validate-release-base-url.ts");
    expect(execFileSync(tsx, [script, "https://ai-assistant-production-c2e6.up.railway.app/"], { encoding: "utf8" }).trim())
      .toBe("https://ai-assistant-production-c2e6.up.railway.app");
    expect(() => execFileSync(tsx, [script, "https://attacker-production.up.railway.app"], { stdio: "pipe" }))
      .toThrow();
    expect(() => execFileSync(tsx, [script, "https://ai-assistant-production-c2e6.up.railway.app:443"], { stdio: "pipe" }))
      .toThrow();
    expect(() => execFileSync(tsx, [script, "http://assistant.example"], { stdio: "pipe" }))
      .toThrow();
  // Four synchronous tsx subprocesses can exceed Vitest's 5s default while the
  // full verify suite saturates its worker ceiling; keep the allowance local.
  }, 30_000);
});
