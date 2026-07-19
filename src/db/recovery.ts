import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  link,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import Database from "better-sqlite3";

export interface BackupDatabaseOptions {
  sourcePath: string;
  destinationPath: string;
  now?: () => Date;
}

export interface BackupDatabaseResult {
  destinationPath: string;
  checksumPath: string;
  metadataPath: string;
  bytes: number;
  sha256: string;
}

export interface RestoreDatabaseOptions {
  backupPath: string;
  targetPath: string;
  overwrite?: boolean;
  /** Test seam at the final install boundary; production callers omit it. */
  beforeInstall?: (temporaryPath: string) => void | Promise<void>;
}

export interface RestoreDatabaseResult {
  targetPath: string;
  bytes: number;
  sha256: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function verifyDatabaseIntegrity(path: string, label: string): void {
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const integrity = db.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") throw new Error(String(integrity));
    } finally {
      db.close();
    }
  } catch (error) {
    throw new Error(`${label} integrity check failed: ${errorMessage(error)}`, { cause: error });
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Create a consistent SQLite backup and its evidence sidecars. The completed
 * destination is independently reopened and integrity-checked before either
 * sidecar is written, so a failed backup can never receive valid-looking proof.
 */
export async function backupDatabase(options: BackupDatabaseOptions): Promise<BackupDatabaseResult> {
  const sourcePath = resolve(options.sourcePath);
  const destinationPath = resolve(options.destinationPath);
  if (sourcePath === destinationPath) {
    throw new Error("Backup destination must differ from the live database.");
  }
  const now = options.now ?? (() => new Date());
  // RPO must be conservative. Capture the data-as-of boundary before opening or
  // inspecting the source, never after integrity verification and hashing have
  // made the completed sidecars look newer than the SQLite snapshot can be.
  const dataAsOf = now().toISOString();

  await mkdir(dirname(destinationPath), { recursive: true });
  const checksumPath = `${destinationPath}.sha256`;
  const metadataPath = `${destinationPath}.json`;
  // Proof from a prior backup must not survive a failed replacement attempt.
  // New sidecars are written only after the replacement has been reopened and
  // independently verified below.
  await Promise.all([
    rm(checksumPath, { force: true }),
    rm(metadataPath, { force: true }),
  ]);
  let sourceDb: Database.Database | undefined;
  try {
    sourceDb = new Database(sourcePath, { readonly: true, fileMustExist: true });
    const integrity = sourceDb.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new Error(`Source integrity check failed: ${String(integrity)}`);
    await sourceDb.backup(destinationPath);
  } finally {
    sourceDb?.close();
  }

  verifyDatabaseIntegrity(destinationPath, "Completed backup");
  const bytes = await readFile(destinationPath);
  const checksum = sha256(bytes);
  await writeFile(checksumPath, `${checksum}  ${basename(destinationPath)}\n`, { mode: 0o600 });
  await writeFile(metadataPath, `${JSON.stringify({
    format: 2,
    dataAsOf,
    createdAt: now().toISOString(),
    source: sourcePath,
    bytes: bytes.byteLength,
    sha256: checksum,
  }, null, 2)}\n`, { mode: 0o600 });

  return {
    destinationPath,
    checksumPath,
    metadataPath,
    bytes: bytes.byteLength,
    sha256: checksum,
  };
}

async function verifiedBackup(backupPath: string): Promise<{ bytes: Buffer; checksum: string }> {
  const expectedLine = (await readFile(`${backupPath}.sha256`, "utf8")).trim();
  const expected = expectedLine.split(/\s+/u)[0];
  if (!/^[a-f0-9]{64}$/u.test(expected)) throw new Error("Invalid SHA-256 sidecar.");
  const bytes = await readFile(backupPath);
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`Checksum mismatch: expected ${expected}, got ${actual}`);
  verifyDatabaseIntegrity(backupPath, "Backup");
  return { bytes, checksum: actual };
}

/** Verify a checksum/integrity-checked backup and atomically install its copy. */
export async function restoreDatabase(options: RestoreDatabaseOptions): Promise<RestoreDatabaseResult> {
  const backupPath = resolve(options.backupPath);
  const targetPath = resolve(options.targetPath);
  if (backupPath === targetPath) throw new Error("Backup and restore target must differ.");

  const verified = await verifiedBackup(backupPath);
  if (await pathExists(targetPath) && options.overwrite !== true) {
    throw new Error("Target exists. Explicit overwrite authorization is required after preserving the current database.");
  }

  await mkdir(dirname(targetPath), { recursive: true });
  const temporaryPath = joinRestoreTemporaryPath(targetPath);
  try {
    await copyFile(backupPath, temporaryPath);
    const copiedBytes = await readFile(temporaryPath);
    if (sha256(copiedBytes) !== verified.checksum) throw new Error("Restored copy checksum mismatch.");
    verifyDatabaseIntegrity(temporaryPath, "Restored copy");
    await options.beforeInstall?.(temporaryPath);
    if (options.overwrite === true) {
      await rename(temporaryPath, targetPath);
    } else {
      try {
        // Both paths are in the target directory. link(2) atomically creates the
        // destination only if it does not exist, closing the precheck-to-rename
        // race without exposing a partially copied database.
        await link(temporaryPath, targetPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error("Target exists. Explicit overwrite authorization is required after preserving the current database.");
        }
        throw error;
      }
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }

  return { targetPath, bytes: verified.bytes.byteLength, sha256: verified.checksum };
}

function joinRestoreTemporaryPath(targetPath: string): string {
  return `${dirname(targetPath)}/.${randomUUID()}.restore`;
}
