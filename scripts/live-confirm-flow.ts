/**
 * Opt-in LIVE proof of the risky-write confirmation flow — the core safety
 * mechanism — driven end-to-end over HTTP against the running add-on (tunnel +
 * server + DeepSeek + real Clockify dev host). Nothing here is mocked.
 *
 * It proves, against the REAL server and a sacrificial workspace, that:
 *   1. a risky prompt returns a dry-run PREVIEW and executes NOTHING;
 *   2. typed "yes" never executes (only the confirm button's nonce does);
 *   3. a wrong nonce is rejected;
 *   4. a nonce is bound to its own preview — it cannot confirm another batch
 *      (this is what makes "Confirm all" apply only to its exact previewed set);
 *   5. the correct button nonce executes exactly once and the tag is really gone;
 *   6. the one-use nonce cannot be replayed;
 *   7. policy is re-checked at confirm time (lower the group after preview -> denied).
 * Expiry (5-min TTL) is covered by tests/unit/confirmations.test.ts +
 * tests/integration/risky-preview.test.ts (impractical to wall-clock here).
 *
 * It also cleans up the leftover live test tags through that same proven flow.
 *
 * No token, user token, or session cookie is ever printed — only structural
 * facts and PASS/FAIL lines. The user token lives only in process memory.
 *
 * Bootstrap: it reads the ENCRYPTED installation from the live SQLite store,
 * decodes the install token claims (also surfacing which environment URL claims
 * exist — see Task 2 / audit host), then exchanges the installation token for a
 * user token via the documented `POST {backendUrl}/addon/user/{userId}/token`.
 *
 * Run (values from the gitignored .env.server the server runs with):
 *   npx tsx --env-file=.env.server scripts/live-confirm-flow.ts
 * Requires in env: DATABASE_PATH, DATA_ENCRYPTION_KEY, CLOCKIFY_ADDON_KEY,
 *   BASE_URL (the tunnel). Optional: LIVE_WORKSPACE_ID (else the single active
 *   installation is used).
 */
import { readFileSync } from "node:fs";
import { createStore, type Installation } from "../src/db/store.js";
import { createRestWorkspaceClient } from "../src/clockify/rest-workspace.js";
import { resolveClockifyApiBase } from "../src/clockify/api-base.js";
import { requireCompleteRows } from "../src/clockify/rest/list-pages.js";
import { createChatRequestBody } from "./lib/live-evidence.js";

const DATABASE_PATH = process.env.DATABASE_PATH ?? "./data/ai-assistant.sqlite";
const DATA_ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY;
const BASE_URL = (process.env.BASE_URL ?? "").replace(/\/+$/, "");
if (!DATA_ENCRYPTION_KEY || !BASE_URL) {
  console.error("Set DATA_ENCRYPTION_KEY and BASE_URL (e.g. via --env-file=.env.server).");
  process.exit(2);
}

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail = ""): boolean {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
  return cond;
}

/** Decode a JWT payload WITHOUT verifying (we only inspect non-secret claims). */
function decodeClaims(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

/** Report which environment URL claims are present (Task 2 evidence: no audit URL). */
function reportUrlClaims(label: string, claims: Record<string, unknown>): void {
  const urlKeys = Object.keys(claims).filter((k) => /url$/i.test(k));
  const auditKeys = Object.keys(claims).filter((k) => /audit/i.test(k));
  console.log(`  ${label} URL claims: ${urlKeys.length ? urlKeys.join(", ") : "(none)"}`);
  console.log(`  ${label} audit-related claims: ${auditKeys.length ? auditKeys.join(", ") : "NONE"}`);
}

interface ChatResult {
  kind: string;
  previewId?: string;
  nonce?: string;
  expiresAt?: string;
  preview?: unknown;
  receipt?: { ok?: boolean; action?: string; changed?: { deleted?: Array<{ id?: string }> } };
  message?: string;
}
interface ChatResponse {
  ok: boolean;
  reply?: { kind: string; text: string };
  results?: ChatResult[];
}

async function main(): Promise<void> {
  const store = createStore(DATABASE_PATH, { encryptionKey: DATA_ENCRYPTION_KEY });
  // The dev "Marketplace Workspace" is the installed sacrificial workspace.
  const wsArg = process.env.LIVE_WORKSPACE_ID ?? "69bda6b317a0c5babe34b4ff";
  const installation: Installation | undefined = store.getInstallation(wsArg);
  if (!installation || installation.status !== "active") {
    console.error("No active installation found. Set LIVE_WORKSPACE_ID to the installed workspace.");
    store.close();
    process.exit(1);
  }
  const workspaceId = installation.workspaceId;
  const installToken = installation.addonToken;
  const backendUrl = (installation.backendUrl ?? installation.apiUrl ?? "https://api.clockify.me/api").replace(/\/+$/, "");

  console.log(`\n== Bootstrap ==`);
  console.log(`  workspace: ${workspaceId}`);
  console.log(`  backendUrl: ${backendUrl}`);
  const installClaims = decodeClaims(installToken);
  reportUrlClaims("install-token", installClaims);
  // A real user token (workspaceRole=OWNER/ADMIN) is required for the embedded
  // session. Prefer a token captured from the live component iframe (USER_TOKEN);
  // otherwise try the documented installation-token -> user-token exchange.
  let userToken = (process.env.USER_TOKEN ?? "").trim();
  if (!userToken && process.env.USER_TOKEN_FILE) {
    userToken = readFileSync(process.env.USER_TOKEN_FILE, "utf8").trim();
  }
  if (userToken) {
    console.log("  using a user token captured from the live component iframe");
  } else {
    // Mint a fresh user token via the documented installation-token -> user-token
    // exchange (08-authentication: POST {backendUrl}/addon/user/{userId}/token).
    // NOTE: the install token's `user` claim is the add-on owner-user id, which the
    // exchange does NOT accept — it needs the workspace MEMBER id of an admin/owner.
    // For the dev sacrificial workspace that is the OWNER "John Owner"; override
    // with OWNER_USER_ID for any other workspace.
    const ownerUserId = process.env.OWNER_USER_ID ?? "69bda6b317a0c5babe34b4fe";
    const exchangeUrl = `${backendUrl}/addon/user/${ownerUserId}/token`;
    const exRes = await fetch(exchangeUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Addon-Token": installToken },
    });
    if (!exRes.ok) {
      console.error(`  token exchange failed: ${exRes.status} ${(await exRes.text()).slice(0, 160)}`);
      console.error(`  -> set OWNER_USER_ID to an admin's member id, or pass USER_TOKEN=... from the live iframe`);
      store.close();
      process.exit(1);
    }
    userToken = (await exRes.text()).trim().replace(/^"|"$/g, "");
  }
  const userClaims = decodeClaims(userToken);
  reportUrlClaims("user-token", userClaims);
  const workspaceRole = userClaims.workspaceRole;
  const workspaceRoleText = typeof workspaceRole === "string" ? workspaceRole : "";
  ok("user token has an admin/owner workspaceRole", /OWNER|ADMIN/i.test(workspaceRoleText), workspaceRoleText);

  // Establish the embedded session cookie via the component route.
  const compRes = await fetch(`${BASE_URL}/component/assistant?auth_token=${encodeURIComponent(userToken)}`, {
    redirect: "manual",
  });
  const setCookie = compRes.headers.get("set-cookie") ?? "";
  const cookieMatch = setCookie.match(/ai_assistant_session=[^;]+/);
  if (!ok("component route issues a session cookie", compRes.status === 200 && !!cookieMatch, `status ${compRes.status}`)) {
    store.close();
    process.exit(1);
  }
  const cookie = cookieMatch![0];
  const csrfResponse = await fetch(`${BASE_URL}/api/me`, { headers: { cookie } });
  const csrfToken = ((await csrfResponse.json()) as { csrfToken?: string }).csrfToken;
  if (!csrfToken) throw new Error("Could not obtain the session CSRF token.");
  const appHeaders = { "content-type": "application/json", cookie, "x-csrf-token": csrfToken };

  // Direct REST reads (deterministic existence checks) via the SAME add-on-token adapter.
  const rest = createRestWorkspaceClient({
    baseUrl: resolveClockifyApiBase(installation),
    workspaceId,
    auth: { addonToken: installToken },
  });
  const tagExists = async (name: string): Promise<{ id: string; name: string } | undefined> => {
    const tags = requireCompleteRows(await rest.listTags({}), "verify confirmation-flow tag existence");
    return tags.find((t) => t.name === name);
  };

  async function chat(message: string): Promise<ChatResponse> {
    const r = await fetch(`${BASE_URL}/api/chat/messages`, {
      method: "POST",
      headers: appHeaders,
      body: JSON.stringify(createChatRequestBody(message)),
    });
    return (await r.json()) as ChatResponse;
  }
  async function confirm(previewId: string, nonce: string): Promise<{ status: number; body: { ok?: boolean; code?: string; receipt?: ChatResult["receipt"] } }> {
    const r = await fetch(`${BASE_URL}/api/confirmations/${previewId}/confirm`, {
      method: "POST",
      headers: appHeaders,
      body: JSON.stringify({ nonce }),
    });
    return { status: r.status, body: (await r.json()) as { ok?: boolean; code?: string } };
  }
  async function setPermission(level: "read" | "read_write"): Promise<void> {
    await fetch(`${BASE_URL}/api/permissions/confirm`, {
      method: "POST",
      headers: appHeaders,
      body: JSON.stringify({ groups: { work_structure: level } }),
    });
  }

  /** Drive the model to a destructive delete-tag PREVIEW for a known tag id. The
   *  model occasionally lists first or the transport 502s, so retry firmly. */
  async function previewDelete(tagId: string, tagName: string): Promise<ChatResult | undefined> {
    const prompts = [
      `Delete the tag named "${tagName}" (id ${tagId}). Call clockify_tags_delete with id "${tagId}" now — do not list tags first.`,
      `Yes — delete the tag with id "${tagId}". Call clockify_tags_delete now.`,
      `Proceed: clockify_tags_delete id "${tagId}".`,
      `Run clockify_tags_delete on id "${tagId}".`,
    ];
    for (const p of prompts) {
      const resp = await chat(p);
      const preview = resp.results?.find((r) => r.kind === "preview" && r.previewId && r.nonce);
      if (preview) return preview;
    }
    return undefined;
  }

  // Resolve the leftover test tags up front.
  const TARGET_NAMES = ["DeepSeek-Live-2700", "QA-DeepSeek", "x"];
  const targets: Record<string, { id: string; name: string } | undefined> = {};
  for (const n of TARGET_NAMES) targets[n] = await tagExists(n);
  console.log(`\n== Leftover test tags present ==`);
  for (const n of TARGET_NAMES) console.log(`  ${n}: ${targets[n] ? `id ${targets[n]!.id}` : "(absent)"}`);

  const primary = targets["DeepSeek-Live-2700"];
  const secondary = targets["QA-DeepSeek"];

  console.log(`\n== Proof 1: risky prompt -> preview, NO execution ==`);
  let primaryPreview: ChatResult | undefined;
  if (primary) {
    primaryPreview = await previewDelete(primary.id, primary.name);
    ok("delete-tag prompt returns a dry-run preview (previewId + nonce + expiresAt)",
      !!(primaryPreview?.previewId && primaryPreview?.nonce && primaryPreview?.expiresAt));
    ok("nothing executed yet — tag still exists after preview", !!(await tagExists(primary.name)));
  } else {
    console.log("  (DeepSeek-Live-2700 absent; creating it to run the destructive proof)");
    const created = (await rest.createTag({ name: "DeepSeek-Live-2700" })) as { id: string; name: string };
    targets["DeepSeek-Live-2700"] = created;
    primaryPreview = await previewDelete(created.id, created.name);
    ok("delete-tag prompt returns a dry-run preview (previewId + nonce + expiresAt)",
      !!(primaryPreview?.previewId && primaryPreview?.nonce && primaryPreview?.expiresAt));
    ok("nothing executed yet — tag still exists after preview", !!(await tagExists("DeepSeek-Live-2700")));
  }

  const primaryName = targets["DeepSeek-Live-2700"]!.name;
  if (!primaryPreview?.previewId || !primaryPreview?.nonce) {
    console.log("  FAIL  could not obtain a destructive preview from the model; aborting proof.");
    fail += 1;
    store.close();
    summary();
    process.exit(1);
  }
  const pId = primaryPreview.previewId;
  const pNonce = primaryPreview.nonce;

  console.log(`\n== Proof 2: typed "yes" never executes ==`);
  await chat("yes");
  ok('typed "yes" did NOT delete the tag (only the button can)', !!(await tagExists(primaryName)));

  console.log(`\n== Proof 3: a wrong nonce is rejected ==`);
  const wrong = await confirm(pId, "not-the-real-nonce");
  ok("wrong nonce -> 400 invalid_confirmation", wrong.status === 400 && wrong.body.code === "invalid_confirmation", `status ${wrong.status} code ${wrong.body.code}`);
  ok("tag still present after a rejected confirm", !!(await tagExists(primaryName)));

  console.log(`\n== Proof 4: a nonce is bound to its own preview (Confirm-all batch scoping) ==`);
  let secondPreview: ChatResult | undefined;
  if (secondary) {
    secondPreview = await previewDelete(secondary.id, secondary.name);
  } else {
    const created = (await rest.createTag({ name: "QA-DeepSeek" })) as { id: string; name: string };
    targets["QA-DeepSeek"] = created;
    secondPreview = await previewDelete(created.id, created.name);
  }
  if (secondPreview?.previewId && secondPreview?.nonce) {
    const cross1 = await confirm(pId, secondPreview.nonce);
    ok("preview A cannot be confirmed with preview B's nonce", cross1.status === 400 && cross1.body.code === "invalid_confirmation", `code ${cross1.body.code}`);
    const cross2 = await confirm(secondPreview.previewId, pNonce);
    ok("preview B cannot be confirmed with preview A's nonce", cross2.status === 400 && cross2.body.code === "invalid_confirmation", `code ${cross2.body.code}`);
  } else {
    ok("obtained a second preview for cross-batch test", false);
  }

  console.log(`\n== Proof 5 + 6: correct button confirm executes exactly once, no replay ==`);
  const good = await confirm(pId, pNonce);
  ok("correct nonce -> 200 success receipt", good.status === 200 && good.body.ok === true && good.body.receipt?.ok === true, `status ${good.status}`);
  ok("tag is REALLY gone in Clockify after confirm", !(await tagExists(primaryName)));
  const replay = await confirm(pId, pNonce);
  ok("replaying the same nonce is rejected (one-use)", replay.status >= 400 && replay.body.ok !== true, `status ${replay.status} code ${replay.body.code}`);

  console.log(`\n== Proof 7: policy is re-checked at confirm time ==`);
  if (secondPreview?.previewId && secondPreview?.nonce) {
    await setPermission("read"); // lower work_structure AFTER the preview was created
    const denied = await confirm(secondPreview.previewId, secondPreview.nonce);
    ok("lowering the group after preview -> confirm denied (policy_denied)", denied.status === 400 && denied.body.code === "policy_denied", `code ${denied.body.code}`);
    ok("tag still present after the policy-denied confirm", !!(await tagExists(targets["QA-DeepSeek"]!.name)));
    await setPermission("read_write"); // restore
  } else {
    ok("had a second preview to test policy re-check", false);
  }

  console.log(`\n== Cleanup: remove all leftover test tags through the proven flow ==`);
  for (const n of TARGET_NAMES) {
    const t = await tagExists(n);
    if (!t) {
      console.log(`  ${n}: already gone`);
      continue;
    }
    const prev = await previewDelete(t.id, t.name);
    if (prev?.previewId && prev?.nonce) {
      const c = await confirm(prev.previewId, prev.nonce);
      const gone = !(await tagExists(n));
      ok(`cleaned up tag "${n}" via preview->confirm`, c.status === 200 && gone);
    } else {
      ok(`obtained a delete preview for "${n}"`, false);
    }
  }
  const remaining: string[] = [];
  for (const n of TARGET_NAMES) if (await tagExists(n)) remaining.push(n);
  ok("no leftover test tags remain", remaining.length === 0, remaining.join(", ") || "clean");

  store.close();
  summary();
  process.exit(fail === 0 ? 0 : 1);
}

function summary(): void {
  console.log(`\n== Summary ==  PASS=${pass} FAIL=${fail}`);
  if (fail === 0) {
    console.log("LIVE CONFIRM-FLOW PROOF PASSED: the risky-write button-confirm safety mechanism holds end-to-end.");
  } else {
    console.log("LIVE CONFIRM-FLOW PROOF FAILED — see the FAIL lines above.");
  }
}

main().catch((err) => {
  console.error("LIVE CONFIRM-FLOW errored:", err instanceof Error ? err.message : err);
  process.exit(1);
});
