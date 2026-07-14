import { backupDatabase } from "../src/db/recovery.js";

function usage(): never {
  throw new Error("Usage: npm run db:backup -- <source.sqlite> <backup.sqlite>");
}

const [, , sourceArg, destinationArg] = process.argv;
if (!sourceArg || !destinationArg) usage();
const result = await backupDatabase({ sourcePath: sourceArg, destinationPath: destinationArg });
console.log(`backup complete: ${result.destinationPath} sha256=${result.sha256}`);
