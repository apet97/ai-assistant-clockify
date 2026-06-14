/**
 * Standalone per-workspace data ERASURE (GDPR / right-to-be-forgotten on request).
 * Deletes every workspace-scoped row and tombstones the installation token —
 * identical to what POST /lifecycle/deleted does on uninstall, but invokable by
 * an operator against the live SQLite DB without waiting for an uninstall hook.
 *
 * Double-gated and offline (no network):
 *   ERASE_CONFIRM=1 ERASE_WORKSPACE_ID=<wsId> DATABASE_PATH=/data/ai-assistant.sqlite \
 *     DATA_ENCRYPTION_KEY=<key> npx tsx scripts/erase-workspace.ts
 *
 * DATABASE_PATH + DATA_ENCRYPTION_KEY may also come from a local (gitignored) .env.
 */
import { existsSync, readFileSync } from "node:fs";
import { createStore } from "../src/db/store.js";

function loadDotEnv(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}
loadDotEnv();

const workspaceId = process.env.ERASE_WORKSPACE_ID;
const databasePath = process.env.DATABASE_PATH;
const encryptionKey = process.env.DATA_ENCRYPTION_KEY;

if (process.env.ERASE_CONFIRM !== "1") {
  console.error("Refusing to run: set ERASE_CONFIRM=1 to opt in (this permanently deletes data).");
  process.exit(2);
}
if (!workspaceId || !databasePath || !encryptionKey) {
  console.error("Missing ERASE_WORKSPACE_ID, DATABASE_PATH, or DATA_ENCRYPTION_KEY.");
  process.exit(2);
}

const store = createStore(databasePath, { encryptionKey });
try {
  const counts = store.eraseWorkspace(workspaceId);
  console.log(`Erased workspace ${workspaceId}:`, JSON.stringify(counts));
  console.log("Installation tombstoned (status=deleted, token wiped).");
} finally {
  store.close();
}
