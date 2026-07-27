import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { validateRestoreEvidence } from "./operational-release-evidence.js";

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_JSON_BYTES = 1_048_576;
/** The backup and completed restore drill must still be recent when the upload
 * stop gate runs. This is deliberately short enough to prevent replaying a
 * prior release's still-valid recovery set, while leaving room for the bounded
 * online backup, transfer, and isolated restore procedure. */
export const PREDEPLOY_EVIDENCE_MAX_AGE_MS = 60 * 60 * 1_000;
type JsonObject = Record<string, unknown>;

export interface PredeployBackupGateInput {
  releaseSha: string;
  releaseBuildHash: string;
  serverArtifactSha256: string;
  backupSha256: string;
  backupBytes: number;
  checksumSha256: string;
  /** The database this deploy is protecting, matched against the backup's own
   * recorded `metadata.source`. Required: with two databases on the volume a
   * backup of the WRONG one passes every other check in this gate. */
  expectedSourceDatabasePath: string;
  metadata: unknown;
  restoreEvidence: unknown;
}

export interface PredeployBackupGateOptions {
  /** Deterministic test seam. The CLI always supplies a fresh UTC clock value
   * immediately before it evaluates the stop gate. */
  now?: Date;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is malformed`);
  return value as JsonObject;
}

function exactIso(value: unknown, label: string): string {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) {
    throw new Error(`${label} is malformed`);
  }
  return value;
}

/** Verify the live backup bytes, both sidecars, isolated restore proof, and exact
 * candidate identity. The CLI separately proves all four files remain on the
 * mounted encrypted recovery volume immediately before `railway up`. */
export function validatePredeployBackupGate(
  input: PredeployBackupGateInput,
  options: PredeployBackupGateOptions = {},
): void {
  const gateNow = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(gateNow)) throw new Error("predeploy gate clock is malformed");
  if (!SHA_PATTERN.test(input.releaseSha)) throw new Error("predeploy release SHA is malformed");
  if (!SHA256_PATTERN.test(input.releaseBuildHash) || !SHA256_PATTERN.test(input.serverArtifactSha256)) {
    throw new Error("predeploy release hashes are malformed");
  }
  if (
    !SHA256_PATTERN.test(input.backupSha256)
    || !SHA256_PATTERN.test(input.checksumSha256)
    || input.backupSha256 !== input.checksumSha256
    || !Number.isSafeInteger(input.backupBytes)
    || input.backupBytes <= 0
  ) throw new Error("predeploy backup checksum is invalid");

  const metadata = object(input.metadata, "predeploy backup metadata");
  if (
    metadata.format !== 2
    || metadata.sha256 !== input.backupSha256
    || metadata.bytes !== input.backupBytes
  ) throw new Error("predeploy backup metadata does not bind the backup bytes");
  // `backupDatabase` has always RECORDED metadata.source, but no gate read it.
  // Once two databases exist on the volume -- the v1 file and the new v2 file --
  // a perfectly valid backup OF THE WRONG DATABASE passes every other check
  // here: correct checksum, correct byte count, clean integrity, real schema.
  // The deploy must name which database it is protecting.
  if (typeof metadata.source !== "string" || metadata.source.length === 0) {
    throw new Error("predeploy backup metadata does not record its source database");
  }
  if (metadata.source !== input.expectedSourceDatabasePath) {
    throw new Error("predeploy backup was taken from a different database than this deploy protects");
  }
  const dataAsOf = Date.parse(exactIso(metadata.dataAsOf, "predeploy backup dataAsOf"));
  const backupCreatedAt = Date.parse(exactIso(metadata.createdAt, "predeploy backup createdAt"));

  const restore = object(input.restoreEvidence, "predeploy restore evidence");
  validateRestoreEvidence(restore, {
    releaseSha: input.releaseSha,
    buildHash: input.releaseBuildHash,
    serverArtifactSha256: input.serverArtifactSha256,
  });
  const checks = object(restore.checks, "predeploy restore checks");
  const checksum = object(checks.checksum, "predeploy restore checksum");
  const restoreMetadata = object(checks.metadata, "predeploy restore metadata");
  if (
    checksum.digest !== input.backupSha256
    || checksum.bytes !== input.backupBytes
    || restoreMetadata.dataAsOf !== metadata.dataAsOf
    || restoreMetadata.backupCreatedAt !== metadata.createdAt
  ) throw new Error("predeploy restore evidence does not bind the selected backup");

  const recovery = object(restore.recovery, "predeploy restore recovery");
  const incidentAt = Date.parse(exactIso(recovery.incidentAt, "predeploy restore incidentAt"));
  const drillStartedAt = Date.parse(exactIso(recovery.drillStartedAt, "predeploy restore drillStartedAt"));
  const readinessConfirmedAt = Date.parse(exactIso(
    recovery.readinessConfirmedAt,
    "predeploy restore readinessConfirmedAt",
  ));
  if (
    dataAsOf > backupCreatedAt
    || backupCreatedAt > incidentAt
    || incidentAt > drillStartedAt
    || drillStartedAt > readinessConfirmedAt
  ) throw new Error("predeploy backup and restore timeline is misordered");
  if (backupCreatedAt > gateNow) throw new Error("predeploy backup evidence is future-dated");
  if (readinessConfirmedAt > gateNow) throw new Error("predeploy restore evidence is future-dated");
  if (gateNow - backupCreatedAt > PREDEPLOY_EVIDENCE_MAX_AGE_MS) {
    throw new Error("predeploy backup evidence is stale");
  }
  if (gateNow - readinessConfirmedAt > PREDEPLOY_EVIDENCE_MAX_AGE_MS) {
    throw new Error("predeploy restore evidence is stale");
  }
}

function assertRegularFileWithin(path: string, recoveryVolume: string): string {
  const absolute = resolve(path);
  const info = lstatSync(absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("predeploy evidence path is unsafe");
  const real = realpathSync(absolute);
  const child = relative(recoveryVolume, real);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`)) {
    throw new Error("predeploy evidence must remain inside the encrypted recovery volume");
  }
  return real;
}

function readJson(path: string, label: string): JsonObject {
  if (statSync(path).size > MAX_JSON_BYTES) throw new Error(`${label} is too large`);
  try {
    return object(JSON.parse(readFileSync(path, "utf8")) as unknown, label);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON`);
    throw error;
  }
}

async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return { sha256: hash.digest("hex"), bytes: statSync(path).size };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const recoveryVolume = realpathSync(required("RECOVERY_VOLUME"));
  const diskInfo = execFileSync("/usr/sbin/diskutil", ["info", recoveryVolume], { encoding: "utf8" });
  if (!/(?:FileVault|Encrypted):\s+Yes/iu.test(diskInfo)) {
    throw new Error("recovery volume is not verified encrypted storage");
  }
  const backupPath = assertRegularFileWithin(required("PREDEPLOY_BACKUP_PATH"), recoveryVolume);
  const checksumPath = assertRegularFileWithin(required("PREDEPLOY_BACKUP_CHECKSUM_PATH"), recoveryVolume);
  const metadataPath = assertRegularFileWithin(required("PREDEPLOY_BACKUP_METADATA_PATH"), recoveryVolume);
  const restorePath = assertRegularFileWithin(required("PREDEPLOY_RESTORE_EVIDENCE_PATH"), recoveryVolume);
  if (statSync(checksumPath).size > 1_024) throw new Error("predeploy checksum sidecar is too large");
  const backup = await hashFile(backupPath);
  const checksumSha256 = readFileSync(checksumPath, "utf8").trim().split(/\s+/u)[0] ?? "";
  const gateNow = new Date();
  validatePredeployBackupGate({
    releaseSha: required("RELEASE_SHA"),
    releaseBuildHash: required("RELEASE_BUILD_HASH"),
    serverArtifactSha256: required("RELEASE_SERVER_ARTIFACT_SHA256"),
    backupSha256: backup.sha256,
    backupBytes: backup.bytes,
    checksumSha256,
    // The database currently in service is the one this deploy must have a
    // backup of -- never the new target path a cutover is moving TO.
    expectedSourceDatabasePath: required("PREDEPLOY_SOURCE_DATABASE_PATH"),
    metadata: readJson(metadataPath, "predeploy backup metadata"),
    restoreEvidence: readJson(restorePath, "predeploy restore evidence"),
  }, { now: gateNow });
  process.stdout.write(`Verified encrypted predeploy backup and restore gate for ${required("RELEASE_SHA")}.\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "predeploy backup gate failed"}\n`);
    process.exitCode = 1;
  });
}
