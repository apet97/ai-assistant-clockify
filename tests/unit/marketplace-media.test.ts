import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ADDON_ICON_SVG } from "../../src/addon/manifest.js";
import {
  buildMarketplaceMediaReleaseBinding,
  isPostCandidateEvidencePath,
} from "../../scripts/evidence/marketplace-media-binding.js";

interface AssetEvidence {
  file: string;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  durationSeconds?: number;
}

interface MarketplaceMediaEvidence {
  schemaVersion: number;
  source: string;
  liveConnectivityEvidence: boolean;
  containsSecrets: boolean;
  captureSourceSha256: string;
  visualReview: {
    artifact: string;
    requiredStatus: "passed";
  };
  demoSteps: Array<{ step: number; label: string }>;
  assets: AssetEvidence[];
}

interface MediaVisualReview {
  schemaVersion: number;
  status: "pending" | "passed";
  captureSourceSha256: string;
  assetSetSha256: string;
  reviewer: string | null;
  reviewedAt: string | null;
  checks: Array<{ id: string; status: "pending" | "passed"; notes: string | null }>;
}

const evidencePath = resolve("docs/marketplace/assets/asset-evidence.json");

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string): number => {
    const channels = hex.slice(1).match(/.{2}/g)?.map((channel) => Number.parseInt(channel, 16) / 255);
    if (channels === undefined || channels.length !== 3) throw new Error(`Invalid color ${hex}`);
    const linear = channels.map((channel) => channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
  };
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("marketplace media package", () => {
  it("uses the marketplace chat-and-check mark for the manifest sidebar icon", async () => {
    const marketplaceIcon = await readFile(resolve("docs/marketplace/assets/icon.svg"), "utf8");
    for (const color of ["#0e1116", "#5b9bff", "#3fce8b"]) {
      expect(marketplaceIcon.toLowerCase()).toContain(color);
      expect(ADDON_ICON_SVG.toLowerCase()).toContain(color);
    }
    expect(ADDON_ICON_SVG).toContain("<circle");
    expect(ADDON_ICON_SVG).toContain("stroke-linejoin=\"round\"");
  });

  it("does not put internal release-status language on the public banner", async () => {
    const banner = await readFile(resolve("docs/marketplace/assets/banner.svg"), "utf8");
    expect(banner).not.toContain("PRIVATE RELEASE CANDIDATE");
    expect(banner).toContain("Ask. Preview. Confirm.");
  });

  it("keeps every small meaningful banner label above WCAG AA normal-text contrast", async () => {
    const banner = await readFile(resolve("docs/marketplace/assets/banner.svg"), "utf8");
    for (const [label, background] of [
      ["REQUEST", "#1e242f"],
      ["ASK", "#171b23"],
      ["PREVIEW", "#171b23"],
      ["RECEIPT", "#171b23"],
    ] as const) {
      const fill = new RegExp(`<text[^>]+fill="(#[a-fA-F0-9]{6})"[^>]*>${label}</text>`).exec(banner)?.[1];
      expect(fill, `${label} must have an explicit six-digit foreground`).toBeTruthy();
      expect(contrastRatio(fill!, background), `${label} contrast`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("fails media generation unless every permission group is inside the captured frame", async () => {
    const generator = await readFile(resolve("scripts/generate-marketplace-media.ts"), "utf8");
    expect(generator).toContain("assertAllPermissionGroupsInFrame");
    expect(generator).toContain("FEATURE_GROUPS.length");
    expect(generator).toContain("permission_group_outside_capture");
    expect(generator.match(/await assertAllPermissionGroupsInFrame\(page\)/g)).toHaveLength(2);
  });

  it("fails every screenshot and storyboard frame when a conversation card is visibly clipped", async () => {
    const generator = await readFile(resolve("scripts/generate-marketplace-media.ts"), "utf8");
    expect(generator).toContain("assertConversationCardsInFrame");
    expect(generator).toMatch(/async function screenshot[\s\S]*await assertConversationCardsInFrame\(page\)/);
    expect(generator).toMatch(/async function captureStoryFrame[\s\S]*await assertConversationCardsInFrame\(page\)/);
    expect(generator).toContain("conversation_card_outside_capture");
  });

  it("captures the fixed English interface without a language query knob", async () => {
    const generator = await readFile(resolve("scripts/generate-marketplace-media.ts"), "utf8");
    expect(generator).not.toMatch(/language=(?:en|sr)/);
    expect(generator).toContain("assertFixedEnglishInterface");
    expect(generator).toMatch(/async function openPage[\s\S]*await assertFixedEnglishInterface\(page\)/);
    expect(generator).toContain("marketplace_media_language_contract");
  });

  it("records a secret-free seven-step fixture demo and exact delivery-asset hashes", async () => {
    const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as MarketplaceMediaEvidence;
    expect(evidence).toMatchObject({
      schemaVersion: 2,
      source: "deterministic synthetic release-build fixture",
      liveConnectivityEvidence: false,
      containsSecrets: false,
    });
    expect(evidence.demoSteps.map(({ step }) => step)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(evidence.captureSourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence).not.toHaveProperty("releaseCandidate");
    expect(evidence.visualReview).toEqual({
      artifact: "docs/marketplace/assets/media-engineering-review.json",
      requiredStatus: "passed",
    });
    expect(evidence.demoSteps.map(({ label }) => label)).toEqual([
      "First-run DeepSeek disclosure, permissions, and public links",
      "Read-only request and receipt",
      "Safe write and immediate receipt",
      "Risky preview and button confirmation",
      "Confirmed receipt and truthful undo",
      "History reload and authenticated PDF action",
      "Permission controls and member-denial statement",
    ]);

    const expectedFiles = [
      "docs/marketplace/assets/icon.png",
      "docs/marketplace/assets/banner.png",
      "docs/marketplace/assets/screenshots/01-first-run-permissions.png",
      "docs/marketplace/assets/screenshots/02-read-and-receipt.png",
      "docs/marketplace/assets/screenshots/03-risky-preview-confirm.png",
      "docs/marketplace/assets/screenshots/04-receipt-and-undo.png",
      "docs/marketplace/assets/screenshots/05-history-and-pdf-download.png",
      "docs/marketplace/assets/video/ai-assistant-1.0.0-demo.mp4",
    ];
    expect(evidence.assets.map(({ file }) => file)).toEqual(expectedFiles);

    for (const asset of evidence.assets) {
      const contents = await readFile(resolve(asset.file));
      expect(asset.bytes).toBe(contents.length);
      expect(asset.sha256).toBe(createHash("sha256").update(contents).digest("hex"));
    }
    expect(evidence.assets.slice(0, 2).map(({ width, height }) => [width, height])).toEqual([
      [512, 512],
      [1600, 900],
    ]);
    expect(evidence.assets.slice(2, 7).every(({ width, height }) => width === 1440 && height === 900)).toBe(true);
    expect(evidence.assets.at(-1)).toMatchObject({ width: 1440, height: 900 });
    expect(evidence.assets.at(-1)?.durationSeconds).toBeGreaterThanOrEqual(28);

    const review = JSON.parse(
      await readFile(resolve(evidence.visualReview.artifact), "utf8"),
    ) as MediaVisualReview;
    const assetSetSha256 = createHash("sha256")
      .update(JSON.stringify(evidence.assets))
      .digest("hex");
    expect(review).toMatchObject({
      schemaVersion: 1,
      captureSourceSha256: evidence.captureSourceSha256,
      assetSetSha256,
    });
    expect(review).not.toHaveProperty("releaseSha");
    expect(review).not.toHaveProperty("releaseBuildHash");
    expect(review.checks.map(({ id }) => id)).toEqual([
      "icon-boundary-and-alpha",
      "banner-copy-and-legibility",
      "all-permission-groups-visible",
      "screenshots-readable-and-secret-free",
      "video-storyboard-readable-and-secret-free",
    ]);
    if (review.status === "passed") {
      expect(review.reviewer).toBeTruthy();
      expect(review.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(review.checks.every(({ status }) => status === "passed")).toBe(true);
    } else {
      expect(review.reviewer).toBeNull();
      expect(review.reviewedAt).toBeNull();
      expect(review.checks.every(({ status }) => status === "pending")).toBe(true);
    }
  });

  it("creates exact release binding only as an immutable post-commit workflow artifact", async () => {
    const [pkg, ci, release, script] = await Promise.all([
      readFile(resolve("package.json"), "utf8"),
      readFile(resolve(".github/workflows/ci.yml"), "utf8"),
      readFile(resolve(".github/workflows/release-evidence.yml"), "utf8"),
      readFile(resolve("scripts/evidence/marketplace-media-binding.ts"), "utf8"),
    ]);
    expect(JSON.parse(pkg).scripts["evidence:marketplace-media-binding"])
      .toBe("tsx scripts/evidence/marketplace-media-binding.ts");
    expect(ci).toContain("deepseek-release-binding.json");
    expect(ci).toContain("binding.candidate.testedSha");
    expect(ci).not.toContain("MARKETPLACE_MEDIA_SOURCE_CANDIDATE_SHA: ${{ github.sha }}");
    expect(release).toContain("MARKETPLACE_MEDIA_SOURCE_CANDIDATE_SHA: ${{ inputs.tested_candidate_sha }}");
    expect(release).toMatch(/machine-gates:[\s\S]*?fetch-depth: 0[\s\S]*?MARKETPLACE_MEDIA_SOURCE_CANDIDATE_SHA/);
    for (const workflow of [ci, release]) {
      expect(workflow).toContain("MARKETPLACE_MEDIA_EVIDENCE_COMMIT_SHA: ${{ github.sha }}");
      expect(workflow).toContain("npm run evidence:marketplace-media-binding");
      expect(workflow).toContain("marketplace-media-release-binding.json");
    }
    expect(script).toContain('spawnSync("git", ["archive", "--format=tar", sourceCandidateSha]');
    expect(script).toContain("assertEvidenceOnlyDescendant");
    expect(script).toContain("sourceCandidateSha");
    expect(script).toContain("evidenceCommitSha");
    expect(script).toContain("assetEvidence: { path:");
    expect(script).toContain("visualReview: { path:");
    expect(script).toContain('review.status !== "passed"');
  });

  it("binds a passed reviewed asset set to the tested source candidate and evidence commit", () => {
    const asset = Buffer.from("reviewed marketplace asset", "utf8");
    const assets = [{
      file: "docs/marketplace/assets/icon.png",
      bytes: asset.byteLength,
      sha256: createHash("sha256").update(asset).digest("hex"),
      width: 512,
      height: 512,
    }];
    const captureSourceSha256 = "a".repeat(64);
    const assetSetSha256 = createHash("sha256").update(JSON.stringify(assets)).digest("hex");
    const assetEvidenceBytes = Buffer.from(JSON.stringify({
      schemaVersion: 2,
      captureSourceSha256,
      visualReview: {
        artifact: "docs/marketplace/assets/media-engineering-review.json",
        requiredStatus: "passed",
      },
      assets,
    }));
    const review = {
      schemaVersion: 1,
      status: "passed",
      captureSourceSha256,
      assetSetSha256,
      reviewer: "engineering-review",
      reviewedAt: "2026-07-19T01:00:00.000Z",
      checks: [
        "icon-boundary-and-alpha",
        "banner-copy-and-legibility",
        "all-permission-groups-visible",
        "screenshots-readable-and-secret-free",
        "video-storyboard-readable-and-secret-free",
      ].map((id) => ({ id, status: "passed" })),
    };

    const result = buildMarketplaceMediaReleaseBinding({
      sourceCandidateSha: "b".repeat(40),
      evidenceCommitSha: "c".repeat(40),
      sourceCandidateBuildHash: "d".repeat(64),
      currentCaptureSourceSha256: captureSourceSha256,
      assetEvidenceBytes,
      reviewBytes: Buffer.from(JSON.stringify(review)),
      readAsset: () => asset,
    });

    expect(result).toMatchObject({
      conclusion: "passed",
      sourceCandidateSha: "b".repeat(40),
      evidenceCommitSha: "c".repeat(40),
      sourceCandidateBuildHash: "d".repeat(64),
      captureSourceSha256,
      assetSetSha256,
      assetCount: 1,
    });
    expect(result.assetEvidence.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.visualReview.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(isPostCandidateEvidencePath("docs/marketplace/evidence/release-candidate.md")).toBe(true);
    expect(isPostCandidateEvidencePath("evidence/recovery/restore.json")).toBe(true);
    expect(isPostCandidateEvidencePath("docs/marketplace/assets/icon.png")).toBe(false);

    expect(() => buildMarketplaceMediaReleaseBinding({
      sourceCandidateSha: "b".repeat(40),
      evidenceCommitSha: "c".repeat(40),
      sourceCandidateBuildHash: "d".repeat(64),
      currentCaptureSourceSha256: captureSourceSha256,
      assetEvidenceBytes,
      reviewBytes: Buffer.from(JSON.stringify({ ...review, status: "pending" })),
      readAsset: () => asset,
    })).toThrow(/visual review/i);
  });
});
