import { createHash, randomUUID } from "node:crypto";
import { copyFile, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";

function usage(): never {
  throw new Error("Usage: RESTORE_DATABASE=YES npm run db:restore -- <backup.sqlite> <target.sqlite>");
}

const [, , backupArg, targetArg] = process.argv;
if (!backupArg || !targetArg) usage();
if (process.env.RESTORE_DATABASE !== "YES") {
  throw new Error("Restore is disabled. Set RESTORE_DATABASE=YES after stopping the application.");
}
const backup = resolve(backupArg);
const target = resolve(targetArg);
if (backup === target) throw new Error("Backup and restore target must differ.");

const expectedLine = (await readFile(`${backup}.sha256`, "utf8")).trim();
const expected = expectedLine.split(/\s+/u)[0];
if (!/^[a-f0-9]{64}$/u.test(expected)) throw new Error("Invalid SHA-256 sidecar.");
const actual = createHash("sha256").update(await readFile(backup)).digest("hex");
if (actual !== expected) throw new Error(`Checksum mismatch: expected ${expected}, got ${actual}`);

const backupDb = new Database(backup, { readonly: true, fileMustExist: true });
try {
  const integrity = backupDb.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") throw new Error(`Backup integrity check failed: ${String(integrity)}`);
} finally {
  backupDb.close();
}

try {
  await stat(target);
  if (process.env.RESTORE_OVERWRITE !== "YES") {
    throw new Error("Target exists. Set RESTORE_OVERWRITE=YES only after preserving the current database.");
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const temporary = `${dirname(target)}/.${randomUUID()}.restore`;
try {
  await copyFile(backup, temporary);
  await rename(temporary, target);
} finally {
  await rm(temporary, { force: true });
}
console.log(`restore complete: ${target} sha256=${actual}`);
