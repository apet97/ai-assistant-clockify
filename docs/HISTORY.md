# HISTORY — handoff-note & phase-journal archive

Moved out of CLAUDE.md on 2026-06-10 to keep the per-session context small.
Newest first. The durable rules/facts distilled from these live in CLAUDE.md.

## Handoff note — 2026-06-14 (external-review remediation + marketplace hardening + New chat + review follow-ups)

Four arcs landed 2026-06-14, all TDD (failing test first), one focused commit each,
1095→1224 tests, madge 0. Durable facts live in CLAUDE.md → "Current state".

**External-review remediation (`7f3be68`…`36c940f`, 1205→1216):** 7 fixes from an
external 7.5/10 review. (A) `COMMIT_TIMEOUT_MS` moved out of a raw `process.env`
read into validated config, bounded `< 290000` (strictly below the idempotency
`CLAIM_TTL_MS` 300000) so an operator can't set a timeout that lets a slow commit's
claim be swept. (B) Request hardening: `express.json({limit:"32kb"})`, chat
`message.max(4000)`/nonce `.max(256)` at parse, terminal error middleware honors a
body-parser 4xx (413/400) not a masked 500. (C) `DATA_ENCRYPTION_KEY` config
`.min(1)`→`.min(32)` (encryption.ts derivation UNTOUCHED — changing it orphans
already-deployed ciphertext). (D) `madge` pinned + `npm run cycles`. (E) README
Node 20→22 + `.nvmrc`. (F) GET bounded retry on transient 429/5xx. Deliberate: NO
`.trim()` on the message schema (whitespace → friendly new-6 handler). An
independent adversarial diff review found 0 issues.

**Marketplace-submission hardening (1216→1220):** six items. **Chat/audit retention**
(REVERSES the prior "never pruned" stance, deliberately): `chat_messages` +
`audit_events` age out via the hourly `pruneExpired` sweep on `RETENTION_DAYS`
(default 90, floor 30 so the 30-day metrics view never truncates; two `created_at`
prune-indexes pinned by `explainPrunePlan`). **Workspace erasure**:
`store.eraseWorkspace` deletes every workspace-scoped row in one atomic txn
(FK-children before `chat_sessions`) + tombstones the install (status='deleted',
token → `encryptSecret("")`); `POST /lifecycle/deleted` now ERASES (was mark-only),
`scripts/erase-workspace.ts` (offline, double-gated) does it on request;
`idempotency_keys` (global, PII-free) skipped. **`PRIVACY.md`** (public
data/retention/erasure doc). **CI**: `npm audit --omit=dev --audit-level=high` +
`.github/dependabot.yml`; a **manual** `live-smoke.yml` (`workflow_dispatch` only —
never push/PR) drives the real read→safe-write→preview→confirm→commit→cleanup flow
vs a sacrificial WS via `LIVE_*` repo secrets + an `if:always()` sweep (proven green
live against the owner's account). `main` got a required `verify` CI status check
(no forced PR; `enforce_admins=false`).

**New chat + review follow-ups (1220→1224):** `POST /api/chat/new` mints a fresh
session (re-cookie) → empty transcript; prior messages are KEPT (retention + audit
log), so the old session's cookie still replays (`chat-new.test.ts`). UI gained a
header "New chat" button. A past-conversations browser was intentionally NOT built
(demand-driven; ~$0 infra since the data's already retained, but added UI surface).
Then two review nits: `scripts/user-sim.ts` untracked + gitignored (a blanket
`git add -A` had re-committed the local-only sim tool); and the GET-retry loop
extracted into one `fetchWithRetry` shared by `call()` AND `getBinary()`
(invoice/report exports now retry too — GET behavior uniform).

## Handoff note — 2026-06-13 (the goated-audit arc: 43 findings fixed, 1 wont_fix)

A fresh-eyes "find what every previous pass missed" audit + full backlog
implementation. Three runs:

1. **Audit + first fixes.** A multi-agent Workflow (8 parallel subsystem readers →
   a 15-dimension loop-until-dry hunt over 4 rounds → 3-skeptic majority
   verification) surfaced **82 findings, 52 confirmed**. The run correctly REFUSED
   all live Clockify probes (the `.env` `LIVE_WORKSPACE_ID` didn't equal the
   sanctioned sacrificial workspace) — findings came from the OpenAPI spec +
   pinning tests. The automated fix phase was cut off by an account session limit,
   so the highest-value confirmed fixes were landed directly: **10 TDD commits** —
   a CRITICAL (async route rejections hung the request AND crashed the server on a
   mid-turn DB error → `asyncHandler` + a headers-sent-aware terminal error
   middleware + a process-level net) and two HIGHs (`projects_from_template` sent
   `templateId` not the spec's required `templateProjectId`+`name`, so every
   from-template create 400'd; `/component/assistant` minted a NEW session every
   load so session-restore was dead in prod — now reuses the cookie-bound session).
   Plus: per-tool-call `thoughtSignature` survives the confirm-resume round-trip
   (Gemini 3.x no longer 400s); a total-failure undo reports failure not a false
   "Undone"; holidays dates resolve server-side; the time-off preview shows the
   deducted day count; `tasks_rate_update` previews the REAL task name
   (`resolveEntityRef` gained `verifyId`); the NUL-byte sentinel removed from
   `api.ts` (grep treated the safety-critical file as binary); catalog corrected to
   137 actions.

2. **Resume sweep — 7 more fixes.** confirmPending/rotatePendingNonce check
   ownership BEFORE status (no cross-tenant lifecycle leak) and fail CLOSED on a
   NaN `expiresAt`; schedule single-project totals use `GET /{projectId}` (the POST
   body's `projectId` was silently dropped → all projects); the typed-consent guard
   catches approval idioms ("ship it"/"make it so") without swallowing new-entity
   phrases; an idempotent replay no longer mints a second undo handle;
   `/component/assistant` requires an ACTIVE installation before minting a session;
   undo failures surface the route's real reason.

3. **Backlog implementation — 26 fixed, 1 wont_fix, 0 blocked** (a dedicated
   Workflow). The deferred headline `concurrency-races-01` (idempotency
   check-then-act → duplicate invoice) was first DESIGNED, then **rejected 0/3 by
   adversarial skeptics**, revised, **approved 2/3**, and implemented as an
   **atomic-claim idempotency ledger**: `store.claimIdempotency` does a stale-sweep
   + `INSERT … ON CONFLICT(key) DO NOTHING` in one synchronous better-sqlite3
   transaction, claimed BEFORE the commit await so two concurrent confirms can't
   both create; `rest/core.ts` gained a 120s `COMMIT_TIMEOUT_MS` and the ledger a
   `CLAIM_TTL_MS` set STRICTLY above it, so a crashed-mid-commit claim frees within
   5 min and a legitimate commit can never run long enough to hit the TTL;
   release-on-failure/throw + lookup-skips-NULL complete it; the safety boundary is
   untouched and madge stays 0. Also landed: cross-tab nonce re-arm, per-card
   pending restore (no merged "Confirm all"), focus-return + honest cancel/undo
   copy, CSP + clickjacking backstop on the embedded HTML (frame-ancestors keeps
   the Clockify/CAKE origins), confirm-resume rate-limit, JSON-mode token telemetry,
   gemini-cli timeout forwarding, transcript-unique tool-call ids, index-seek prune,
   memoized `catalogForModel`, "this `<weekday>`" date resolution, and named
   transport-fetch errors. The ONE `wont_fix` is `authz-surface-01` (admin role
   gated only at session creation, not re-verified per request) — honest, a
   session-TTL/posture decision since chat requests carry only the signed cookie,
   no fresh Clockify token to re-verify a role against.

**Net:** 43 confirmed findings fixed across the arc, 1 wont_fix, 0 unaddressed.
Tests 1095 → **1184** (+89). Planner held **100%** (108/108 repeat=2, DeepSeek +
both Gemini tiers); agentic **14/14**, 0 safety violations; madge **0**. All
pushed to `main`. Full per-finding tables (incl. the idempotency design verdict)
in `~/Downloads/ai-assistant-goated-audit-NOTES.md`. Open product call:
`authz-surface-01` session-TTL posture.

## Handoff note — 2026-06-13 (audit/dogfood/identity/harvest/elevate/Gemini arcs + Railway)

Six arcs landed between 2026-06-11 and 2026-06-13 (details distilled into
CLAUDE.md → "Current state"; this is the journal pointer):

1. **Full-angle audit fix run (06-11):** 34 fixes from the `e538561` audit —
   security (lifecycle workspaceId from the token claim), safety (resume
   tool-result cap, nonce never persisted), API drift, truthfulness, dead code,
   test gaps. 0 deferred. Then an adversarial codebase review whose actionable
   findings became three duplication consolidations (`money.ts`, `durations.ts`,
   pagination limits); the api.ts/store.ts decompositions were DEFERRED.
2. **Live dogfood + fix arc (06-11/12):** Sonnet agents drove
   `scripts/repro-chat.ts` + the user's screenshots → ~22 fixes (clarify-once,
   grounding, major units, role-grant contract, rate model fully covered,
   fake-fidelity). Reusable: `.claude/workflows/dogfood-and-fix.js`.
3. **Identity-resolution sweep (06-12):** every user/group/entity/tag/policy/
   template slot resolves names at preview via ONE core per shape
   (`resolveUserRef`/`resolveUserRefs`/`resolveGroupRefs`/`resolveUserFilter`/
   `resolveProjectTaskRefs`/`resolveTagRefs`); `users_deactivate` self-guard
   holds on the RESOLVED id; time-off policies gained group/user scoping (new
   capability).
4. **Harvest arc (06-12):** relative dates everywhere (incl. the approvals
   `new Date("June 1")` → year-2001 bug), scalar-coercion absorption
   (`arg-shapes.ts`), per-session rate limit, retention pruning, model retry +
   timeout, SIGTERM, honest UI errors. Planner eval 138/138.
5. **Elevate arc (06-13):** session restore (rotated one-use nonce), status
   streaming, per-turn usage telemetry, undo extension, eval lock-in
   (54 cases, 162/162), GitHub Actions CI.
6. **Gemini-readiness arc (06-13):** model client speaks Gemini 3.x
   (`thought_signature` echo on continuations, `LLM_REASONING_EFFORT`; inert for
   DeepSeek, pinned) + four harness improvements (workday anchoring for "N days
   next week" time-off, report-default teaching, call-don't-ask prompt rule,
   optional log_work description) → planner 108/108 on BOTH
   gemini-3.1-flash-lite(low) and gemini-3.5-flash(low), 162/162 held on
   DeepSeek; agentic 7/7 ×3, 0 safety violations. Cost analysis: 75.98M DeepSeek
   tokens over 4 days = $1.40 (~98% cache-hit); pricing recommendation
   $9.99/workspace/mo flat + fair-use turn cap.

**DEPLOYED on Railway (06-12)** — `ai-assistant-production-c2e6.up.railway.app`,
vendored SDK tarball, SQLite on a `/data` volume; quick tunnel retired to
local-dev-only. Gate: `npm run verify` = **1095 tests**, madge 0, CI green.
Remaining human-gated: prod security review + token rotation, prod AUDIT-host
clearance, prod backend decision (DeepSeek vs Gemini — swap is env-only).

## Handoff note — 2026-06-10 PM (loop-failure resolution: ALL 322 items closed)

The full triage+fix pass over `~/Downloads/ai-assistant-loop-failures.md` is
DONE: the checklist (`~/Downloads/ai-assistant-loop-checklist.md`) now reads
**322/322 `[x]`** — every pre-fix item re-verified against a green pin (test
name + fix commit noted inline), every post-fix defect fixed strict-TDD.
`npm run verify` = **820 tests**, madge 0, all pushed; the dev server was
restarted via `scripts/dev-tunnel.sh sync` (URL UNCHANGED — the embedded
install keeps working). Nine focused commits:

- **`3cb3bdc` (item 305)** — `resolveEntityRef` gained `includeArchived`:
  delete/archive/unarchive verbs resolve ARCHIVED entities by name (the wire
  defaults to active-only, so both states are fetched explicitly; archived
  candidates are labeled in clarifies). Wired: projects delete/archive/
  unarchive, clients, tags, tasks_delete's project ref.
- **`0639087` (items 091/096, found in triage)** — the LAST name-as-id holes:
  the GENERIC `clockify_update_entity`/`delete_entity` now resolve
  project/client/tag identity at preview, and `projects_update` resolves a
  client NAME in the `clientId` slot (empty-string unassign passes through).
- **`5a68577` (items 304/316)** — recaps stop confabulating: new read action
  `assistant_recent_outcomes` (buildMetrics over the caller's audited
  outcomes, 24h default window; `ActionContext.recentOutcomes` capability
  injected by the route) + prompt rule: "what did you do / what failed" MUST
  call it, never answer from windowed chat memory.
- **`5f45409` (item 321)** — forward ranges: `next_week`/`next_month`/
  `next_quarter`/`next_year` resolve to full forward windows at every
  `resolveInstant` consumer (scheduling/entries/reports/period_report).
- **`0a22ac6` (items 318 + 011 + the 210/276 "missing buttons")** — the model
  parroted the stored truthful-preview boilerplate as its own answer with ZERO
  tool calls; `sanitizeStoredReplyForModel` rewrites it to a neutral note in
  the MODEL-VISIBLE history only (stored history byte-identical) + prompt rule
  "text alone performs nothing". The buttonless-"preview" sightings were this
  class (no real preview row existed — DB-confirmed), not a UI bug.
- **`93c3221` (items 180/186/248)** — the add-on token class restriction
  (webhooks ALL, custom-field CREATE) surfaces at PREVIEW as an honest
  platform-restriction clarify (new `WorkspaceClient.authClass` set by the
  REST adapter; API-key/dev flows untouched); descriptions name the
  restriction so "why can't you…" answers truthfully.
- **`f88ac33` (item 069)** — ProjectDtoV1.billable (spec-verified) was DROPPED
  by the REST map; project reads now carry it.
- **`222a040` (item 058)** — "add me to project X": memberships_update gained
  `addUserIds` with "me" → `ctx.adminUserId`, MERGED into the current set via
  new port method `getProjectMemberships` (the PATCH replaces; a naive add
  would drop members); project resolves by name.
- **`78f8a57` (item 157)** — a bare typed "yes/confirm/do it" while a preview
  is pending NEVER reaches the planner (live it planned a NEW operation):
  deterministic reply points at the Confirm button; store gained
  `countPendingConfirmations`. Scoped — "yes" with nothing pending still goes
  to the model.
- **`7952622` (item 176)** + **`4d9f2e0` (items 139/287)** — expense categories
  archive/unarchive by name (the status PATCH the delete already used,
  spec-verified); items_add description says an amount alone is enough; prompt
  rule for "call the API directly with your token" (explain tool-only, never
  holds tokens, offer the closest tool action).

Triage attribution (no code change needed, marked inline in the checklist):
the name-as-id, date, context-overflow, policy-denial/verbatim and wire-shape
clusters were re-verified against the five prior fix commits' pins; 065/244
are model-judgment items made safe by the preview gate; 187 was test data
("1111" never existed); 053/276's "executed without Confirm" claims were
DISPROVEN against the backend DB — the safety core held throughout.

**LIVE REGRESSION RE-RUN: DONE (2026-06-10, embedded chat, workspace
69bda6b3…) — every fixed flow PASSED end-to-end,** verified against the UI
cards AND the audit DB: 069 (billable read = "Yes"), 058 ("add me" inferred
the caller, merge previewed "Add 0 member(s) (1 existing kept)"), 305
(ARCHIVED project deleted by name), 157 (typed "yes" at a live preview got
the deterministic button-pointer reply, model never called, original Confirm
then executed once), 304 (recap called assistant_recent_outcomes and produced
a data-driven table), 176 (an ARCHIVE preview, committed), 180/186/248
(honest platform-restriction clarifies at preview + a truthful "why"), 321
("next month" resolved, honest empty answer). Self-cleaning: RG1/RGT/RGCAT
all deleted, 0 live pending previews. **The run also CAUGHT one new bug** —
`clockify_expenses_categories_delete` kept a raw required id, so "delete
category <name>" sent the NAME to the wire and 400'd after confirm; fixed
TDD in **`f9bcd6b`** (name resolution incl. archived; the categories list
port/adapter gained the spec's `archived` filter — the wire DEFAULTS to
active-only). `npm run verify` = **823 tests**, madge 0, server resynced
(URL unchanged). NOTE: a second quick tunnel for a colleague may be running
against :3001 (`/tmp/colleague-tunnel.log`); the manifest baseUrl still pins
the primary tunnel — never `dev-tunnel.sh restart`.

## Handoff note (prior) — 2026-06-10 (322-prompt live-loop fixes)

A 322-prompt live test loop against the embedded add-on
(`~/Downloads/ai-assistant-loop-checklist.md` per-item state,
`…-loop-failures.md` raw notes) scored 234 pass / 59 fail / 29 unrun. The two
"critical safety" claims in the notes (item 276 "deleted without Confirm",
item 053 "Done without commit") were **disproven against the backend DB** —
the safety core held all night. The four real defect clusters are FIXED, each
strict-TDD with one focused commit, `npm run verify` = **770 tests**, 0 cycles:

- **Names/numbers as ids (`1aadb99`)** — the whole invoice failure section +
  ~20 confirmed-then-failed commits came from the planner passing NAMES (and
  invoice NUMBERS) where the schema said `id`. New `resolveEntityRef` in
  `src/harness/workflows/resolve.ts` (24-hex `looksLikeClockifyId` passthrough →
  exact-id fallback for short fake ids → `matchByName` → clarify with grounded
  options) now settles identity at PREVIEW time across projects (update/
  archive/get/delete), tags, clients (update/delete), tasks (project+task
  double resolution), groups_delete, expense categories (item 171), and EVERY
  invoice action by `number` as well as id, in either slot. An identity
  mistake is now a clarify, never a confirmed-then-failed commit.
- **Relative dates (`360aa62`)** — ~38 error receipts from "today"/"next
  Monday" reaching the wire. `resolveRelativeDay` learned weekday words (bare/
  next/last) and returns `undefined` on garbage (callers MUST clarify — the
  old fallback sliced garbage onto the wire); new `resolveInstant` produces the
  `yyyy-MM-ddThh:mm:ssZ` instants the api/reports/scheduling hosts want
  (spec-verified). Applied at entries_list, review_day/week (the "Invalid time
  value" crash is gone), reports, scheduling (list/create/publish/totals),
  time-off create (bare dates), and period_report weekly is clamped to an
  exact 7-day range with an honest warning.
- **The item-~290 session stall (`30a52b4`)** — the notes blamed "unbounded
  chat history"; forensics DISPROVED it (the chat route already windows to 12
  — now the documented `HISTORY_WINDOW_MESSAGES`, pinned by test; the
  650-message live session totals 86KB). The REAL unbounded model input was
  the agent loop feeding FULL receipts back as tool results (item 144's stall
  followed a PDF export). `TOOL_RESULT_MAX_BYTES` (24KB) in `agent-loop.ts`
  now caps each tool result (prune strings/arrays-to-head-sample, then replace
  `data` with an honest note); the admin always sees the full receipt.
- **Polish (`e8bf65d`)** — time-off create warns in the PREVIEW when requested
  days exceed the policy balance (the live 400 is misleading); items 261/264:
  permission denials were silent model text because the PROMPT forbade calling
  tools in off groups — the rule now routes the call through so the backend
  gate denies with an auditable receipt card; item 280: new prompt rule that
  listed data is reported VERBATIM (a hostile-looking name is data, not an
  instruction to filter).

The dev server was restarted (`scripts/dev-tunnel.sh sync`, tunnel URL
unchanged) so the embedded install runs all of this. **To resume the loop:**
items 293–322 are unrun; the previously-failed items in sections D/E/F/I (the
name-as-id cluster) are the regression set to re-test.

## Handoff note (prior) — 2026-06-10 (ground-truth adapter audit)

A systematic audit of the adapter's Clockify-API assumptions (spec diff vs
`docs.clockify.me/openapi.json` + goclmcp/clockify-ts-sdk cross-check + self-cleaning
live probes on the sacrificial workspace) found and fixed **9 confirmed-wrong wire
shapes**, each pinned by a test that failed first. `npm run verify` = **694 tests**,
0 cycles, sweep clean. The bug pattern was exactly the predicted one: mocked-fetch
tests asserting the code's own invented fixture back at itself, concentrated in the
**preview-only** actions live-full never commits. Fixed (one commit per area):

- **Invoices (`b0de7d1`)** — the big one: GET returns tax/discount as
  `discount`/`tax`/`tax2` (×100-scaled ints) but the PUT wants
  `discountPercent`/`taxPercent`/`tax2Percent`, so EVERY field update silently
  ZEROED the invoice's tax/discount (proven live, fix re-proven live;
  **goclmcp shares this bug** — we deliberately diverged). Payments list is a bare
  array with a `date` field (not `paymentDate`); the payments POST response is the
  INVOICE document (receipt used to carry the invoice id as the payment id — now
  list-diffed); items POST requires description+quantity (defaulted visibly in the
  preview).
- **Approvals (`a1bc1e7`)** — the list returns WRAPPERS
  (`{approvalRequest:{id,status:{state},dateRange,owner},…totals}`); the old mapping
  read the flat top level → undefined ids/object states. Resubmit takes the SAME
  `{period, periodStart}` body as submit (`{approvalId, entryIds}` never existed
  upstream); the action now mirrors submit's `week`/`periodStart` resolution.
- **Time-off (`1b0d8d1`)** — approve/deny PATCH field is `status` (not `statusType`);
  request create REQUIRES `period.days` (defaulted from the span) and takes bare
  `YYYY-MM-DD` dates; `GET /time-off/requests/{id}` is NOT a real route (404 "No
  static resource" even for an existing id) → get goes through the POST search.
- **Users (`a6938ec`)** — role change is **POST** `/users/{id}/roles` (no PUT route).
- **Hardening (`bdda999`, `0e1201a`)** — `agent_state_json` size cap (256KB, drop →
  no-resume fallback, never truncate); integration pin that a model exception
  mid-resume never loses the committed receipt; **tags rename-by-name**
  (`tags_update` now resolves `currentName` server-side like delete — the "planner
  lists instead of renaming" quirk was structural: update REQUIRED an id).

Verified-RIGHT (no change needed, now live-confirmed): expense amounts (minor on
read / major on write — the spec's `double` example is misleading), the
double-nested expenses envelope, `{invoices,total}` + `{webhooks}` envelopes,
items delete-by-`order`, `paymentDate` request field, `page-size=200` honored,
`name` filters are contains+case-insensitive (client-side exact `matchByName` is
the right design), custom-fields single-GET truly absent.

## Handoff note (prior) — 2026-06-09 (agentic loop)

**Where this stands:** the **durable approval-gated agentic loop is SHIPPED and is now
the default** (`LLM_AGENTIC` defaults ON; `=0` is the instant rollback). This was the one
remaining architectural gap — the chat planner was single-turn and could not read-then-act
(e.g. *list clients → create an invoice for "qwen"*). It now can. `npm run verify` is green
at **668 tests** (type-check + Vitest + build), 0 circular deps; everything is committed +
pushed to `main`. Built TDD, Phases 2b→5, each `npm run verify`-green with a focused commit:

- **The loop** (`src/assistant/agent-loop.ts`, wired in `da76cfc`): reads + safe writes
  auto-chain (their receipts are fed back to the model and it re-plans); the FIRST risky
  write **interrupts** into the existing preview→button-confirm flow. `runAgentConversation`
  (`src/assistant/planner.ts`) is the entry; `createTurnMachinery` in `src/routes/api.ts`
  is the single copy of the audit+undo receipt emitter / preview creator / harness
  `runAction` shared by the agentic + single-turn branches.
- **Durable resume** (`b244884`): on a risky interrupt the suspended transcript is persisted
  to a new additive `pending_confirmations.agent_state_json` column (`addColumnIfMissing`;
  NULL rows behave exactly as before). `POST /confirmations/:id/confirm` — after the
  UNCHANGED nonce / policy-recheck / one-use-claim / `commitConfirmedOperation` pipeline —
  feeds the committed receipt back as the risky call's tool result and re-enters the loop
  (`src/assistant/agent-state.ts`, Zod-validated; malformed → no resume). The resumed loop
  can chain ANOTHER preview, never commit inline.
- **DeepSeek `reasoning_content` contract (`c45bfdc`):** v4 thinking mode returns
  `reasoning_content` and REQUIRES it back verbatim on continuation (400 otherwise). The
  eval caught this. `ModelMessage`/`ToolCompletion` carry `reasoningContent`, threaded
  through the loop + the persisted state + `toWireMessage`; turns without it serialize
  byte-identically.
- **Proof:** `scripts/eval-agentic.ts` (real model + real harness vs fake) measured
  **agentic 90.5% vs single-turn 57.1% task completion** (deepseek-v4-pro, repeat=3;
  read-then-act 0/9→8/9; **0 safety violations**). A 3-subagent adversarial safety review
  found **every invariant HELD, 0 BROKEN**. `scripts/live-agentic-flow.ts` proved it on a
  **real Clockify host + real DeepSeek + real commit + resume, PASS=10 FAIL=0** (the
  "create an invoice for qwen" acceptance flow, minus the literal browser-iframe click).
- **Rollback:** `LLM_AGENTIC=0` → byte-identical single-turn (pinned by test). The live dev
  server was restarted (tunnel URL unchanged) so the embedded install runs the loop now.

The only remaining manual step is the human's literal browser-iframe acceptance click; the
over-HTTP path (incl. resume) is covered by `tests/integration/agentic-chat.test.ts` and the
over-model/over-host substance by the live script. Plan/status:
`/Users/15x/Downloads/ai-assistant-agentic-loop-GOAL.md`.

**Post-flip live fixes (2026-06-10, dogfooding found these — all fixed + verified, `npm run
verify` now = 683 tests):**
- **Streaming confirm (`1a60305`):** the resume ran synchronously *inside* the confirm
  request (multiple live model calls) → the Confirm button blocked 7.5s+ and a slow resume
  timed out as "Confirmation failed" even though the write committed. Now `POST
  /confirmations/:id/confirm?stream=1` (the embedded UI uses it) flushes the committed
  receipt as the FIRST NDJSON event (~+520ms) then streams the resume; the JSON path is
  unchanged for scripts/tests. UI: `submitConfirmStream` in `src/ui/shared.ts`.
- **Approvals periodStart (`784a085`):** `clockify_approvals_submit` sent a bare date;
  Clockify needs a full ISO UTC instant. Now takes a relative `week` ('this_week'/'last_week')
  resolved server-side from `ctx.now`, or normalizes an explicit date. Live-verified.
- **Invoice item types (`f4632b8`, `fd269e6`):** types are **per-workspace configured NAMES**
  with NO list/create API — but they're auto-created when a line item is added in the Clockify
  invoice editor, and every stored line item carries its `itemType` name. So the harness now
  **discovers** valid names from existing invoices (`discoverItemTypes`) and resolves the
  requested/omitted type against them (canonical match / clarify-with-real-list / first-as-
  default), instead of blindly sending "NEW DEFAULT". Wired into `items_add` + `create` inline
  items. See the verification discipline below — this whole class of bug came from trusting the
  code's API assumptions instead of the real API.

---

## Ground truth & verification discipline (READ THIS)

This codebase was built fast ("vibecoded") and **its assumptions about the Clockify API have
repeatedly been wrong** — invoice item types, date/instant formats, list-vs-envelope shapes,
which host serves what. Every such bug was found by hitting the **real API**, not by reading
the code. So, before trusting or extending any Clockify-touching code:

1. **The OpenAPI spec is ground truth:** `https://docs.clockify.me/openapi.json` (live, 200).
   Check the real request/response shape there before believing a comment or a Zod schema.
2. **Sibling references** (read-only — do **not** modify): `../goclmcp` (Go MCP over the same
   API; `docs/openapi`, `scripts/gen-clockify-openapi`) and `../clockify-ts-sdk` (a typed TS
   SDK + CLI + MCP). When the addon's adapter and these disagree, the addon is usually the one
   that's wrong.
3. **Verify live, don't assume:** the opt-in scripts hit a sacrificial workspace via API key
   **or** the install's `X-Addon-Token`. For anything new or surprising, write a throwaway
   probe (delete it after) — that's how the item-type/format truths above were settled. The
   per-workspace, no-list-API nature of invoice item types was only knowable by probing ~30
   workspaces live.
4. **TDD against the verified shape:** once the real shape is known, pin it with a failing
   test first, then the fix. Never "fix" a live-API bug without a test reproducing it.

---

## Earlier handoff note — 2026-06-09 (trust-lives-in-the-code roadmap)

**Where this stands:** V1 + the full Clockify REST parity effort are complete, AND the
entire **"trust lives in the code" roadmap (`NEXT_SESSION_PLAN.md`, Phases 1–7) is
delivered** for everything buildable in-repo. `npm run verify` is green at **624 tests**
(type-check + Vitest + build); everything is committed and pushed to `main`. Across this
arc the suite went 479 → 618, then a thermo-nuclear codebase-review refactor took it to
**624** (see "Structural refactor" below).

**What got built (all on `main`, each TDD'd, see "Current Status" for detail):**
- **Phase 1** — a planner **eval harness** (`scripts/eval-planner.ts`, pure scorer
  `src/eval/score.ts`) that reports pass-rate **and** a consistency metric; the argument
  contract in the prompt (`src/harness/arg-summary.ts`).
- **Phase 2** — **native tool-calling is the default** (`LLM_MODE=tool`,
  `zod-to-json-schema`, `src/harness/tools.ts`): the provider validates args; the
  arg-shape-guessing class is eliminated. Measured 95.2% pass vs 88.9% JSON.
- **Phase 3** — atomic multi-step **composition** (`src/harness/compose.ts`): no orphans.
- **Phase 4** — grounding: invoice **$0 caveat surfaced in the preview**; clarifies offer
  grounded options (`resolve.suggestOptions`).
- **Phase 5** — **idempotency** (`src/harness/idempotency.ts`, no duplicate invoices) +
  **undo** (`src/harness/undo.ts`, `POST /api/undo/:id`, UI button).
- **Phase 6** — **curated intent actions** (`src/harness/workflows/curated.ts`:
  `clockify_period_report`, `clockify_onboard_user`); adopted 12/12 in the eval.
- **Phase 7 (in-repo slices)** — operational **metrics** (`GET /api/metrics`,
  `src/metrics/metrics.ts`), **UI a11y** + a responsive "working" status, and
  **NDJSON streaming** of the harness's progress (`POST /api/chat/stream`).

**Structural refactor (thermo-nuclear codebase review, 2026-06-09).** A maintainability
pass on the existing code (net ≈−650 lines, **17 → 0 circular dependencies**, 618 → 624
tests), each step `npm run verify`-green:
- **Action builders** (`src/harness/action.ts`): `defineRiskyAction` / `defineReadAction`
  collapse the per-action scaffold — `featureGroup`/`risks`/`actionName` had been restated
  3–4× across 64 risky blocks. All 18 workflow files migrated; the builder derives
  `operation.featureGroup` from `resolveFeatureGroup` so the confirm-time gate keys on the
  correct per-entity group. (Typing rationale is in the action-builder design memory.)
- **Type-only import cycles eliminated (17 → 0)**: shared Clockify summary shapes →
  leaf `src/clockify/types.ts`; `IdempotencyLedger` → `action.ts`; shared UI types →
  `src/ui/shared.ts`. **Keep `npx madge --circular --extensions ts --ts-config tsconfig.json
  src` at 0.**
- **Permission confirms unified**: `ActionContext.savePolicy` lets the permission action's
  `commit` self-persist, so `/confirmations/:id/confirm` routes EVERY op through the single
  `commitConfirmedOperation` choke point (the inline permission special-case is gone; the
  `permission_change` gate-skip is unchanged).
- **Less surface**: the vestigial SDK-wrapper factory is deleted (`createRestWorkspaceClient`
  is the only client path); `rest-workspace.ts` has one HTTP path (`core.call`); `store.ts`
  test-only methods moved to a `TestStore` type; the 966-line `fake-clockify.ts` split into
  per-area `tests/helpers/fake/*`; `mount()` render builders extracted to `src/ui/render.ts`.

**What remains is NOT code you can write alone — it needs the human's decisions / live
credentials:**
1. **Stable hosting** — the dev tunnel URL rotates; a named-tunnel-on-a-domain (Cloudflare
   zone) or a real deploy is an infra/account decision (user declined the zone for now).
2. **Prod security review + token rotation.**
3. **Prod AUDIT-host `X-Addon-Token` clearance** — needs a captured prod token; run
   `scripts/host-auth-spike.ts` with a `LIVE_ADDON_TOKEN` to settle it (dev cleanly
   reports "audit log not available", so this is prod-only).

**To CONTINUE the build:** there's no buildable phase left — the roadmap is done. Good next
work is either the human-gated items above (with the user) or net-new product scope. **To
LIVE-TEST / dogfood:** start from `NEXT_SESSION_PROMPT.md` (it tells you how to bring the
tunnel + install back up). The forward plan + "perfect state" vision live in
`NEXT_SESSION_PLAN.md`. Keep the discipline: failing test first, `npm run verify` green,
focused commits, no new deps without the user's OK, never print/commit tokens.


## Current Status

V1 is implemented and verified; the **full Clockify REST surface parity
effort (`slopbranch:API_COVERAGE_PLAN.md`, Phases 0–16) is COMPLETE** — ~115
typed catalog actions across 16 feature areas and 3 API hosts, each routed
through the existing safe/risky harness — and the **"trust lives in the code"
roadmap (`NEXT_SESSION_PLAN.md`, Phases 1–7) is COMPLETE for everything buildable
in-repo** (see the Handoff note at the top). The per-phase detail follows below;
the headline is in the Handoff note. `npm run verify` = **624 tests**.

**Live end-to-end PROVEN (2026-06-08):** the add-on was registered + installed on
a sacrificial Clockify dev workspace and driven through the real embedded chat —
install → **sidebar** component → DeepSeek planner → harness → Clockify REST
(dev host, `X-Addon-Token`) → receipt. A tag was created and a detailed report
fetched live. Getting there fixed several real defects (see the auth/host + cookie
notes under "Runtime & Known Constraints"):
  - **Install verification:** the Clockify add-on token-signing **public key is one
    fixed platform key** (published at `{apiUrl}/api/auth/public-key`), now embedded
    as the built-in default (`src/addon/clockify-public-key.ts`); `CLOCKIFY_ADDON_PUBLIC_KEY_PEM`
    is optional. `/lifecycle/installed` requires only `authToken`+`workspaceId`.
  - **UI surface:** the component is a **`sidebar`** entry (not an activity tab) and
    ships an `iconPath` (`/icon.svg`) — a sidebar with no icon doesn't render.
  - **Host resolution:** call the host from the install context, not hardcoded —
    `apiUrl`+`/v1` for the api host, the `reportsUrl` claim+`/v1` for reports
    (`src/clockify/api-base.ts`; captured at component load into `installations.reports_url`).
    The audit host has **no claim** (the only URL claims are
    backendUrl/reportsUrl/locationsUrl/screenshotsUrl/ptoUrl) and is derived prod-only
    (`resolveClockifyAuditBase`) — see the AUDIT note below.
  - **Embedded session:** the session cookie is `SameSite=None; Secure; Partitioned`
    (required inside Clockify's cross-site iframe).
  - **Resilience:** the chat route guards async errors → a failed action returns an
    error receipt instead of crashing the process.

**Risky-write confirm flow PROVEN live (2026-06-08):** `scripts/live-confirm-flow.ts`
drove the never-before-browser-verified button-confirm safety mechanism over HTTP
against the real server + DeepSeek + dev host (`PASS=16 FAIL=0`): a risky prompt
returns a dry-run preview and executes nothing; typed "yes" never executes; a wrong
nonce is rejected; a nonce is bound to its own preview (cross-batch confirm rejected
— this is what scopes `Confirm all`); the correct button nonce executes exactly once
and the tag is really gone; the one-use nonce cannot be replayed; **policy is
re-checked at confirm time** (lowering a group after preview → `policy_denied`).
Expiry (5-min TTL) stays covered by `tests/unit/confirmations.test.ts` +
`tests/integration/risky-preview.test.ts`.

- `npm run verify` is green (**624 tests**: type-check + Vitest + build).
- **NDJSON streaming of the harness's progress (Phase 7 slice, 2026-06-09).**
  `POST /api/chat/stream` streams the HARNESS's progress — `{type:"result",result}`
  per harness result as it executes, then `{type:"reply",kind,text}` (the *truthful*
  reply), then `{type:"done"}` (`{type:"error"}` on model failure) — **never the
  model's tokens** (which would conflict with the truthful-preview override). The
  shared `executeChatTurn(claims, installation, message, onResult?)` is the single
  copy of the turn's safety logic; the JSON `POST /api/chat/messages` route is now a
  thin wrapper over it (behavior identical). UI: `createNdjsonParser` (stateful line
  parser, tested) + `submitStreaming` (receipts render as they arrive; previews are
  **batched** and flushed at the reply so "Confirm all" stays one card; tested) +
  `createFetchApi.streamMessage`; the composer streams (`submitMessage` is the
  non-stream fallback). The dominant model-call latency is unchanged, but multi-action
  turns disclose progressively.
- **UI accessibility + responsive status (Phase 7 slice, 2026-06-09).** The embedded
  chat got a WAI-ARIA pass: an `<h1>` header; the message log is `role="log"
  aria-live="polite"` (new turns are announced); errors are `role="alert"`, the
  working status `role="status"`; the composer input and every permission `<select>`
  have accessible names; receipt/preview cards are labelled groups (Details toggle has
  `aria-expanded`, Undo is labelled); CSS adds a visible `:focus-visible` ring and
  honors `prefers-reduced-motion`. Responsiveness: the send flow is the testable
  `submitMessage(api, msg, hooks)` orchestrator — it announces "Assistant is working…"
  BEFORE the request and always clears it (even on error), disables Send + sets
  `aria-busy`, guards double-submit, and returns focus to the input. **Note on
  streaming:** token-streaming the *model's narration* conflicts with the
  truthful-preview safety override (a streamed "Done!" could leak before the route
  replaces it for a pending risky preview), so we stream a *status* + the *truthful*
  result, not model tokens. (The safety-compatible NDJSON streaming of per-result
  receipts is now built — see the streaming bullet above.)
- **Operational metrics (Phase 7 slice, 2026-06-09).** "Is the assistant working?"
  derived from data already recorded (every action is audited with its receipt;
  every risky preview is a pending-confirmation row with a status). `GET /api/metrics`
  (session-gated, scoped to the caller's OWN actions for privacy; optional `?since=<ISO>`)
  returns per-action success/failure (busiest first), an **error taxonomy** (counts by
  code), and **confirm/cancel/expire/pending** rates. Pure aggregation in
  `src/metrics/metrics.ts` (`buildMetrics`), fed by `store.listActionOutcomes` +
  `listConfirmationOutcomes`. `scripts/eval-trend.ts` summarizes the timestamped
  `eval-results/*.json` into a pass-rate/consistency trend over time. (Remaining
  Phase 7 — stable hosting, prod security review, token rotation, prod AUDIT-host
  clearance — needs live credentials / infra decisions and is human-gated.)
- **Curated intent actions (Phase 6, 2026-06-09).** High-level "jobs to be done"
  (`src/harness/workflows/curated.ts`) so the model reaches for one clear verb
  instead of scrambling ~115 primitives, with the harness owning what the model is
  bad at. `clockify_period_report` (read) resolves a **period keyword**
  (today/yesterday/this_week/last_week/this_month/last_month/last_7_days/last_30_days/
  this_quarter/last_quarter/this_year/last_year) → a UTC date range server-side via
  `ctx.now`, then runs the summary/detailed/weekly report (the model never computes
  calendar dates). `clockify_onboard_user` (risky) bundles invite + group-adds into
  **one preview**, committed atomically via the composition layer (invite required,
  group adds best-effort). Primitives remain for power use. **Measured (deepseek-v4-pro,
  tool mode, repeat=3): curated cases 12/12 adopted** — the model picks the curated
  job over primitives; the `defaults` report cases were widened to accept
  `period_report` (equally valid — calibration, not a regression). Further curated
  jobs (invoice_client, set_up_project, audit_changes, and a permissions job to close
  the `permissions/full` action-selection gap) follow the same pattern.
- **Grounding & early constraint surfacing (Phase 4, 2026-06-09).** Read the world
  before acting; never punt vaguely; warn about platform limits in the **preview**,
  before confirm. (1) `clockify_invoices_create` now adds the invoice-item-type caveat
  to the **preview card** whenever the invoice has line items (a $0 outcome is no
  longer a confirm-time surprise — there's no API to list/create item types, so it's a
  surfaced known constraint). (2) Name-not-found clarifies are **specific** — they
  offer "did you mean one of these?" options built from the candidates already fetched
  during resolution (`resolve.suggestOptions`: prefers names containing the query,
  falls back to all active, excludes archived, capped at 12), never "go list them
  yourself." Applied to invoices_create's client, projects_delete, tags_delete, and
  create_work_package's project `clientName`. No extra Clockify calls.
- **Undo the last reversible action (Phase 5b, 2026-06-09).** A successful action
  that CREATED entities now carries a one-use `undo: { id }` handle (chat safe-write
  + confirm commit paths); `POST /api/undo/:id` reverses it by deleting the created
  entities (`src/harness/undo.ts` → `reverseCreation`, read from
  `receipt.changed.created`, in REVERSE order: task→project→client). It re-checks
  write policy BEFORE consuming the one-use record (a lowered policy denies without
  burning it), then atomically claims (`markUndone`) and reverses; partial failure is
  a warning. Deletes/field-updates are out of scope (can't un-delete; restoring a
  field needs before-state we don't capture), and users/groups are deliberately NOT
  reversible. Store: `undo_records` table. UI: an **Undo** button on reversible
  receipts (flips to "Undone").
- **Idempotent confirmed commits (Phase 5a, 2026-06-09).** Re-confirming the SAME
  intent (issuing "invoice qwen for 1000" three times, or confirming a re-issued
  preview) no longer creates duplicates (the empty-`qwen`-invoice problem).
  `commitConfirmedOperation` (the single choke point for every risky commit, single
  + batch) looks up a workspace/admin/action-scoped **intent hash** after the policy
  gate and returns the prior receipt (annotated `idempotent_replay`) instead of
  mutating. Opt-in per action: `ActionDefinition.idempotencyKey(operation)` returns
  the SEMANTIC identity; `clockify_invoices_create` uses client + items + currency +
  notes, **excluding** the auto-generated number/issuedDate/dueDate (so two previews
  of the same request still dedupe). Ledger is store-backed (`idempotency_keys` table,
  10-min window via `src/harness/idempotency.ts` + `src/routes/api.ts`); only
  SUCCESSFUL commits are recorded (a failed attempt stays retryable); ledger-gated so
  every existing commit path is byte-identical without a ledger. (Undo of the last
  action is **Phase 5b**, done — see above.)
- **Atomic multi-step composition (Phase 3, 2026-06-09).** `src/harness/compose.ts`
  → `runComposition(steps)` is the **intent layer**: an ordered list of steps with
  transactional semantics in one place (so handlers + future curated actions don't
  each re-implement them). A **required** step that errors rolls back every entity
  created so far (undos run in REVERSE via `deleteEntity`) → **no orphans**; a
  **best-effort** step (`required:false`) that errors warns and continues; a step may
  **stop** with a clarify/preview (not a failure — prior creates are kept, matching
  the old behavior). Only CREATED entities get an undo; reused entities are never
  rolled back. `clockify_create_work_package` is re-expressed on it (client/project/
  task = required, timer = best-effort) — behavior parity held by the existing 8
  safe-write tests; 4 new tests pin rollback/reuse/best-effort-timer. **Not touched:**
  the risky `invoices_create + items` commit path (an item-add failure shouldn't roll
  back a valid invoice — that's idempotency/undo, Phase 5); the core is ready to
  compose it later.
- **Native tool-calling is now the default planner mode (Phase 2, 2026-06-09).**
  The model calls **typed tools** whose arguments the provider validates against a
  JSON schema generated from the SAME Zod schema the harness validates with
  (`src/harness/tools.ts` → `toolsForModel()`, via the new `zod-to-json-schema`
  dep). Free-form JSON is now the **fallback** (`LLM_MODE=json`, and automatically
  for the `gemini-cli` backend, which has no `completeWithTools`). `planConversation`
  branches on `useTools` + client support; **defense in depth is unchanged** — every
  tool-call argument still passes through the action's Zod schema + the risk/policy
  gate before executing (provider validation is convenience, never the trust
  boundary), and risky writes still preview → button-confirm. The tool system prompt
  (`buildToolSystemPrompt`) drops the JSON-shape instruction + the redundant catalog
  listing (the tools carry the schemas) but **keeps the action-selection nudges**
  (delete-by-name-don't-list, create+`startTimer`, act-don't-just-describe) and all
  safety invariants — trimming those first regressed name-resolution, and the meter
  caught it. **Measured (deepseek-v4-pro, repeat=3): tool-calling 95.2% pass / 92.9%
  consistency vs JSON 88.9% / 91.3% (+6.3pp pass, +5 stable-pass).** The arg-shape
  class is **eliminated** (name-resolution + billing args now solid); remaining misses
  are action *selection* (`permissions/full` intent recognition → Phase 6) or noise.
  A/B with `scripts/eval-planner.ts --json-mode`.
- **Planner eval harness + arg contract in the prompt (Phase 1, 2026-06-09).**
  Quality is now a number. `scripts/eval-planner.ts` drives the **real planner**
  (planning only, no Clockify writes) over a tagged corpus (`scripts/eval/cases.ts`,
  ~42 cases) and scores each plan with a pure scorer (`src/eval/score.ts`),
  reporting **pass-rate AND a consistency metric** (`--repeat=N` → % of runs that
  produce the identical action+arg-keys — outcome determinism, not token-level).
  `--no-args` runs an A/B baseline with the arg contract off; results write to
  `eval-results/<ts>.json` (gitignored). Run:
  `npx tsx --env-file=.env.server scripts/eval-planner.ts --repeat=3`.
  **1B — the argument contract is now in the system prompt:** each action renders
  as `- <name> (group; risk) args{<sig>}: <desc>` where `<sig>` is a terse Zod-
  derived signature (`src/harness/arg-summary.ts`, e.g. `clientName?: string;
  items?: object[]`), plus a rule to use those exact arg names. **Measured on
  deepseek-v4-pro (repeat=3): baseline (arg contract OFF) 85.7% pass / 86.5%
  consistency → with the contract 90.5% pass / 90.5% consistency (+4.8pp /
  +4.0pp).** Biggest wins are exactly the arg-shape/action-disambiguation class
  (reports_weekly/detailed stop collapsing to review_week/clarify;
  update_permissions consistently uses the `groups` key; compose uses canonical
  `project`). Prompt grows ~+1.9k tokens (cacheable). The durable version is
  Phase 2 (native tool-calling); the meter now judges it. The model is still sent
  only the catalog + policy — no tokens/secrets/headers; signatures read the
  schema, not values.
- **Truthful previews (safety, 2026-06-08):** the model sometimes narrated "Done!/
  Confirmed" in its reply for a risky action the harness actually returned as a *pending
  preview* — so the chat bubble claimed success above an un-clicked Confirm button, and
  that false claim was stored in history (convincing the model on later turns the action
  had happened). The chat route now **deterministically replaces** the reply text with a
  truthful "review and click Confirm — nothing has been changed yet" whenever previews
  are pending, and stores THAT (not the model's claim). Only the button confirm executes.
  The UI also renders receipt **warnings inline** and shows "Done — with notes" for a
  partial success (e.g. invoice created but the line item couldn't be added), so a
  partial result is never shown as a clean success.
- **Invoice creation smoothed (2026-06-08):** `clockify_invoices_create` used to punt
  for a client id (it only displayed `clientName`) and required number/dates/currency,
  and there was no way to add a line item to the not-yet-created invoice. Now it
  **resolves the client by name** (clarify on none/ambiguous), **defaults**
  number/issuedDate(+today)/dueDate(+30d)/currency(USD) — shown in the preview — and
  accepts inline **`items`** (description/quantity/amount) added onto the new invoice in
  the same preview→confirm step. **Invoice item types are workspace-configured named
  entities** (Clockify → Workspace settings → Invoices); a fresh workspace has NONE
  (`MANUAL`/`NEW DEFAULT`/etc. all 404 `"Invoice item type with name X not found"`, and
  there's no API to list/create them), so a failed item add no longer dumps a raw 404 —
  the invoice is still created and the receipt carries an **actionable warning**.
  `itemType` defaults to `"NEW DEFAULT"` and is overridable. Proven live
  (`scripts/live-invoice-flow.ts`).
- **Planner backend is selectable (`LLM_PROVIDER`).** Default `http` = the
  OpenAI-compatible client (`createModelClient`; DeepSeek via `LLM_BASE_URL`/
  `LLM_API_KEY`/`LLM_MODEL`). Set `LLM_PROVIDER=gemini-cli` to instead drive the
  planner through the **authenticated `gemini` CLI** (`src/assistant/gemini-cli-client.ts`,
  no API key — it runs `gemini -o json -p <prompt>` and reads the envelope's
  `.response`; optional `GEMINI_MODEL` pins a model, else the CLI router picks).
  The gemini provider needs no `LLM_BASE_URL`/`LLM_API_KEY`. It is **dev-only**:
  each chat turn spawns the CLI, so it is slower than the HTTP path. Proven live —
  the embedded chat (reads, safe write, risky write→preview→confirm) ran end-to-end
  on Gemini (`scripts/live-planner-quirks.ts`, PASS=9). Switch back with
  `LLM_PROVIDER=http` (or remove the line).
- The REST `WorkspaceClient` adapter is composed from a multi-host core
  (`src/clockify/rest/core.ts`: api / reports / audit hosts) plus one typed REST
  module per area (`src/clockify/rest/<area>.ts`), assembled in
  `src/clockify/rest-workspace.ts`. Each area also has a port slice
  (`src/clockify/ports/<area>.ts`) and a workflow module
  (`src/harness/workflows/<area>.ts`). The generic `manage_*`/`prepare_*` actions
  were superseded by typed per-area actions (invoices, expenses, time-off,
  schedule, webhooks).
- The exhaustive live exerciser drives every action through the **real harness**
  (preview→confirm→commit) against a sacrificial workspace:
  `scripts/live-full.ts` → `PASS=115 PREVIEW_OK=28 FAIL=0 SKIP=4`, and
  `scripts/live-sweep.ts` → 0 leftovers. Risky writes that need live preconditions
  or have high blast radius (time-off/approvals/scheduling-publish/user role &
  invite & deactivate) are **preview-only** in the live run by design; their
  request shapes are pinned by mocked-fetch unit tests.
- Live API facts worth knowing (encoded in code + tests): list endpoints often
  return envelopes (`{webhooks:[…]}`, `{expenses:{expenses:[…]}}`, `{invoices:[…]}`,
  `{total,requests:[…]}`) not arrays; several single-GETs 405 so the item is read
  from the list (invoice items, custom fields, holidays, scheduling assignments,
  approvals, groups); the time-entry/expense/holiday/scheduling PUTs replace and
  need the full body; amounts are minor units on the wire for invoices/payments
  but **major** for expenses; the webhook `authToken` secret is never accepted nor
  returned; reports run on the reports host (`POST /reports/{summary|detailed|
  weekly}`); audit search runs on the audit host (`POST /audit-log`).
- **Reports host (Phase 14): cleared on the X-Addon-Token.** The reports host
  (`reports.api.clockify.me/v1`) authenticates with the production add-on token —
  the multi-host core sends it over the same host-routing + auth-header path as the
  api host (the dev API key works too). No remaining gate for reports.
- **AUDIT host (Phase 15) — resolved for non-prod; prod clearance still unconfirmed.**
  Clockify publishes **no audit URL claim** (confirmed by the docs *and* by decoding
  the live install + user tokens: the only URL claims are
  backendUrl/reportsUrl/locationsUrl/screenshotsUrl/ptoUrl). The audit log lives only
  on the `auditlog-api.api.<tenant>` subdomain of `api.<tenant>` (prod/regional)
  hosts, so it is derived prod-only by `resolveClockifyAuditBase`; on the dev/path
  host (`developer.clockify.me/api`) there is no audit host, and the core now returns
  a clean **"Audit log is not available in this Clockify environment"** error receipt
  instead of the old raw `fetch failed` (verified live — server stays up). What
  remains unconfirmed is the production X-Addon-Token **clearance** for the audit host
  when it *does* exist: `POST /audit-log` + the experimental entity-changes feed 400'd
  on the earlier spike (shapes pinned by unit tests). Re-run `scripts/host-auth-spike.ts`
  with a captured prod `LIVE_ADDON_TOKEN` to settle that. The add-on-token install
  path (`scripts/addon-smoke.ts`) is also human-gated.
- **Deferred:** Phase 17 (raw `clockify_api_get`/`api_request` fallback) — omitted
  from V1 (letting the model propose arbitrary paths conflicts with "the harness
  decides, not the model"); requires a safety review before ever building.
- **Live planner quirks RESOLVED + PROVEN live (2026-06-08):** the two known
  DeepSeek-planner gaps are now smoothed end-to-end (`scripts/live-planner-quirks.ts`,
  `PASS=9 FAIL=0`, self-cleaning + 0 leftovers):
  (1) **"create a project AND start a timer on it" in ONE turn** no longer starts a
  BARE timer. `clockify_create_work_package` gained an optional `startTimer` that
  resolves/creates the project (and task) and starts the timer on that id
  server-side (gated additionally by `time_tracking` write; skipped with a warning
  when read-only). Crucially, live debug showed the planner emits `startTimer: true`
  (boolean) and a flat `projectName` (not nested `project:{name}`), so the schema now
  accepts a boolean OR options object and a `z.preprocess` folds bare-string entities
  + flat `*Name` aliases into the canonical nested shape.
  (2) **`clockify_tags_delete` dropping its `id`** no longer dead-ends at
  `invalid_args`: the handler accepts an exact `name` and resolves it to an id
  (list→`matchByName`, clarify on none/many), with the resolved id pinned into the
  confirmable operation. The planner prompt was reworded to pass the name directly
  (not list-first) and to use `create_work_package`+`startTimer` for one-turn
  create+timer. Note: Clockify **reserves a project name even after archive-then-delete**
  (so tests use unique `AIASSIST_SMOKE_*` names).
- **Broad live "dogfood" tour smoothed more arg-shape edges (`scripts/live-chat-tour.ts`,
  37 turns / 25–28 actions per run):** the same "planner can't see the schema, so it
  omits/flattens required args" class showed up in more places, all now fixed (defaults
  + input normalization only — no host/auth changes): **reports** default the date range
  to the last 7 days (weekly especially used to `invalid_args`); **audit search** defaults
  actions + range (so on dev it returns the clean "not available" message, not
  `invalid_args`); **`clockify_projects_delete`** resolves by name like tags;
  **`assistant_update_permissions`** accepts the flat `{invoices:"read"}` / `{group,level}`
  shape. Verified live: delete-project-by-name and set-permission now preview→confirm
  end-to-end. **Still open (not regressions):** `webhooks_list` + `workspace_get`
  (`GET /workspaces`) return **401 "API is not accessible"** with the add-on token on the
  **dev host** (likely a dev-environment access limit; may differ in prod — left as-is to
  avoid changing prod behavior); `clockify_log_work` can `invalid_args` when the planner
  omits the required `start`; and a tag *rename* sometimes makes the planner call
  `clockify_tags_list` instead of `clockify_tags_update` (narrates "renaming" but doesn't).

## Known limitations & honest state (2026-06-09, post-roadmap)

Most of the architectural limits that motivated Phases 1–7 are now **resolved**: the
arg-shape-guessing class is eliminated by native tool-calling (Phase 2); multi-step
intents are atomic (Phase 3); duplicate invoices are impossible (Phase 5a); the last
action is undoable (Phase 5b); platform constraints surface in the preview (Phase 4); and
the model reaches for curated jobs (Phase 6). What remains below is either a **Clockify
platform constraint** or a **human-gated launch item** (hosting, prod security/clearance)
— **none is fixed by swapping the LLM**:

- **(Phase 1B done) The planner is now sent a terse arg signature per action**, not just
  name/description/risk — so it stops guessing argument shapes (flat `projectName`,
  `startTimer:true`, missing ids, omitted required fields) as often. We still keep the
  per-action mitigations as defense in depth: forgiving Zod (`z.preprocess`/unions),
  server-side defaults (reports/audit ranges, invoice number/dates/currency), and
  name→id resolution (tags/projects/clients). **(Phase 2 done, 2026-06-09)** native
  tool/function-calling is now the **default** (`LLM_MODE=tool`): the provider validates
  args against JSON schemas generated from the Zod schemas, so the arg-shape class is
  **eliminated** (tool-calling 95.2% pass vs JSON 88.9% on deepseek-v4-pro). The Zod +
  risk/policy gate still re-validates every call. What remains is **action selection**
  (e.g. `permissions/full` intent recognition) — that's a curated-intent-action job
  (Phase 6), not an arg-shape problem.
- **Invoice line items require a workspace-configured invoice item type** (Clockify →
  Workspace settings → Invoices). There is **no API to list or create them**; a fresh
  workspace has none, so amounts stay $0 until an admin sets one up in the UI (one-time).
  The add-on now warns about this **in the preview** (Phase 4) so the $0 outcome is
  surfaced before confirm, and still returns an actionable warning on the receipt
  instead of a silent $0. Not a model or code bug — a Clockify platform constraint.
- **Models narrate false completion.** Every backend tried (deepseek-v4-pro, gemini-cli)
  sometimes says "Done/Confirmed" for a pending risky preview. The route now overrides
  this deterministically (truthful previews) — the right fix, model-agnostic.
- **Smaller open edges:** ~~`clockify_log_work` can `invalid_args` when the planner omits
  the required `start`~~ **FIXED (2026-06-09):** `log_work` now takes a duration
  (`durationHours`/`durationMinutes`) + a **relative** day (`date: today/yesterday`/`dayOffset`)
  and the harness anchors start/end server-side (`ctx.now` does the date math — the model
  doesn't know the calendar date); fired ~33%→75% (repeat=8). `assistant_update_permissions`
  now advertises its levels + phrasings so "give me full access to reports" maps to it
  (0%→37.5%; a fuller fix is the curated-action layer, Phase 6). ~~Tag *rename* sometimes
  lists instead of updating~~ **FIXED (2026-06-10):** the cause was structural —
  `tags_update` REQUIRED an id, so the model couldn't rename by name; it now resolves
  `currentName` server-side (the delete-by-name pattern) + the prompt names the rename
  case. ~~`webhooks_list`/`workspace_get` 401 on the dev host (likely dev-only)~~
  **CHARACTERIZED + PARTLY FIXED (2026-06-10, probed with the install's own add-on
  token):** NOT dev-only — Clockify refuses some endpoint families for the ADD-ON
  TOKEN CLASS regardless of manifest scopes (the generated scope schema has no
  webhook scope at all, and the manifest already declares every scope that exists).
  Blocked for add-ons: **webhooks (all), custom-fields CREATE (management), the
  account-level `GET /workspaces`**. Custom-fields LIST works. `workspace_get` is
  FIXED (now uses the workspace-scoped `GET /workspaces/{id}`, which works on the
  add-on token). The blocked calls now fail with an honest "Clockify does not allow
  add-ons to call …" receipt (mapped in `core.call`; API-key dev scripts still see
  the raw 401).
- **Model choice:** not the bottleneck. `deepseek-v4-pro` (current) and the `gemini-cli`
  backend behave similarly on the above; a swap won't change the schema-guessing or the
  invoice-item-type limits. Switch backends via `LLM_PROVIDER` (see above) only for
  cost/latency/quality preference, not to fix these.
- **Human-gated launch items (the only "open work", all outside the codebase):**
  (1) **stable hosting** — the dev quick-tunnel URL rotates; a named-tunnel-on-a-domain
  (Cloudflare zone) or a real deploy is an infra decision; (2) **prod security review +
  token rotation**; (3) **prod AUDIT-host `X-Addon-Token` clearance** — run
  `scripts/host-auth-spike.ts` with a captured prod `LIVE_ADDON_TOKEN` to settle it (dev
  cleanly reports "audit log not available", so it's prod-only). These need the user's
  decisions/credentials, not more code.

