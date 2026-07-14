import { restoreDatabase } from "../src/db/recovery.js";

function usage(): never {
  throw new Error("Usage: RESTORE_DATABASE=YES npm run db:restore -- <backup.sqlite> <target.sqlite>");
}

const [, , backupArg, targetArg] = process.argv;
if (!backupArg || !targetArg) usage();
if (process.env.RESTORE_DATABASE !== "YES") {
  throw new Error("Restore is disabled. Set RESTORE_DATABASE=YES after stopping the application.");
}
const result = await restoreDatabase({
  backupPath: backupArg,
  targetPath: targetArg,
  overwrite: process.env.RESTORE_OVERWRITE === "YES",
});
console.log(`restore complete: ${result.targetPath} sha256=${result.sha256}`);
