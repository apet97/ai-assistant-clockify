import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { resolveClockifyApiBase } from "../clockify/api-base.js";
import { decryptSecret } from "./encryption.js";
import { LATEST_SCHEMA_VERSION } from "./schema.js";

type VerificationCheck =
  | "checksum"
  | "metadata"
  | "integrity"
  | "schema"
  | "installation"
  | "token_backed_read"
  | "application_readiness";

export class RestoreVerificationError extends Error {
  constructor(
    readonly check: VerificationCheck,
    readonly code: string,
    readonly httpStatus?: number,
  ) {
    super(`Restored database verification failed: ${check}/${code}`);
    this.name = "RestoreVerificationError";
  }
}

interface BackupMetadata {
  format: 2;
  dataAsOf: string;
  createdAt: string;
  bytes: number;
  sha256: string;
}

interface InstallationVerificationRow {
  addon_token_ciphertext: string;
  api_url: string | null;
  backend_url: string | null;
}

export interface RestoreVerificationEvidence {
  format: 1;
  conclusion: "passed";
  checks: {
    checksum: {
      status: "passed";
      algorithm: "sha256";
      bytes: number;
      digest: string;
    };
    metadata: {
      status: "passed";
      format: 2;
      dataAsOf: string;
      backupCreatedAt: string;
    };
    integrity: {
      status: "passed";
      sourceResult: "ok";
      migratedResult: "ok";
    };
    schema: {
      status: "passed";
      sourceUserVersion: number;
      userVersion: number;
      migration: "not_required" | "candidate_private_clone";
      requiredTables: number;
      requiredColumns: number;
    };
    installation: { status: "passed"; activeCount: number };
    tokenBackedRead: {
      status: "passed";
      endpoint: "GET /user";
      httpStatus: 200;
      redirects: "blocked";
    };
    applicationReadiness: {
      status: "passed";
      endpoint: "GET /health";
      httpStatus: 200;
      startupInitialization: "production";
      serverArtifact: "dist/server/server.js";
      portBinding: "child_ephemeral_ipc";
      releaseSha: string;
      releaseBuildHash: string;
      serverArtifactSha256: string;
      shutdownVerification: ShutdownVerificationProof;
    };
  };
  timingsMs: {
    checksum: number;
    integrity: number;
    schema: number;
    tokenBackedRead: number;
    applicationReadiness: number;
    total: number;
  };
  recovery?: {
    drillStartedAt: string;
    incidentAt: string;
    dataAsOf: string;
    backupCreatedAt: string;
    readinessConfirmedAt: string;
    rtoMs: number;
    rpoMs: number;
  };
}

export interface ApplicationReadinessProof {
  endpoint: "GET /health";
  httpStatus: 200;
  startupInitialization: "production";
  serverArtifact: "dist/server/server.js";
  portBinding: "child_ephemeral_ipc";
  releaseSha: string;
  releaseBuildHash: string;
  serverArtifactSha256: string;
  readinessConfirmedAt: string;
  elapsedMs: number;
  shutdownVerification: ShutdownVerificationProof;
}

export interface ShutdownVerificationProof {
  childExitCode: 0;
  databaseIntegrity: "ok";
  writerLock: "available";
}

export interface RestoreVerificationFailure {
  format: 1;
  conclusion: "failed";
  failedCheck: VerificationCheck | "unknown";
  errorCode: string;
  httpStatus?: number;
}

export interface VerifyRestoredDatabaseOptions {
  restoredPath: string;
  checksumPath: string;
  metadataPath: string;
  encryptionKey: string;
  previousEncryptionKey?: string;
  releaseSha: string;
  releaseBuildHash: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  monotonicNow?: () => number;
  drillStartedAt?: string;
  incidentAt?: string;
  /** Resolves only after the production server startup path returns HTTP 200
   *  from GET /health and the one-off instance has stopped cleanly. */
  applicationReadinessProbe: (privateClonePath: string) => Promise<ApplicationReadinessProof>;
}

const REQUIRED_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  installations: [
    "workspace_id",
    "addon_token_ciphertext",
    "api_url",
    "backend_url",
    "status",
    "generation",
    "lifecycle_issued_at",
    "deletion_started_at",
  ],
  installation_attestations: [
    "workspace_id",
    "workspace_sha256",
    "installation_generation",
    "token_fingerprint_sha256",
    "release_sha",
    "release_build_hash",
    "server_artifact_sha256",
    "source_relationship",
    "source_binding_sha256",
    "manifest_sha256",
    "installed_at",
  ],
  retired_installation_tokens: [
    "token_fingerprint_sha256",
    "retired_at",
  ],
  lifecycle_authority_watermarks: [
    "workspace_fingerprint_sha256",
    "lifecycle_issued_at",
    "authority_state",
    "installation_generation",
    "recorded_at",
    "expires_at",
  ],
  pending_confirmations: [
    "operation_id",
    "operation_hash",
    "nonce_hash",
    "operation_json",
    "agent_state_json",
  ],
  operation_runs: ["id", "workspace_id", "status", "operation_hash"],
  operation_steps: ["operation_id", "status", "queued_at", "dispatched_at"],
  intent_capabilities: ["capability_hash", "capability_json"],
  intent_capability_usage: ["capability_id"],
  artifacts: [],
  retention_runs: [],
};

export const RESTORE_REQUIRED_COLUMN_COUNT = Object.values(REQUIRED_SCHEMA)
  .reduce((count, columns) => count + columns.length, 0);
export const RESTORE_REQUIRED_TABLE_COUNT = Object.keys(REQUIRED_SCHEMA).length;
export const MIN_SUPPORTED_RESTORE_SOURCE_SCHEMA_VERSION = 7;
const SOURCE_REQUIRED_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  installations: [
    "addon_token_ciphertext",
    "api_url",
    "backend_url",
    "status",
  ],
};
const RELEASE_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseIso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp).toISOString() === value ? value : undefined;
}

async function hashFile(path: string): Promise<{ digest: string; bytes: number }> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return { digest: hash.digest("hex"), bytes: (await stat(path)).size };
  } catch {
    throw new RestoreVerificationError("checksum", "candidate_read_failed");
  }
}

async function createPrivateClone(sourcePath: string): Promise<{
  directory: string;
  path: string;
}> {
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "ai-assistant-restore-verify-"));
    await chmod(directory, 0o700);
    const path = join(directory, "candidate.sqlite");
    await copyFile(sourcePath, path);
    await chmod(path, 0o600);
    return { directory, path };
  } catch {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw new RestoreVerificationError("checksum", "candidate_clone_failed");
  }
}

async function removePrivateClone(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    throw new RestoreVerificationError("checksum", "clone_cleanup_failed");
  }
}

async function verifyChecksumAndMetadata(
  options: VerifyRestoredDatabaseOptions,
  candidatePath: string,
): Promise<{
  digest: string;
  bytes: number;
  metadata: BackupMetadata;
}> {
  let checksumLine: string;
  let rawMetadata: string;
  try {
    [checksumLine, rawMetadata] = await Promise.all([
      readFile(options.checksumPath, "utf8"),
      readFile(options.metadataPath, "utf8"),
    ]);
  } catch {
    throw new RestoreVerificationError("checksum", "sidecar_read_failed");
  }
  const expectedDigest = checksumLine.trim().split(/\s+/u)[0];
  if (!/^[a-f0-9]{64}$/u.test(expectedDigest)) {
    throw new RestoreVerificationError("checksum", "invalid_sidecar");
  }
  const candidate = await hashFile(candidatePath);
  if (candidate.digest !== expectedDigest) {
    throw new RestoreVerificationError("checksum", "checksum_mismatch");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMetadata);
  } catch {
    throw new RestoreVerificationError("metadata", "invalid_json");
  }
  const record = asRecord(parsed);
  if (record?.format !== 2) {
    throw new RestoreVerificationError("metadata", "stale_metadata");
  }
  const dataAsOf = parseIso(record.dataAsOf);
  const createdAt = parseIso(record?.createdAt);
  if (
    dataAsOf === undefined ||
    createdAt === undefined ||
    typeof record.bytes !== "number" ||
    !Number.isSafeInteger(record.bytes) ||
    record.bytes < 0 ||
    typeof record.sha256 !== "string" ||
    !SHA256_PATTERN.test(record.sha256)
  ) {
    throw new RestoreVerificationError("metadata", "invalid_shape");
  }
  if (Date.parse(dataAsOf) > Date.parse(createdAt)) {
    throw new RestoreVerificationError("metadata", "invalid_timeline");
  }
  if (record.sha256 !== candidate.digest || record.bytes !== candidate.bytes) {
    throw new RestoreVerificationError("metadata", "candidate_mismatch");
  }
  return {
    ...candidate,
    metadata: {
      format: 2,
      dataAsOf,
      createdAt,
      bytes: record.bytes,
      sha256: record.sha256,
    },
  };
}

function assertSchema(
  db: Database.Database,
  expectedVersion: number,
  requiredSchema: Readonly<Record<string, readonly string[]>>,
  mismatchCode: string,
): void {
  const userVersion = db.pragma("user_version", { simple: true });
  if (userVersion !== expectedVersion) {
    throw new RestoreVerificationError("schema", mismatchCode);
  }
  const existingTables = new Set((db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  ).all() as Array<{ name: string }>).map((row) => row.name));
  for (const [table, requiredColumns] of Object.entries(requiredSchema)) {
    if (!existingTables.has(table)) {
      throw new RestoreVerificationError("schema", mismatchCode);
    }
    const columns = new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>)
      .map((row) => row.name));
    if (requiredColumns.some((column) => !columns.has(column))) {
      throw new RestoreVerificationError("schema", mismatchCode);
    }
  }
}

function assertSupportedSourceSchema(db: Database.Database): number {
  const userVersion = db.pragma("user_version", { simple: true });
  if (
    typeof userVersion !== "number"
    || !Number.isSafeInteger(userVersion)
    || userVersion < MIN_SUPPORTED_RESTORE_SOURCE_SCHEMA_VERSION
    || userVersion > LATEST_SCHEMA_VERSION
  ) {
    throw new RestoreVerificationError("schema", "schema_version_mismatch");
  }
  assertSchema(db, userVersion, SOURCE_REQUIRED_SCHEMA, "source_schema_incompatible");
  return userVersion;
}

function verifyMigratedClone(path: string): void {
  let db: Database.Database;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
  } catch {
    throw new RestoreVerificationError("schema", "post_migration_database_open_failed");
  }
  try {
    const integrity = db.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") {
      throw new RestoreVerificationError("integrity", "post_migration_integrity_failed");
    }
    assertSchema(
      db,
      LATEST_SCHEMA_VERSION,
      REQUIRED_SCHEMA,
      "post_migration_schema_mismatch",
    );
  } finally {
    db.close();
  }
}

function decryptInstallationToken(
  ciphertext: string,
  currentKey: string,
  previousKey?: string,
): string {
  try {
    return decryptSecret(ciphertext, currentKey);
  } catch {
    if (previousKey !== undefined) {
      try {
        return decryptSecret(ciphertext, previousKey);
      } catch {
        // The stable failure below deliberately omits ciphertext and key detail.
      }
    }
    throw new RestoreVerificationError("installation", "token_decryption_failed");
  }
}

function readInstallation(db: Database.Database): {
  activeCount: number;
  token: string;
  apiBase: string;
} {
  const activeCount = (db.prepare(
    "SELECT COUNT(*) AS count FROM installations WHERE status = 'active'",
  ).get() as { count: number }).count;
  const row = db.prepare(
    `SELECT addon_token_ciphertext, api_url, backend_url
       FROM installations
      WHERE status = 'active'
      ORDER BY workspace_id
      LIMIT 1`,
  ).get() as InstallationVerificationRow | undefined;
  if (!row || activeCount < 1) {
    throw new RestoreVerificationError("installation", "no_active_installation");
  }
  let apiBase: string;
  try {
    apiBase = resolveClockifyApiBase({
      apiUrl: row.api_url ?? undefined,
      backendUrl: row.backend_url ?? undefined,
    });
  } catch {
    throw new RestoreVerificationError("installation", "invalid_service_url");
  }
  return {
    activeCount,
    token: row.addon_token_ciphertext,
    apiBase,
  };
}

async function tokenBackedRead(
  fetchImpl: typeof fetch,
  apiBase: string,
  token: string,
  timeoutMs: number,
): Promise<void> {
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(`${apiBase}/user`, {
      method: "GET",
      headers: { "X-Addon-Token": token },
      redirect: "manual",
      signal,
    });
  } catch {
    throw new RestoreVerificationError(
      "token_backed_read",
      signal.aborted ? "timeout" : "request_failed",
    );
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new RestoreVerificationError("token_backed_read", "http_status", response.status);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new RestoreVerificationError("token_backed_read", "malformed_response");
  }
  const user = asRecord(payload);
  if (typeof user?.id !== "string" || user.id.length === 0) {
    throw new RestoreVerificationError("token_backed_read", "malformed_response");
  }
}

function elapsedMs(start: number, end: number): number {
  return Math.max(0, Math.round((end - start) * 10) / 10);
}

function recoveryEvidence(
  options: VerifyRestoredDatabaseOptions,
  dataAsOf: string,
  backupCreatedAt: string,
  readinessConfirmedAt: string,
): RestoreVerificationEvidence["recovery"] {
  if (options.drillStartedAt === undefined && options.incidentAt === undefined) return undefined;
  const drillStartedAt = parseIso(options.drillStartedAt);
  const incidentAt = parseIso(options.incidentAt);
  if (drillStartedAt === undefined || incidentAt === undefined) {
    throw new RestoreVerificationError("metadata", "invalid_recovery_timestamps");
  }
  const readinessAt = parseIso(readinessConfirmedAt);
  if (readinessAt === undefined) {
    throw new RestoreVerificationError("application_readiness", "invalid_readiness_proof");
  }
  const rtoMs = Date.parse(readinessAt) - Date.parse(drillStartedAt);
  const rpoMs = Date.parse(incidentAt) - Date.parse(dataAsOf);
  if (rtoMs < 0 || rpoMs < 0) {
    throw new RestoreVerificationError("metadata", "invalid_recovery_timestamps");
  }
  return {
    drillStartedAt,
    incidentAt,
    dataAsOf,
    backupCreatedAt,
    readinessConfirmedAt: readinessAt,
    rtoMs,
    rpoMs,
  };
}

async function verifyApplicationReadiness(
  options: VerifyRestoredDatabaseOptions,
  privateClonePath: string,
): Promise<ApplicationReadinessProof> {
  if (typeof options.applicationReadinessProbe !== "function") {
    throw new RestoreVerificationError("application_readiness", "readiness_probe_required");
  }
  let proof: ApplicationReadinessProof;
  try {
    proof = await options.applicationReadinessProbe(privateClonePath);
  } catch (error) {
    if (error instanceof RestoreVerificationError && error.check === "application_readiness") throw error;
    throw new RestoreVerificationError("application_readiness", "readiness_probe_failed");
  }
  const record = asRecord(proof);
  const shutdown = asRecord(record?.shutdownVerification);
  if (
    record?.endpoint !== "GET /health"
    || record.httpStatus !== 200
    || record.startupInitialization !== "production"
    || record.serverArtifact !== "dist/server/server.js"
    || record.portBinding !== "child_ephemeral_ipc"
    || typeof record.serverArtifactSha256 !== "string"
    || !SHA256_PATTERN.test(record.serverArtifactSha256)
    || parseIso(record.readinessConfirmedAt) === undefined
    || typeof record.elapsedMs !== "number"
    || !Number.isFinite(record.elapsedMs)
    || record.elapsedMs < 0
    || record.elapsedMs > 120_000
    || shutdown?.childExitCode !== 0
    || shutdown.databaseIntegrity !== "ok"
    || shutdown.writerLock !== "available"
  ) {
    throw new RestoreVerificationError("application_readiness", "invalid_readiness_proof");
  }
  if (
    record.releaseSha !== options.releaseSha
    || record.releaseBuildHash !== options.releaseBuildHash
  ) {
    throw new RestoreVerificationError("application_readiness", "release_identity_mismatch");
  }
  return proof;
}

/**
 * Verify a caller-owned restored candidate without ever writing it. A private
 * mode-0600 clone is checksum-bound first; all static checks and the exact
 * production-startup probe exercise only that clone, which is always removed.
 * The returned object contains only
 * bounded counts, hashes, fixed statuses, and timings; workspace/user/add-on
 * identifiers, tokens, URLs, response bodies, and child logs never enter
 * evidence or errors.
 */
export async function verifyRestoredDatabase(
  options: VerifyRestoredDatabaseOptions,
): Promise<RestoreVerificationEvidence> {
  if (typeof options.applicationReadinessProbe !== "function") {
    throw new RestoreVerificationError("application_readiness", "readiness_probe_required");
  }
  if (
    !RELEASE_SHA_PATTERN.test(options.releaseSha)
    || !SHA256_PATTERN.test(options.releaseBuildHash)
  ) {
    throw new RestoreVerificationError("application_readiness", "release_identity_required");
  }
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const totalStarted = monotonicNow();
  const privateClone = await createPrivateClone(options.restoredPath);
  try {
    const checksum = await verifyChecksumAndMetadata(options, privateClone.path);
    const checksumFinished = monotonicNow();

    let db: Database.Database;
    try {
      db = new Database(privateClone.path, { readonly: true, fileMustExist: true });
    } catch {
      throw new RestoreVerificationError("integrity", "database_open_failed");
    }
    let installation: ReturnType<typeof readInstallation>;
    let sourceUserVersion: number;
    let integrityFinished: number;
    let schemaFinished: number;
    let tokenReadFinished: number;
    let staticVerificationFinished: number;
    try {
      const integrity = db.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") {
        throw new RestoreVerificationError("integrity", "integrity_check_failed");
      }
      integrityFinished = monotonicNow();
      sourceUserVersion = assertSupportedSourceSchema(db);
      schemaFinished = monotonicNow();
      installation = readInstallation(db);
      const decryptedToken = decryptInstallationToken(
        installation.token,
        options.encryptionKey,
        options.previousEncryptionKey,
      );
      const fetchImpl = options.fetchImpl ?? fetch;
      await tokenBackedRead(
        fetchImpl,
        installation.apiBase,
        decryptedToken,
        options.timeoutMs ?? 10_000,
      );
      tokenReadFinished = monotonicNow();
      staticVerificationFinished = monotonicNow();
    } finally {
      db.close();
    }

    const applicationReadiness = await verifyApplicationReadiness(options, privateClone.path);
    verifyMigratedClone(privateClone.path);
    const staticVerificationMs = elapsedMs(totalStarted, staticVerificationFinished);
    const recovery = recoveryEvidence(
      options,
      checksum.metadata.dataAsOf,
      checksum.metadata.createdAt,
      applicationReadiness.readinessConfirmedAt,
    );
    return {
      format: 1,
      conclusion: "passed",
      checks: {
        checksum: {
          status: "passed",
          algorithm: "sha256",
          bytes: checksum.bytes,
          digest: checksum.digest,
        },
        metadata: {
          status: "passed",
          format: 2,
          dataAsOf: checksum.metadata.dataAsOf,
          backupCreatedAt: checksum.metadata.createdAt,
        },
        integrity: {
          status: "passed",
          sourceResult: "ok",
          migratedResult: "ok",
        },
        schema: {
          status: "passed",
          sourceUserVersion,
          userVersion: LATEST_SCHEMA_VERSION,
          migration: sourceUserVersion === LATEST_SCHEMA_VERSION
            ? "not_required"
            : "candidate_private_clone",
          requiredTables: RESTORE_REQUIRED_TABLE_COUNT,
          requiredColumns: RESTORE_REQUIRED_COLUMN_COUNT,
        },
        installation: { status: "passed", activeCount: installation.activeCount },
        tokenBackedRead: {
          status: "passed",
          endpoint: "GET /user",
          httpStatus: 200,
          redirects: "blocked",
        },
        applicationReadiness: {
          status: "passed",
          endpoint: applicationReadiness.endpoint,
          httpStatus: applicationReadiness.httpStatus,
          startupInitialization: applicationReadiness.startupInitialization,
          serverArtifact: applicationReadiness.serverArtifact,
          portBinding: applicationReadiness.portBinding,
          releaseSha: applicationReadiness.releaseSha,
          releaseBuildHash: applicationReadiness.releaseBuildHash,
          serverArtifactSha256: applicationReadiness.serverArtifactSha256,
          shutdownVerification: {
            childExitCode: 0,
            databaseIntegrity: "ok",
            writerLock: "available",
          },
        },
      },
      timingsMs: {
        checksum: elapsedMs(totalStarted, checksumFinished),
        integrity: elapsedMs(checksumFinished, integrityFinished),
        schema: elapsedMs(integrityFinished, schemaFinished),
        tokenBackedRead: elapsedMs(schemaFinished, tokenReadFinished),
        applicationReadiness: applicationReadiness.elapsedMs,
        total: Math.round((staticVerificationMs + applicationReadiness.elapsedMs) * 10) / 10,
      },
      ...(recovery === undefined ? {} : { recovery }),
    };
  } finally {
    await removePrivateClone(privateClone.directory);
  }
}

/** Stable, secret-free CLI failure envelope. Never serialize arbitrary errors. */
export function formatRestoreVerificationFailure(error: unknown): RestoreVerificationFailure {
  if (error instanceof RestoreVerificationError) {
    return {
      format: 1,
      conclusion: "failed",
      failedCheck: error.check,
      errorCode: error.code,
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    };
  }
  return {
    format: 1,
    conclusion: "failed",
    failedCheck: "unknown",
    errorCode: "verification_failed",
  };
}
