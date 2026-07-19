import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupDatabase, restoreDatabase } from "../../src/db/recovery.js";
import { createStore } from "../../src/db/store.js";

const ENCRYPTION_KEY = "restore-readiness-fixture-encryption-key";

export async function restoredDatabaseTestFixture(): Promise<{
  restoredPath: string;
  encryptionKey: string;
  cleanup(): void;
}> {
  const directory = mkdtempSync(join(tmpdir(), "ai-assistant-restored-app-"));
  const sourcePath = join(directory, "source.sqlite");
  const backupPath = join(directory, "backup.sqlite");
  const restoredPath = join(directory, "isolated", "restored.sqlite");
  const store = createStore(sourcePath, { encryptionKey: ENCRYPTION_KEY });
  store.saveInstallation({
    workspaceId: "workspace-active",
    addonId: "addon-active",
    addonUserId: "user-active",
    addonToken: "active-token",
    apiUrl: "https://api.clockify.me/api",
  });
  store.close();
  await backupDatabase({ sourcePath, destinationPath: backupPath });
  await restoreDatabase({ backupPath, targetPath: restoredPath });
  return {
    restoredPath,
    encryptionKey: ENCRYPTION_KEY,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
