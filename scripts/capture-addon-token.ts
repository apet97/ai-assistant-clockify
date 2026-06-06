/**
 * After the add-on is installed on a sacrificial workspace (Clockify has POSTed
 * /lifecycle/installed and the server stored the installation), copy the add-on
 * token + backendUrl from the ENCRYPTED SQLite store into the gitignored .env as
 * LIVE_ADDON_TOKEN / LIVE_BACKEND_URL, so scripts/addon-smoke.ts can drive the
 * production X-Addon-Token path. The token is read from the store and written
 * straight to .env — it is NEVER printed (only its length is reported).
 *
 * Requires the SAME values the server ran with:
 *   DATABASE_PATH=./data/ai-assistant.sqlite
 *   DATA_ENCRYPTION_KEY=...     (the key used at install time, or the decrypt fails)
 *   LIVE_WORKSPACE_ID=...       (the installed workspace)
 *
 * Run:
 *   DATABASE_PATH=./data/ai-assistant.sqlite DATA_ENCRYPTION_KEY=... \
 *   LIVE_WORKSPACE_ID=... npx tsx scripts/capture-addon-token.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createStore } from "../src/db/store.js";

function loadDotEnv(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadDotEnv();

const DATABASE_PATH = process.env.DATABASE_PATH;
const DATA_ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY;
const WORKSPACE_ID = process.env.LIVE_WORKSPACE_ID;
if (!DATABASE_PATH || !DATA_ENCRYPTION_KEY || !WORKSPACE_ID) {
  console.error("Set DATABASE_PATH, DATA_ENCRYPTION_KEY, and LIVE_WORKSPACE_ID first.");
  process.exit(2);
}

const store = createStore(DATABASE_PATH, { encryptionKey: DATA_ENCRYPTION_KEY });
const installation = store.getInstallation(WORKSPACE_ID);
store.close();
if (!installation || installation.status !== "active") {
  console.error(`No active installation for workspace ${WORKSPACE_ID}. Install the add-on first.`);
  process.exit(1);
}

const backendUrl = installation.backendUrl ?? "https://api.clockify.me";

function upsertEnv(content: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(content)) return content.replace(re, line);
  const sep = content === "" || content.endsWith("\n") ? "" : "\n";
  return content + sep + line + "\n";
}

let content = existsSync(".env") ? readFileSync(".env", "utf8") : "";
content = upsertEnv(content, "LIVE_ADDON_TOKEN", installation.addonToken);
content = upsertEnv(content, "LIVE_BACKEND_URL", backendUrl);
writeFileSync(".env", content);

console.log(
  `Captured into .env: LIVE_ADDON_TOKEN (length ${installation.addonToken.length}, value not printed), ` +
    `LIVE_BACKEND_URL=${backendUrl}. Now run: LIVE_CLOCKIFY=1 npx tsx scripts/addon-smoke.ts`,
);
