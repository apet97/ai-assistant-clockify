import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";

function usage(): never {
  throw new Error("Usage: npm run db:backup -- <source.sqlite> <backup.sqlite>");
}

const [, , sourceArg, destinationArg] = process.argv;
if (!sourceArg || !destinationArg) usage();
const source = resolve(sourceArg);
const destination = resolve(destinationArg);
if (source === destination) throw new Error("Backup destination must differ from the live database.");

await mkdir(dirname(destination), { recursive: true });
const sourceDb = new Database(source, { readonly: true, fileMustExist: true });
try {
  const integrity = sourceDb.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") throw new Error(`Source integrity check failed: ${String(integrity)}`);
  await sourceDb.backup(destination);
} finally {
  sourceDb.close();
}

const bytes = await readFile(destination);
const checksum = createHash("sha256").update(bytes).digest("hex");
await writeFile(`${destination}.sha256`, `${checksum}  ${destination.split("/").at(-1) ?? "backup.sqlite"}\n`, {
  mode: 0o600,
});
await writeFile(`${destination}.json`, `${JSON.stringify({
  format: 1,
  createdAt: new Date().toISOString(),
  source,
  bytes: bytes.byteLength,
  sha256: checksum,
}, null, 2)}\n`, { mode: 0o600 });

console.log(`backup complete: ${destination} sha256=${checksum}`);
