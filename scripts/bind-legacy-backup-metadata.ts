import { bindLegacyBackupMetadata } from "./lib/legacy-backup-metadata.js";

const [, , backupPath, checksumPath, legacyMetadataPath, boundaryPath, outputPath] = process.argv;
if (!backupPath || !checksumPath || !legacyMetadataPath || !boundaryPath || !outputPath) {
  throw new Error(
    "Usage: npm run db:bind-legacy-backup-metadata -- <backup.sqlite> <backup.sha256> <legacy.json> <pre-backup-boundary.txt> <release.json>",
  );
}

await bindLegacyBackupMetadata({
  backupPath,
  checksumPath,
  legacyMetadataPath,
  boundaryPath,
  outputPath,
});
process.stdout.write("Verified legacy backup and wrote a separate format-2 release sidecar.\n");
