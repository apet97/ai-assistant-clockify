import {
  formatRestoreVerificationFailure,
  RestoreVerificationError,
  verifyRestoredDatabase,
} from "../src/db/restore-verification.js";
import { probeRestoredApplicationReadiness } from "./lib/restored-app-readiness.js";

const [, , restoredPath, checksumPath, metadataPath] = process.argv;

async function main(): Promise<void> {
  try {
    if (!restoredPath || !checksumPath || !metadataPath) {
      throw new RestoreVerificationError("metadata", "arguments_required");
    }
    const encryptionKey = process.env.DATA_ENCRYPTION_KEY;
    if (!encryptionKey) {
      throw new RestoreVerificationError("installation", "encryption_key_required");
    }
    const drillStartedAt = process.env.RESTORE_DRILL_STARTED_AT;
    const incidentAt = process.env.RESTORE_INCIDENT_AT;
    if (!drillStartedAt || !incidentAt) {
      throw new RestoreVerificationError("metadata", "recovery_timestamps_required");
    }
    const releaseSha = process.env.RELEASE_SHA;
    const releaseBuildHash = process.env.RELEASE_BUILD_HASH;
    if (!releaseSha || !releaseBuildHash) {
      throw new RestoreVerificationError("application_readiness", "release_identity_required");
    }
    const evidence = await verifyRestoredDatabase({
      restoredPath,
      checksumPath,
      metadataPath,
      encryptionKey,
      previousEncryptionKey: process.env.DATA_ENCRYPTION_KEY_PREVIOUS,
      releaseSha,
      releaseBuildHash,
      drillStartedAt,
      incidentAt,
      applicationReadinessProbe: (privateClonePath) => probeRestoredApplicationReadiness({
        restoredPath: privateClonePath,
        encryptionKey,
        previousEncryptionKey: process.env.DATA_ENCRYPTION_KEY_PREVIOUS,
        releaseSha,
        releaseBuildHash,
      }),
    });
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(formatRestoreVerificationFailure(error), null, 2)}\n`);
    process.exitCode = 1;
  }
}

await main();
