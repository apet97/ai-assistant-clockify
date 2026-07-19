import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, rm, stat } from "node:fs/promises";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_CHECKSUM_BYTES = 1_024;
const MAX_METADATA_BYTES = 1_048_576;
const MAX_BOUNDARY_BYTES = 128;

export interface BindLegacyBackupMetadataOptions {
  backupPath: string;
  checksumPath: string;
  legacyMetadataPath: string;
  boundaryPath: string;
  outputPath: string;
}

export interface CaptureBackupBoundaryOptions {
  outputPath: string;
  now?: () => Date;
}

export interface BoundBackupMetadata {
  format: 2;
  dataAsOf: string;
  createdAt: string;
  bytes: number;
  sha256: string;
  provenance: "verified_format_1_with_pre_backup_boundary";
}

function exactIso(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is malformed`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${label} is malformed`);
  }
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is malformed`);
  }
  return value as Record<string, unknown>;
}

async function assertRegularInput(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} is not a regular file`);
}

async function sha256File(path: string): Promise<{ digest: string; bytes: number }> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return { digest: hash.digest("hex"), bytes: (await stat(path)).size };
}

/** Capture the RPO boundary in candidate code immediately before the remote
 * backup command. The mode-0600 file is create-only, so a prior timestamp can
 * never be silently replaced. */
export async function captureBackupBoundary(
  options: CaptureBackupBoundaryOptions,
): Promise<string> {
  const capturedAt = (options.now ?? (() => new Date()))().toISOString();
  let created = false;
  try {
    const output = await open(options.outputPath, "wx", 0o600);
    created = true;
    try {
      await output.writeFile(`${capturedAt}\n`, "utf8");
      await output.sync();
    } finally {
      await output.close();
    }
  } catch (error) {
    if (created) await rm(options.outputPath, { force: true }).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("pre-backup boundary output already exists");
    }
    throw error;
  }
  return capturedAt;
}

/**
 * Bind a legacy production format-1 sidecar to a conservative, pre-snapshot
 * UTC boundary. All source files remain read-only and byte-identical; the
 * format-2 release sidecar is a new mode-0600 file and is never overwritten.
 */
export async function bindLegacyBackupMetadata(
  options: BindLegacyBackupMetadataOptions,
): Promise<BoundBackupMetadata> {
  await Promise.all([
    assertRegularInput(options.backupPath, "backup"),
    assertRegularInput(options.checksumPath, "checksum sidecar"),
    assertRegularInput(options.legacyMetadataPath, "legacy metadata sidecar"),
    assertRegularInput(options.boundaryPath, "pre-backup boundary"),
  ]);
  const [checksumInfo, metadataInfo, boundaryInfo] = await Promise.all([
    stat(options.checksumPath),
    stat(options.legacyMetadataPath),
    stat(options.boundaryPath),
  ]);
  if (checksumInfo.size > MAX_CHECKSUM_BYTES) throw new Error("checksum sidecar is too large");
  if (metadataInfo.size > MAX_METADATA_BYTES) throw new Error("legacy metadata sidecar is too large");
  if (boundaryInfo.size > MAX_BOUNDARY_BYTES) throw new Error("pre-backup boundary is too large");

  const [checksumLine, rawMetadata, rawBoundary, backup] = await Promise.all([
    readFile(options.checksumPath, "utf8"),
    readFile(options.legacyMetadataPath, "utf8"),
    readFile(options.boundaryPath, "utf8"),
    sha256File(options.backupPath),
  ]);
  const expectedDigest = checksumLine.trim().split(/\s+/u)[0] ?? "";
  if (!SHA256_PATTERN.test(expectedDigest) || expectedDigest !== backup.digest) {
    throw new Error("backup checksum does not match its sidecar");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMetadata);
  } catch {
    throw new Error("legacy backup metadata is not valid JSON");
  }
  const legacy = object(parsed, "legacy backup metadata");
  if (
    legacy.format !== 1
    || legacy.sha256 !== backup.digest
    || legacy.bytes !== backup.bytes
  ) {
    throw new Error("legacy backup metadata does not bind the backup bytes");
  }
  const dataAsOf = exactIso(rawBoundary.trim(), "pre-backup boundary");
  const createdAt = exactIso(legacy.createdAt, "legacy backup timestamp");
  if (Date.parse(dataAsOf) > Date.parse(createdAt)) {
    throw new Error("pre-backup boundary must not be later than backup completion");
  }

  const result: BoundBackupMetadata = {
    format: 2,
    dataAsOf,
    createdAt,
    bytes: backup.bytes,
    sha256: backup.digest,
    provenance: "verified_format_1_with_pre_backup_boundary",
  };
  let created = false;
  try {
    const output = await open(options.outputPath, "wx", 0o600);
    created = true;
    try {
      await output.writeFile(`${JSON.stringify(result, null, 2)}\n`, "utf8");
      await output.sync();
    } finally {
      await output.close();
    }
  } catch (error) {
    if (created) await rm(options.outputPath, { force: true }).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("release metadata output already exists");
    }
    throw error;
  }
  return result;
}
