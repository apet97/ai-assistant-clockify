import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface MarketplaceAssetRecord {
  file: string;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  durationSeconds?: number;
}

export const MARKETPLACE_CAPTURE_SOURCE_PATHS = [
  "dist/ui/index.html",
  "dist/ui/index.css",
  "dist/ui/main.js",
  "docs/marketplace/assets/banner.svg",
  "docs/marketplace/assets/icon.svg",
  "scripts/evidence/marketplace-media-contract.ts",
  "scripts/generate-marketplace-media.ts",
  "tests/e2e/fixtures/server.mjs",
] as const;

export function sha256(value: string | NodeJS.ArrayBufferView): string {
  return createHash("sha256").update(value).digest("hex");
}

export function marketplaceAssetSetSha256(assets: MarketplaceAssetRecord[]): string {
  return sha256(JSON.stringify(assets));
}

export async function marketplaceCaptureSourceSha256(root = process.cwd()): Promise<string> {
  const hash = createHash("sha256");
  for (const relativePath of MARKETPLACE_CAPTURE_SOURCE_PATHS) {
    hash
      .update(relativePath)
      .update("\0")
      .update(await readFile(resolve(root, relativePath)))
      .update("\0");
  }
  return hash.digest("hex");
}
