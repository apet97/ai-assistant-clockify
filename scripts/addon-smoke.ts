/**
 * Opt-in PRODUCTION-auth smoke (Phase 5). Drives the REAL harness against a
 * sacrificial workspace using the add-on's actual auth path: the installation
 * add-on token via the `X-Addon-Token` header (NOT a personal API key). This is
 * the path Clockify exercises after `/lifecycle/installed`.
 *
 * It proves the production auth path end-to-end: safe write (create tag) →
 * risky preview (delete) → button confirmation → commit (delete) → cleanup.
 *
 * Requires (put in a gitignored .env; NEVER commit or print these):
 *   LIVE_ADDON_TOKEN   installation add-on token captured from /lifecycle/installed
 *   LIVE_WORKSPACE_ID  the workspace the add-on is installed on
 *   LIVE_BACKEND_URL   the backendUrl claim (e.g. https://api.clockify.me)
 *
 * STOP RULE: if no add-on token is present this refuses to run. Do NOT substitute
 * a personal API key for an add-on token — use scripts/live-smoke.ts for the
 * API-key path. The token is never echoed.
 *
 * Run:
 *   LIVE_CLOCKIFY=1 npx tsx scripts/addon-smoke.ts
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { executeAction, commitConfirmedOperation } from "../src/harness/actions.js";
import { createPendingConfirmation, confirmPending } from "../src/harness/confirmations.js";
import { defaultAdminPolicy } from "../src/harness/permissions.js";
import type { ActionContext, ConfirmableOperation } from "../src/harness/action.js";
import { createRestWorkspaceClient } from "../src/clockify/rest-workspace.js";

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
const ADDON_TOKEN = process.env.LIVE_ADDON_TOKEN;
const WORKSPACE_ID = process.env.LIVE_WORKSPACE_ID;
const BACKEND_URL = process.env.LIVE_BACKEND_URL;
if (!ADDON_TOKEN || !WORKSPACE_ID || !BACKEND_URL) {
  console.error(
    "Refusing to run: this smoke needs the production add-on-token path. Set LIVE_ADDON_TOKEN " +
      "(installation add-on token, NOT a personal API key), LIVE_WORKSPACE_ID, and LIVE_BACKEND_URL.",
  );
  process.exit(2);
}

const root = BACKEND_URL.replace(/\/$/, "");
const BASE_URL = root.endsWith("/api/v1") ? root : `${root}/api/v1`;

async function main(): Promise<void> {
  // The installing admin's user id is not required by the steps below
  // (tag create/delete are workspace-scoped); kept configurable for completeness.
  const adminUserId = process.env.LIVE_ADDON_USER_ID ?? "addon";
  const ctx: ActionContext = {
    workspaceId: WORKSPACE_ID as string,
    adminUserId,
    policy: defaultAdminPolicy(),
    clockify: createRestWorkspaceClient({
      baseUrl: BASE_URL,
      workspaceId: WORKSPACE_ID as string,
      auth: { addonToken: ADDON_TOKEN as string },
    }),
    now: () => new Date(),
  };

  const tagName = `AIASSIST_SMOKE_ADDON_${randomBytes(3).toString("hex")}`;
  console.log(`Workspace ${WORKSPACE_ID} | add-on-token auth (X-Addon-Token)\nSmoke tag: ${tagName}\n`);

  // 1) SAFE WRITE via harness
  const created = await executeAction({
    actionName: "clockify_create_work_package",
    args: { tag: { name: tagName } },
    context: ctx,
  });
  if (created.kind !== "receipt" || !created.receipt.ok) {
    throw new Error(`safe write failed: ${JSON.stringify(created)}`);
  }
  const tagRef = created.receipt.changed?.created?.find((c) => c.type === "tag");
  if (!tagRef) throw new Error("no tag created");
  console.log("1. create_work_package -> created tag", tagRef.id, `(${tagRef.name})`);

  // 2) RISKY WRITE: preview must NOT delete
  const preview = await executeAction({
    actionName: "clockify_delete_entity",
    args: { entityType: "tag", id: tagRef.id, name: tagRef.name },
    context: ctx,
  });
  if (preview.kind !== "preview") throw new Error(`expected preview, got ${preview.kind}`);
  console.log("2. delete_entity -> PREVIEW only (no deletion yet):", preview.preview.actionLabel);

  // 3) Button confirmation: create pending, confirm with the nonce, then commit
  const pending = createPendingConfirmation({
    sessionId: "addon-smoke",
    workspaceId: ctx.workspaceId,
    adminUserId: ctx.adminUserId,
    risk: preview.operation.risks,
    preview: preview.preview,
    operation: preview.operation,
    sessionSecret: "addon-smoke-secret",
    now: new Date(),
  });
  const confirm = confirmPending({
    record: pending.record,
    sessionId: "addon-smoke",
    workspaceId: ctx.workspaceId,
    adminUserId: ctx.adminUserId,
    nonce: pending.nonce,
    sessionSecret: "addon-smoke-secret",
    now: new Date(),
  });
  if (!confirm.ok) throw new Error(`confirm failed: ${confirm.code}`);
  const commit = await commitConfirmedOperation(ctx, preview.operation as ConfirmableOperation);
  console.log("3. confirm + commit -> deleted:", commit.ok, commit.ok ? commit.changed?.deleted?.map((d) => d.id) : commit);
  if (!commit.ok) throw new Error("commit failed");

  // 4) Verify cleanup
  const remaining = (await ctx.clockify.listTags()).filter((t) => t.name.startsWith("AIASSIST_SMOKE_"));
  console.log("4. leftover AIASSIST_SMOKE_ tags:", remaining.length);
  if (remaining.length > 0) {
    console.warn("   WARNING leftovers:", remaining.map((t) => `${t.name}(${t.id})`).join(", "));
    process.exit(1);
  }
  console.log(
    "\nADDON SMOKE PASSED: the production X-Addon-Token path drove the tag lifecycle " +
      "(safe create → risky delete preview → confirm → commit → cleanup) against live Clockify. " +
      "Note: this proves the auth path + harness gating via deleteEntity; it does not exercise the " +
      "other Phase 3 risky commits (updateEntity/manageExpense/manageTimeOff/manageSchedule) — those " +
      "are not yet implemented on the REST adapter and would return an 'unsupported' receipt.",
  );
}

main().catch((err) => {
  console.error("ADDON SMOKE FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
