/**
 * Opt-in live Clockify smoke. Drives the REAL harness (executeAction, the
 * preview → confirm → commit flow, receipts) against a sacrificial workspace via
 * a minimal live adapter that implements the WorkspaceClient port over the
 * Clockify REST API.
 *
 * This is a dev tool, NOT part of the add-on's auth model: the add-on uses an
 * installation add-on token (X-Addon-Token); this smoke uses a personal API key
 * (X-Api-Key) purely to validate harness behavior end-to-end until the SDK
 * wrapper is built and a real adapter is wired.
 *
 * Run:
 *   LIVE_CLOCKIFY=1 LIVE_CLOCKIFY_API_KEY=... LIVE_WORKSPACE_ID=... \
 *     npx tsx scripts/live-smoke.ts
 *
 * Never commit credentials. Creates only AIASSIST_SMOKE_* resources and deletes
 * what it creates, reporting any leftovers.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { executeAction, commitConfirmedOperation } from "../src/harness/actions.js";
import {
  createPendingConfirmation,
  confirmPending,
} from "../src/harness/confirmations.js";
import { defaultAdminPolicy } from "../src/harness/permissions.js";
import type { ActionContext, ConfirmableOperation } from "../src/harness/action.js";
import { createRestWorkspaceClient } from "../src/clockify/rest-workspace.js";

// Load a gitignored .env (KEY=VALUE lines) so creds need not be passed inline.
// Existing process.env always wins. The key is never echoed.
function loadDotEnv(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}
loadDotEnv();

if (process.env.LIVE_CLOCKIFY !== "1") {
  console.error("Refusing to run: set LIVE_CLOCKIFY=1 to opt in.");
  process.exit(2);
}
const API_KEY = process.env.LIVE_CLOCKIFY_API_KEY;
const WORKSPACE_ID = process.env.LIVE_WORKSPACE_ID;
const BASE = (process.env.LIVE_BASE_URL ?? "https://api.clockify.me/api/v1").replace(/\/$/, "");
if (!API_KEY || !WORKSPACE_ID) {
  console.error("Missing LIVE_CLOCKIFY_API_KEY or LIVE_WORKSPACE_ID.");
  process.exit(2);
}

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "X-Api-Key": API_KEY as string, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 160)}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function main(): Promise<void> {
  const me = (await call("GET", "/user")) as { id: string; name: string };
  const ctx: ActionContext = {
    workspaceId: WORKSPACE_ID as string,
    adminUserId: me.id,
    policy: defaultAdminPolicy(),
    // Same shared REST adapter the server uses, here with API-key auth (this
    // dev smoke is not the add-on's production X-Addon-Token path).
    clockify: createRestWorkspaceClient({
      baseUrl: BASE, // already "<...>/api/v1"
      workspaceId: WORKSPACE_ID as string,
      auth: { apiKey: API_KEY as string },
    }),
    now: () => new Date(),
  };
  const tagName = `AIASSIST_SMOKE_20260605_${randomBytes(3).toString("hex")}`;
  console.log(`User: ${me.name} (${me.id}) | workspace ${WORKSPACE_ID}`);
  console.log(`Smoke tag: ${tagName}\n`);

  // 1) READ via harness
  const status = await executeAction({ actionName: "clockify_status", args: {}, context: ctx });
  console.log("1. clockify_status ->", status.kind, status.kind === "receipt" ? status.receipt.ok : "");

  // 2) SAFE WRITE via harness (creates the tag, returns a receipt, no confirmation)
  const created = await executeAction({
    actionName: "clockify_create_work_package",
    args: { tag: { name: tagName } },
    context: ctx,
  });
  if (created.kind !== "receipt" || !created.receipt.ok) {
    throw new Error(`safe write failed: ${JSON.stringify(created)}`);
  }
  const tagRef = created.receipt.changed?.created?.find((c) => c.type === "tag");
  console.log("2. create_work_package -> created tag", tagRef?.id, `(${tagRef?.name})`);
  if (!tagRef) throw new Error("no tag created");

  // 3) RISKY WRITE: preview must NOT delete
  const preview = await executeAction({
    actionName: "clockify_delete_entity",
    args: { entityType: "tag", id: tagRef.id, name: tagRef.name },
    context: ctx,
  });
  if (preview.kind !== "preview") throw new Error(`expected preview, got ${preview.kind}`);
  console.log("3. delete_entity -> PREVIEW only (no deletion yet):", preview.preview.actionLabel);

  // 4) Button confirmation: create pending, confirm with the nonce, then commit
  const pending = createPendingConfirmation({
    sessionId: "smoke",
    workspaceId: ctx.workspaceId,
    adminUserId: ctx.adminUserId,
    risk: preview.operation.risks,
    preview: preview.preview,
    operation: preview.operation,
    sessionSecret: "smoke-secret",
    now: new Date(),
  });
  const confirm = confirmPending({
    record: pending.record,
    sessionId: "smoke",
    workspaceId: ctx.workspaceId,
    adminUserId: ctx.adminUserId,
    nonce: pending.nonce,
    sessionSecret: "smoke-secret",
    now: new Date(),
  });
  if (!confirm.ok) throw new Error(`confirm failed: ${confirm.code}`);
  const commit = await commitConfirmedOperation(ctx, preview.operation as ConfirmableOperation);
  console.log("4. confirm + commit -> deleted:", commit.ok, commit.ok ? commit.changed?.deleted?.map((d) => d.id) : commit);

  // 5) Verify cleanup: no AIASSIST_SMOKE_* tags remain
  const remaining = (await ctx.clockify.listTags()).rows.filter((t) => t.name.startsWith("AIASSIST_SMOKE_"));
  console.log("5. leftover AIASSIST_SMOKE_ tags:", remaining.length);
  if (remaining.length > 0) {
    console.warn("   WARNING leftovers:", remaining.map((t) => `${t.name}(${t.id})`).join(", "));
    process.exit(1);
  }
  console.log("\nLIVE SMOKE PASSED: safe write + read + risky preview→confirm→commit + cleanup all worked against live Clockify.");
}

main().catch((err) => {
  console.error("LIVE SMOKE FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
