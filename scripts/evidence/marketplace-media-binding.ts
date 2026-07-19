import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  marketplaceAssetSetSha256,
  marketplaceCaptureSourceSha256,
  sha256,
  type MarketplaceAssetRecord,
} from "./marketplace-media-contract.js";
import { writeDeterministicJson } from "./write-json.js";

const ASSET_EVIDENCE_PATH = "docs/marketplace/assets/asset-evidence.json";
const VISUAL_REVIEW_PATH = "docs/marketplace/assets/media-engineering-review.json";
const REVIEW_CHECK_IDS = [
  "icon-boundary-and-alpha",
  "banner-copy-and-legibility",
  "all-permission-groups-visible",
  "screenshots-readable-and-secret-free",
  "video-storyboard-readable-and-secret-free",
] as const;

interface AssetEvidenceDocument {
  schemaVersion: number;
  captureSourceSha256: string;
  visualReview?: { artifact?: unknown; requiredStatus?: unknown };
  assets: MarketplaceAssetRecord[];
}

interface VisualReviewDocument {
  schemaVersion: number;
  status: string;
  captureSourceSha256: string;
  assetSetSha256: string;
  reviewer: unknown;
  reviewedAt: unknown;
  checks: Array<{ id?: unknown; status?: unknown }>;
}

export interface MarketplaceMediaReleaseBinding {
  schemaVersion: 1;
  conclusion: "passed";
  sourceCandidateSha: string;
  evidenceCommitSha: string;
  sourceCandidateBuildHash: string;
  captureSourceSha256: string;
  assetSetSha256: string;
  assetCount: number;
  assetEvidence: { path: typeof ASSET_EVIDENCE_PATH; sha256: string };
  visualReview: { path: typeof VISUAL_REVIEW_PATH; sha256: string };
}

function fullLowercaseHash(value: string, lengths: number[], label: string): string {
  if (!lengths.includes(value.length) || !/^[a-f0-9]+$/.test(value)) {
    throw new Error(`${label} must be a full lowercase hexadecimal hash.`);
  }
  return value;
}

function runGit(args: string[], encoding: BufferEncoding): string;
function runGit(args: string[], encoding: null): Buffer;
function runGit(args: string[], encoding: BufferEncoding | null): string | Buffer {
  const result = spawnSync("git", args, { encoding, maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0 || result.error) throw new Error("Git release binding command failed.");
  return result.stdout;
}

function checkedInFile(root: string, relativePath: string): Buffer {
  const resolved = resolve(root, relativePath);
  const realRoot = realpathSync(root);
  const real = realpathSync(resolved);
  if (!real.startsWith(`${realRoot}/`)) throw new Error("Marketplace evidence path escaped the repository.");
  const info = statSync(real);
  if (!info.isFile() || info.size > 25 * 1024 * 1024) {
    throw new Error("Marketplace evidence file is missing, oversized, or not a regular file.");
  }
  return readFileSync(real);
}

function parseJson<T>(bytes: Buffer, label: string): T {
  try {
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

export function buildMarketplaceMediaReleaseBinding(input: {
  sourceCandidateSha: string;
  evidenceCommitSha: string;
  sourceCandidateBuildHash: string;
  currentCaptureSourceSha256: string;
  assetEvidenceBytes: Buffer;
  reviewBytes: Buffer;
  readAsset: (path: string) => Buffer;
}): MarketplaceMediaReleaseBinding {
  const sourceCandidateSha = fullLowercaseHash(input.sourceCandidateSha, [40, 64], "source candidate SHA");
  const evidenceCommitSha = fullLowercaseHash(input.evidenceCommitSha, [40, 64], "evidence commit SHA");
  const sourceCandidateBuildHash = fullLowercaseHash(
    input.sourceCandidateBuildHash,
    [64],
    "source candidate build hash",
  );
  const evidence = parseJson<AssetEvidenceDocument>(input.assetEvidenceBytes, "asset evidence");
  const review = parseJson<VisualReviewDocument>(input.reviewBytes, "visual review");
  const captureSourceSha256 = fullLowercaseHash(evidence.captureSourceSha256, [64], "capture source hash");
  if (evidence.schemaVersion !== 2 || !Array.isArray(evidence.assets) || evidence.assets.length === 0) {
    throw new Error("Marketplace asset evidence schema is unsupported or empty.");
  }
  if (
    evidence.visualReview?.artifact !== VISUAL_REVIEW_PATH
    || evidence.visualReview.requiredStatus !== "passed"
  ) {
    throw new Error("Marketplace asset evidence does not require the canonical visual review.");
  }
  if (input.currentCaptureSourceSha256 !== captureSourceSha256) {
    throw new Error("Checked-in media was not captured from the current release source.");
  }

  const assetSetSha256 = marketplaceAssetSetSha256(evidence.assets);
  for (const asset of evidence.assets) {
    if (
      typeof asset.file !== "string"
      || !asset.file.startsWith("docs/marketplace/assets/")
      || !Number.isSafeInteger(asset.bytes)
      || asset.bytes <= 0
      || !/^[a-f0-9]{64}$/.test(asset.sha256)
    ) throw new Error("Marketplace asset record is malformed.");
    const bytes = input.readAsset(asset.file);
    if (bytes.byteLength !== asset.bytes || sha256(bytes) !== asset.sha256) {
      throw new Error("Marketplace asset bytes do not match checked-in evidence.");
    }
  }

  if (
    review.schemaVersion !== 1
    || review.status !== "passed"
    || review.captureSourceSha256 !== captureSourceSha256
    || review.assetSetSha256 !== assetSetSha256
    || typeof review.reviewer !== "string"
    || review.reviewer.trim() === ""
    || typeof review.reviewedAt !== "string"
    || !Number.isFinite(Date.parse(review.reviewedAt))
    || !Array.isArray(review.checks)
    || review.checks.length !== REVIEW_CHECK_IDS.length
    || REVIEW_CHECK_IDS.some((id, index) => review.checks[index]?.id !== id || review.checks[index]?.status !== "passed")
  ) {
    throw new Error("Marketplace engineering visual review is not passed for this exact capture and asset set.");
  }

  return {
    schemaVersion: 1,
    conclusion: "passed",
    sourceCandidateSha,
    evidenceCommitSha,
    sourceCandidateBuildHash,
    captureSourceSha256,
    assetSetSha256,
    assetCount: evidence.assets.length,
    assetEvidence: { path: ASSET_EVIDENCE_PATH, sha256: sha256(input.assetEvidenceBytes) },
    visualReview: { path: VISUAL_REVIEW_PATH, sha256: sha256(input.reviewBytes) },
  };
}

export function isPostCandidateEvidencePath(path: string): boolean {
  return path.startsWith("evidence/") || path.startsWith("docs/marketplace/evidence/");
}

function assertEvidenceOnlyDescendant(sourceCandidateSha: string, evidenceCommitSha: string): void {
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", sourceCandidateSha, evidenceCommitSha], {
    stdio: "ignore",
  });
  if (ancestor.status !== 0 || ancestor.error) {
    throw new Error("Source candidate must be an ancestor of the evidence commit.");
  }
  if (sourceCandidateSha === evidenceCommitSha) return;
  const changed = runGit(["diff", "--name-only", `${sourceCandidateSha}..${evidenceCommitSha}`], "utf8")
    .split("\n")
    .filter(Boolean);
  if (changed.some((path) => !isPostCandidateEvidencePath(path))) {
    throw new Error("Post-candidate changes are not limited to allowlisted immutable evidence.");
  }
}

async function main(): Promise<void> {
  const outputPath = process.env.MARKETPLACE_MEDIA_BINDING_PATH;
  if (!outputPath) throw new Error("MARKETPLACE_MEDIA_BINDING_PATH is required.");
  const sourceCandidateSha = fullLowercaseHash(
    process.env.MARKETPLACE_MEDIA_SOURCE_CANDIDATE_SHA ?? "",
    [40, 64],
    "source candidate SHA",
  );
  const evidenceCommitSha = fullLowercaseHash(
    process.env.MARKETPLACE_MEDIA_EVIDENCE_COMMIT_SHA ?? "",
    [40, 64],
    "evidence commit SHA",
  );
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const status = runGit(["status", "--porcelain", "--untracked-files=all"], "utf8").trim();
  if (status) throw new Error("Post-commit media binding requires a clean checkout.");
  const checkedOutSha = runGit(["rev-parse", "HEAD"], "utf8").trim();
  if (checkedOutSha !== evidenceCommitSha) throw new Error("Evidence commit SHA does not equal checked-out HEAD.");
  assertEvidenceOnlyDescendant(sourceCandidateSha, evidenceCommitSha);
  const archive = spawnSync("git", ["archive", "--format=tar", sourceCandidateSha], {
    encoding: null,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (archive.status !== 0 || archive.error) throw new Error("Could not hash the release archive.");
  const assetEvidenceBytes = checkedInFile(root, ASSET_EVIDENCE_PATH);
  const reviewBytes = checkedInFile(root, VISUAL_REVIEW_PATH);
  const binding = buildMarketplaceMediaReleaseBinding({
    sourceCandidateSha,
    evidenceCommitSha,
    sourceCandidateBuildHash: sha256(archive.stdout),
    currentCaptureSourceSha256: await marketplaceCaptureSourceSha256(root),
    assetEvidenceBytes,
    reviewBytes,
    readAsset: (path) => checkedInFile(root, path),
  });
  writeDeterministicJson(outputPath, binding);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    process.stderr.write("Marketplace media post-commit binding failed.\n");
    process.exitCode = 1;
  });
}
