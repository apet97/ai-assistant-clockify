import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  bindLegacyBackupMetadata,
  captureBackupBoundary,
} from "../../scripts/lib/legacy-backup-metadata.js";

const tempDirectories: string[] = [];

function fixture(): {
  backupPath: string;
  checksumPath: string;
  legacyMetadataPath: string;
  boundaryPath: string;
  outputPath: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "legacy-backup-metadata-"));
  tempDirectories.push(directory);
  const backupPath = join(directory, "backup.sqlite");
  const checksumPath = `${backupPath}.sha256`;
  const legacyMetadataPath = `${backupPath}.json`;
  const boundaryPath = join(directory, "pre-backup-boundary.txt");
  const outputPath = `${backupPath}.release.json`;
  const bytes = Buffer.from("checksum-bound-test-backup", "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(backupPath, bytes);
  writeFileSync(checksumPath, `${digest}  backup.sqlite\n`);
  writeFileSync(legacyMetadataPath, `${JSON.stringify({
    format: 1,
    createdAt: "2026-07-19T01:00:05.000Z",
    source: "/data/ai-assistant.sqlite",
    bytes: bytes.byteLength,
    sha256: digest,
  })}\n`);
  return { backupPath, checksumPath, legacyMetadataPath, boundaryPath, outputPath };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("legacy production backup metadata binding", () => {
  it("emits a separate format-2 sidecar from a pre-backup boundary without changing any input", async () => {
    const input = fixture();
    const originalBackup = readFileSync(input.backupPath);
    const originalChecksum = readFileSync(input.checksumPath);
    const originalMetadata = readFileSync(input.legacyMetadataPath);
    await captureBackupBoundary({
      outputPath: input.boundaryPath,
      now: () => new Date("2026-07-19T01:00:00.000Z"),
    });
    const originalBoundary = readFileSync(input.boundaryPath);

    const result = await bindLegacyBackupMetadata({
      ...input,
    });

    expect(result).toEqual({
      format: 2,
      dataAsOf: "2026-07-19T01:00:00.000Z",
      createdAt: "2026-07-19T01:00:05.000Z",
      bytes: originalBackup.byteLength,
      sha256: createHash("sha256").update(originalBackup).digest("hex"),
      provenance: "verified_format_1_with_pre_backup_boundary",
    });
    expect(JSON.parse(readFileSync(input.outputPath, "utf8"))).toEqual(result);
    expect(readFileSync(input.backupPath)).toEqual(originalBackup);
    expect(readFileSync(input.checksumPath)).toEqual(originalChecksum);
    expect(readFileSync(input.legacyMetadataPath)).toEqual(originalMetadata);
    expect(readFileSync(input.boundaryPath)).toEqual(originalBoundary);
  });

  it("rejects a boundary captured after the legacy backup completed", async () => {
    const input = fixture();
    await captureBackupBoundary({
      outputPath: input.boundaryPath,
      now: () => new Date("2026-07-19T01:00:06.000Z"),
    });
    await expect(bindLegacyBackupMetadata({
      ...input,
    })).rejects.toThrow(/pre-backup boundary/u);
    expect(existsSync(input.outputPath)).toBe(false);
  });

  it("rejects checksum drift and refuses to overwrite prior release metadata", async () => {
    const input = fixture();
    await captureBackupBoundary({
      outputPath: input.boundaryPath,
      now: () => new Date("2026-07-19T01:00:00.000Z"),
    });
    writeFileSync(input.backupPath, "tampered");
    await expect(bindLegacyBackupMetadata({
      ...input,
    })).rejects.toThrow(/checksum/u);

    const clean = fixture();
    await captureBackupBoundary({
      outputPath: clean.boundaryPath,
      now: () => new Date("2026-07-19T01:00:00.000Z"),
    });
    writeFileSync(clean.outputPath, "preserve");
    await expect(bindLegacyBackupMetadata({
      ...clean,
    })).rejects.toThrow(/already exists/u);
    expect(readFileSync(clean.outputPath, "utf8")).toBe("preserve");
  });

  it("captures the boundary from candidate code and never overwrites it", async () => {
    const input = fixture();
    await expect(captureBackupBoundary({
      outputPath: input.boundaryPath,
      now: () => new Date("2026-07-19T01:00:00.000Z"),
    })).resolves.toBe("2026-07-19T01:00:00.000Z");
    await expect(captureBackupBoundary({
      outputPath: input.boundaryPath,
      now: () => new Date("2026-07-19T01:00:01.000Z"),
    })).rejects.toThrow(/already exists/u);
    expect(readFileSync(input.boundaryPath, "utf8")).toBe("2026-07-19T01:00:00.000Z\n");
  });
});
