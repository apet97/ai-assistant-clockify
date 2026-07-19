/**
 * Opt-in LIVE proof that the two known DeepSeek-planner quirks are smoothed out,
 * driven end-to-end over HTTP against the running add-on (tunnel + server +
 * DeepSeek + real Clockify dev host). Nothing here is mocked.
 *
 * Quirk 1 — "create a project AND start a timer on it" in ONE turn used to start
 *   a BARE timer (empty projectId) because the planner cannot reference the
 *   not-yet-created project id same-turn. With `clockify_create_work_package`'s
 *   `startTimer` the project id is resolved server-side, so the running timer is
 *   attached to the new project.
 * Quirk 2 — `clockify_tags_delete` used to dead-end at `invalid_args` when the
 *   planner dropped the id. The handler now resolves an exact name to an id, so a
 *   plain "delete the tag named X" returns a dry-run preview.
 *
 * It uses unique AIASSIST_SMOKE_* names (Clockify reserves a project name even
 * after delete) and self-cleans through the REST adapter / the proven confirm
 * flow. No token, user token, or session cookie is ever printed.
 *
 * Run (values from the gitignored .env.server the server runs with):
 *   npx tsx --env-file=.env.server scripts/live-planner-quirks.ts
 * Requires in env: DATABASE_PATH, DATA_ENCRYPTION_KEY, BASE_URL (the tunnel).
 * Optional: LIVE_WORKSPACE_ID, OWNER_USER_ID, USER_TOKEN / USER_TOKEN_FILE.
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

interface EntityRefLite {
  type: string;
  id: string;
  name?: string;
}
interface ChatResult {
  kind: string;
  previewId?: string;
  nonce?: string;
  receipt?: {
    ok?: boolean;
    action?: string;
    code?: string;
    message?: string;
    changed?: { created?: EntityRefLite[]; reused?: EntityRefLite[] };
    warnings?: Array<{ message?: string }>;
  };
  message?: string;
}
interface ChatResponse {
  ok: boolean;
  reply?: { kind: string; text: string };
  results?: ChatResult[];
}

async function main(): Promise<void> {
  const store = createStore(DATABASE_PATH, { encryptionKey: DATA_ENCRYPTION_KEY });
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
  const ownerUserId = process.env.OWNER_USER_ID ?? "69bda6b317a0c5babe34b4fe";

  console.log(`\n== Bootstrap ==`);
  console.log(`  workspace: ${workspaceId}`);

  let userToken = (process.env.USER_TOKEN ?? "").trim();
  if (!userToken && process.env.USER_TOKEN_FILE) {
    userToken = readFileSync(process.env.USER_TOKEN_FILE, "utf8").trim();
  }
  if (!userToken) {
    const exRes = await fetch(`${backendUrl}/addon/user/${ownerUserId}/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Addon-Token": installToken },
    });
    if (!exRes.ok) {
      console.error(`  token exchange failed: ${exRes.status} ${(await exRes.text()).slice(0, 160)}`);
      store.close();
      process.exit(1);
    }
    userToken = (await exRes.text()).trim().replace(/^"|"$/g, "");
  }

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

  const rest = createRestWorkspaceClient({
    baseUrl: resolveClockifyApiBase(installation),
    workspaceId,
    auth: { addonToken: installToken },
  });

  async function chat(message: string): Promise<ChatResponse> {
    const r = await fetch(`${BASE_URL}/api/chat/messages`, {
      method: "POST",
      headers: appHeaders,
      body: JSON.stringify(createChatRequestBody(message)),
    });
    return (await r.json()) as ChatResponse;
  }
  async function confirm(previewId: string, nonce: string): Promise<{ status: number; ok: boolean }> {
    const r = await fetch(`${BASE_URL}/api/confirmations/${previewId}/confirm`, {
      method: "POST",
      headers: appHeaders,
      body: JSON.stringify({ nonce }),
    });
    const body = (await r.json()) as { ok?: boolean };
    return { status: r.status, ok: body.ok === true };
  }
  const planOf = (resp: ChatResponse): string =>
    (resp.results ?? []).map((r) => r.receipt?.action ?? r.kind).join(", ") || (resp.reply?.kind ?? "?");

  const suffix = Date.now().toString(36).slice(-5);

  // ── Quirk 1: one-turn "create a project AND start a timer on it" ───────────
  console.log(`\n== Quirk 1: create a project AND start a timer on it (one turn) ==`);
  const projectName = `AIASSIST_SMOKE_P_${suffix}`;
  let resp1: ChatResponse = { ok: false };
  for (let i = 0; i < 2; i++) {
    resp1 = await chat(`Create a project called "${projectName}" and start a timer on it.`);
    if ((resp1.results ?? []).length > 0) break;
  }
  console.log(`  planner produced: ${planOf(resp1)}`);
  if (resp1.reply?.text) console.log(`  reply: ${resp1.reply.text.slice(0, 160)}`);

  const cwp = (resp1.results ?? []).find((r) => r.receipt?.action === "clockify_create_work_package");
  if (cwp?.receipt && cwp.receipt.ok === false) {
    console.log(`  receipt error: ${cwp.receipt.code} — ${cwp.receipt.message}`);
  }
  const created = cwp?.receipt?.changed?.created ?? [];
  console.log(`  created refs: ${created.map((c) => `${c.type}:${c.name ?? c.id}`).join(", ") || "(none)"}`);
  for (const w of cwp?.receipt?.warnings ?? []) console.log(`  warning: ${w.message}`);
  const projRef = created.find((c) => c.type === "project");
  const timerRef = created.find((c) => c.type === "time_entry");

  ok("the project was created", !!projRef, projRef?.name);
  ok("a timer was started in the SAME one-turn step", !!timerRef);

  const proj = projRef ? { id: projRef.id, name: projRef.name ?? projectName } : undefined;
  const running = await rest.getRunningTimeEntry(ownerUserId);
  ok(
    "the running timer is attached to the new project (NOT a bare timer)",
    !!running && !!proj && running.projectId === proj.id,
    `timer.projectId=${running?.projectId ?? "(none)"}`,
  );

  // Cleanup quirk 1: stop the timer, delete the entry, delete the project.
  if (running) {
    await rest.stopTimeEntry({ userId: ownerUserId, end: new Date().toISOString() });
    try {
      if (rest.deleteEntity) await rest.deleteEntity({ entityType: "time_entry", id: running.id });
    } catch {
      /* a stopped entry may already be cleaned by Clockify; ignore */
    }
  }
  if (proj) {
    await rest.deleteProject(proj.id); // archive-then-delete
    console.log(`  cleaned up project + timer`);
  }

  // ── Quirk 2: "delete the tag named X" (no id) returns a preview ────────────
  console.log(`\n== Quirk 2: delete a tag by name (planner may omit the id) ==`);
  const tagName = `AIASSIST_SMOKE_T_${suffix}`;
  const createdTag = (await rest.createTag({ name: tagName })) as { id: string; name: string };
  const tagExists = async (): Promise<boolean> => {
    const tags = requireCompleteRows(await rest.listTags({}), "verify planner-quirks tag existence");
    return tags.some((t) => t.name === tagName);
  };
  ok("seeded a tag to delete", await tagExists(), createdTag.id);

  let preview: ChatResult | undefined;
  for (let i = 0; i < 2 && !preview; i++) {
    const resp2 = await chat(`Delete the tag named "${tagName}".`);
    console.log(`  planner produced: ${planOf(resp2)}`);
    preview = (resp2.results ?? []).find((r) => r.kind === "preview" && r.previewId && r.nonce);
  }
  ok("delete-by-name returns a dry-run preview (no invalid_args dead-end)", !!preview);

  if (preview?.previewId && preview?.nonce) {
    const c = await confirm(preview.previewId, preview.nonce);
    ok("the button-confirm executes the delete", c.status === 200 && c.ok);
  }
  ok("the tag is really gone in Clockify", !(await tagExists()));

  // Safety-net cleanup for the tag if anything above bailed early.
  if (await tagExists()) await rest.deleteTag(createdTag.id);

  // ── Final sweep: no AIASSIST_SMOKE_* leftovers in the installed workspace ───
  console.log(`\n== Sweep: remove any AIASSIST_SMOKE_* leftovers ==`);
  const leftoverTags = requireCompleteRows(
    await rest.listTags({}),
    "find planner-quirks tags to clean up",
  ).filter((t) => t.name.startsWith("AIASSIST_SMOKE_"));
  for (const t of leftoverTags) await rest.deleteTag(t.id);
  const allProjects = [
    ...requireCompleteRows(await rest.listProjects({}), "find active planner-quirks projects to clean up"),
    ...requireCompleteRows(await rest.listProjects({ archived: true }), "find archived planner-quirks projects to clean up"),
  ];
  const leftoverProjects = allProjects.filter((p) => p.name.startsWith("AIASSIST_SMOKE_"));
  for (const p of leftoverProjects) await rest.deleteProject(p.id);
  const remainingTags = requireCompleteRows(
    await rest.listTags({}),
    "verify planner-quirks tag cleanup",
  ).filter((t) => t.name.startsWith("AIASSIST_SMOKE_")).length;
  const remainingProjects = [
    ...requireCompleteRows(await rest.listProjects({}), "verify active planner-quirks project cleanup"),
    ...requireCompleteRows(await rest.listProjects({ archived: true }), "verify archived planner-quirks project cleanup"),
  ].filter((p) => p.name.startsWith("AIASSIST_SMOKE_")).length;
  ok("no AIASSIST_SMOKE_* tags remain", remainingTags === 0, `${leftoverTags.length} tag(s) swept`);
  console.log(
    `  note: ${leftoverProjects.length} project(s) swept, ${remainingProjects} still listed ` +
      `(Clockify retains a project that held entries — archived, name reserved; harmless)`,
  );

  store.close();
  console.log(`\n== Summary ==  PASS=${pass} FAIL=${fail}`);
  console.log(fail === 0 ? "LIVE PLANNER-QUIRKS PROOF PASSED." : "LIVE PLANNER-QUIRKS PROOF FAILED — see FAIL lines.");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("LIVE PLANNER-QUIRKS errored:", err instanceof Error ? err.message : err);
  process.exit(1);
});
