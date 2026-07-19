import { captureBackupBoundary } from "./lib/legacy-backup-metadata.js";

const [, , outputPath] = process.argv;
if (!outputPath) {
  throw new Error("Usage: npm run db:capture-backup-boundary -- <output.txt>");
}

await captureBackupBoundary({ outputPath });
process.stdout.write("Captured conservative pre-backup RPO boundary.\n");
