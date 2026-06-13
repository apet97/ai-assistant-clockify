# CLAUDE.md — AI Assistant Add-on

Read this first in every Claude Code session. History/journals: `docs/HISTORY.md`
(handoff archive); live-test state: `~/Downloads/ai-assistant-loop-checklist.md`
(322/322 closed) + `…-loop-failures.md` (root causes + resolutions).

## Current state (2026-06-13)

Everything buildable is DONE and live-verified: V1 + full REST parity (137
typed actions, 16 areas, 3 hosts) + the trust-lives-in-the-code roadmap + the
durable agentic loop (default ON) + the 322-prompt live-loop fix arc + a live
regression re-run in the embedded chat (all fixed flows passed; verified vs UI
AND the audit DB) + a measured quality pass (2026-06-10: truth/dead-code/fake
drift) + a full-angle live investigation (2026-06-11: safety 16/16, agentic
10/10 + 21/21, live-full 115/115, planner 98.6%, chat-tour clean — one stale
live fixture fixed, no product defect; notes in
`~/Downloads/ai-assistant-quality-pass-NOTES.md` +
`…-investigation-NOTES.md`) + a full-angle audit fix run (2026-06-11,
fix-only of the `e538561` audit): 34 fixes landed across security (lifecycle
workspaceId now trusts the token claim, not the body), safety invariants
(resume tool-result cap, nonce never persisted), API drift (webhook-logs
POST-only, invoice has no note/subject/status), truthfulness (preview cards
show chosen values), efficiency, dead-code, test-gaps, and docs — 0
wont_fix/blocked/deferred; gate green; notes in
`~/Downloads/ai-assistant-full-angle-audit-NOTES.md`) + an adversarial codebase
review (2026-06-11) whose actionable findings landed as three duplication
consolidations — the major/minor amount mapping (`src/harness/money.ts`),
day-based time spans (`src/durations.ts`), and the pagination limits (exported
from `rest/core.ts`) — plus a dead-param cleanup; the larger `routes/api.ts` and
`db/store.ts` structural decompositions were reviewed and DEFERRED (both <1000
LOC and cohesive; the api.ts splits touch safety-critical flow — not worth the
regression risk yet).
A live-dogfooding + live-bug-fix arc (2026-06-11/12) followed: Sonnet agents
drive `scripts/repro-chat.ts` (real route + live model + fake) and the user's
live screenshots surfaced ~22 fixes — custom-field/webhook refuse up-front,
clarify renders once, prefer-existing-entity grounding, amounts in major units,
year/stale-date narration, whitespace-input guard, `'me'`→adminUserId on rate
updates, expense-for-another-user, the live-verified role-grant contract, and a
fake-fidelity fix (deleteEntity truly removes). The Clockify rate model is now
fully covered (live-verified 2026-06-12): project DEFAULT rate on project
create/update; per-project MEMBER rate (`clockify_projects_rate_update`,
membership-validated); TASK rate (`clockify_tasks_rate_update`, now
task-validated + major-unit preview); and the Team-section workspace MEMBER
rate (`clockify_users_rate_update`). Tasks can also assign members inline on
create + update (`assigneeIds` takes ids, exact names, or 'me' — resolved via
`resolve.ts` `resolveUserRefs`, clarifies on ambiguous/unknown; spec +
live-verified). The same identity-resolution arc then swept the remaining
user/group slots (2026-06-12): group add accepts a member LIST; holidays
(`userIds`+`userGroupIds`), time-off balance (`userIds`), and scheduling create
(`userId`/`projectId`) all resolve names; and time-off POLICIES can now be
scoped to groups/users (`userIds`/`userGroupIds`, a NEW capability — the API
supported it, the addon didn't). Approvals + scheduling are per-user only (no
group target in the API). Single-member resolution lives in `resolveUserRef`,
lists in `resolveUserRefs`/`resolveGroupRefs` (one `resolveRefList` core).
Reusable: `scripts/repro-chat.ts`
+ `.claude/workflows/dogfood-and-fix.js`.
A follow-up sweep (2026-06-12) finished the ENTITY side of the same invariant:
the optional project/task slot pair (expenses create/update, fix_entry,
start_timer, log_work, entries_list, scheduling project_totals) resolves via
one `resolveProjectTaskRefs`; `projects_create` resolves `clientName`;
`invoices_create` resolves a non-hex `clientId`; `expenses_update` gains
`categoryName`. Plus: every HTTP model request now carries
`AbortSignal.timeout` (`LLM_TIMEOUT_MS`, default 120s). Post-sweep planner
eval: 97.8% (135/138) — the one hard fail, `time_tracking/start` choosing
`clockify_status` for a bare "start a timer", reproduces IDENTICALLY at
pre-sweep commit `3261a1c` (DeepSeek provider drift, not a regression).
The USER side then closed too: all 7 read-filter `userId` slots resolve
id/name/'me' via `resolveUserFilter`, and `users_deactivate` resolves +
verifies the member (the self-guard now holds on the RESOLVED id — 'me'/
own-name used to slip past it).
A final harvest arc (2026-06-12) closed the rest: relative DATES on
invoices_create (`issuedDate`/`dueDate`), approvals `periodStart` (which used
to parse "June 1" via `new Date` → year 2001!), and holidays in_period (+ its
missed `assignedTo` user slot); NAME resolution for time-off request policies,
project templates, and entry TAGS (`resolveTagRefs`; start_timer/log_work/
fix_entry take `tagNames` or names in `tagIds`); scalar-coercion absorption
(`src/harness/arg-shapes.ts` — `zStringList`/`zNumberLike` across ~25 fields;
tool schemas stay canonical) + field-path-prefixed invalid_args; and the OPS
layer: per-session chat rate limit (`src/routes/rate-limit.ts`,
`CHAT_RATE_LIMIT_MAX`/`_WINDOW_MS`, 429 + Retry-After), retention pruning
(`store.pruneExpired` hourly — audit_events/chat_messages NEVER), model 429/5xx
single-retry + error-body snippet, SIGTERM graceful shutdown
(`createShutdownHandler`), and honest UI errors (401 → "reload" copy; the
routes' own JSON copy reaches the chat error bar). A start_timer description
nudge recovered the provider-drift eval case — planner eval reached
**138/138 (100%)**, stable-pass 46/46.
An "elevate the product" arc followed (2026-06-13): **session restore**
(`GET /api/chat/history` replays the last 50 messages + re-serves LIVE pending
previews with a ROTATED one-use nonce — `rotatePendingNonce`, old plaintext
dies, TTL never extended; the UI restores on mount), **live progress**
(`{type:"status", action, label}` NDJSON lines before each tool execution —
labels from `action-labels.ts`, NEVER args; the typing bubble shows them),
**cost/latency telemetry** (`turn_telemetry` table + `trackUsage` wrapper;
`GET /api/metrics` gains `usage` totals + last-24h — the cost review has data),
**eval lock-in** (8 new planner cases for the capability arcs; baseline now
**162/162 (100%)**, 54 cases, stable-pass 54/54), **undo extension**
(group/holiday/assignment now reversible; time_off_request can't be — its
delete needs the policy id), broader welcome prompts, and **GitHub Actions CI**
(verify + madge on every push/PR).
A Gemini-readiness arc (2026-06-13) followed: the model client now speaks
Gemini 3.x (per-tool-call `thought_signature` echo — REQUIRED on continuation
or the loop 400s — and `LLM_REASONING_EFFORT`, both inert for DeepSeek,
pinned), and four harness improvements took BOTH Gemini tiers to 100% without
denting DeepSeek: time-off `requests_create` anchors 'N days next/this week'
to the first N workdays (the resolveLogTimes pattern; preview shows the
dates), report descriptions teach the existing last-7-days default, the
tool prompt gained a call-don't-ask rule for defaulted args, and `log_work`'s
`description` is OPTIONAL (an honest blank — lite was the only model
correctly refusing to invent one). Measured: **planner 108/108 on
gemini-3.1-flash-lite(low) AND gemini-3.5-flash(low), 162/162 on DeepSeek
v4-pro; agentic 7/7 on all three, 0 safety violations.** Backend swap is
env-only (`LLM_MODEL` + `LLM_REASONING_EFFORT=low`); prod stays DeepSeek
until decided.
A goated-audit run (2026-06-13, fresh-eyes "find what every pass missed":
8 subsystem maps → 15-dimension loop-until-dry hunt → 3-skeptic majority verify;
82 findings, 52 confirmed) landed **17 TDD fixes** across security, safety
invariants, API drift, and truthfulness — incl. a CRITICAL (async route
rejections hung the request AND crashed the server on any mid-turn DB error →
`asyncHandler` + terminal error middleware + process net) and two HIGHs
(`projects_from_template` sent `templateId` not the spec's required
`templateProjectId`+`name`; `/component/assistant` minted a NEW session every
load so session-restore was dead in prod — now reuses the cookie-bound session).
Plus: per-tool-call `thoughtSignature` now survives the confirm-resume
round-trip (Gemini 3.x no longer 400s); a total-failure undo reports failure not
a false "Undone"; holidays dates resolve server-side; the time-off preview shows
the deducted day count; `tasks_rate_update` previews the REAL task name
(`resolveEntityRef` gained `verifyId`); NUL bytes removed from `api.ts` (grep
treated the safety-critical file as binary); catalog is 137 actions. The resume
sweep added: confirmPending/rotatePendingNonce check ownership BEFORE status (no
cross-tenant lifecycle leak) and fail CLOSED on a NaN `expiresAt`; schedule
single-project totals use `GET /{projectId}`; the typed-consent guard catches
approval idioms ("ship it"/"make it so") without swallowing new-entity phrases;
an idempotent replay no longer mints a second undo handle; `/component/assistant`
requires an ACTIVE installation before minting a session; undo failures surface
the route's real reason. **DEFERRED (too risky solo):** concurrency-races-01
(idempotency check-then-act → atomic claim rewrite of the commit choke point) —
design rec in NOTES. Planner held 100% on the one schema-affecting change. Full
findings + remaining backlog in
`~/Downloads/ai-assistant-goated-audit-NOTES.md`.
`npm run verify` = **1116 tests**, `npx madge --circular
--extensions ts --ts-config tsconfig.json src` = **0** (keep both). All pushed
to `main`.

**DEPLOYED on Railway (2026-06-12) and installed + working in Clockify.**
Stable hosting is SOLVED — the quick tunnel is retired. Live at
`https://ai-assistant-production-c2e6.up.railway.app` (project
`ai-assistant-clockify`, service `ai-assistant`). The SDK
(`@apet97/clockify-addon-sdk`, on the request path) is vendored as an in-repo
tarball at `vendor/` (npm 2FA blocked publishing) so `npm ci` is self-contained;
prod build = `tsconfig.build.json` → `dist/server/server.js`, `npm start`; a 5GB
Railway **volume at `/data`** backs the SQLite DB (`DATABASE_PATH=/data/…`) so
installs survive redeploys. Full checklist: `DEPLOYMENT.md`. Remaining work is
**human-gated only**:
1. **Prod security review + token rotation** (the `.env.server` LLM creds were
   reused on Railway — rotate for real prod; review before real users).
2. **Prod AUDIT-host `X-Addon-Token` clearance** — now unblocked: run
   `scripts/host-auth-spike.ts` against the live Railway install with a captured
   prod `LIVE_ADDON_TOKEN` (dev cleanly reports "audit log not available").

Local dev still uses `scripts/dev-tunnel.sh` (quick tunnel + server on :3001);
prod no longer depends on it. **Never `dev-tunnel.sh restart`** for the local
flow (it rotates the URL); a colleague may share `:3001` via a second tunnel.

## Product contract

Admin-only embedded chat + an internal MCP-shaped action harness.
- Only Clockify admins/owners; rejected BEFORE a session is created.
- Per-admin, per-workspace assistant permissions; default full `read_write`;
  admins manage only their own (owners don't see others').
- Safe writes execute immediately with receipts. Risky writes require a
  dry-run preview + BUTTON confirmation; typed "yes" never executes.
- `Confirm all` applies only to the exact previewed batch. Confirmations are
  one-use, 5-min TTL, bound to session/workspace/admin + nonce + operation
  hash; policy is re-checked at confirm time.
- The model never receives tokens, session secrets, model API keys, or raw
  headers. Not a public Claude connector; not a standalone MCP server.

## Ground truth & verification discipline (READ THIS)

This codebase's Clockify-API assumptions have repeatedly been WRONG; every
such bug was found against the REAL API, not by reading the code.
1. **The OpenAPI spec is ground truth:** `https://docs.clockify.me/openapi.json`.
   Check the real request/response shape before believing a comment or Zod schema.
2. **Sibling references** (read-only, never modify): `../goclmcp`,
   `../clockify-ts-sdk`. When the addon disagrees with them, the addon is
   usually wrong — but verify: goclmcp itself had the invoice tax/discount bug.
3. **Verify live, don't assume:** opt-in scripts hit a sacrificial workspace
   (API key or the install's `X-Addon-Token`). For anything surprising, write a
   throwaway probe, then delete it.
4. **TDD against the verified shape:** failing test first, then the fix. Never
   fix a live-API bug without a test reproducing it.

## Engineering rules

- TypeScript, Express, vanilla Vite UI, SQLite, Zod, Vitest, Supertest. No
  React/Next/Prisma/queues/Redis/vector DBs/workers unless the user asks.
- Small files, one responsibility. Failing test first; `npm run verify` before
  claiming done; one focused commit per fix; madge stays at 0 cycles.
- The REST adapter is **I/O only** — all risk/policy/confirmation/resolution
  logic lives in `src/harness/*`. Secrets never enter a
  `ConfirmableOperation.payload` (persisted to DB + audit log).
- Never log/commit/paste tokens or raw auth headers; fake tokens in tests;
  live tests opt-in on a sacrificial workspace only.
- If a safety test fails, stop and fix it before features.

## Branch layout

- **`main`** (curated): `src/`, `tests/`, `scripts/`, this file, `AGENTS.md`,
  `README.md`, `NEXT_SESSION_PROMPT.md` (live-test kickoff) + `NEXT_SESSION_PLAN.md`
  (the executed trust-lives-in-the-code roadmap, archived), `docs/HISTORY.md`,
  `.claude/workflows/` (reusable Claude Code workflow scripts:
  `full-angle-audit.js` — the 7-phase audit→verify→fix orchestration — and
  `dogfood-and-fix.js` — agents drive `scripts/repro-chat.ts` and fix what they find).
- **`slopbranch`**: the design docs (`PRD/SPEC/ARCHITECTURE/DATA_MODEL/
  SAFETY_AND_PERMISSIONS/IMPLEMENTATION_PLAN*/TESTING_AND_ACCEPTANCE/
  API_COVERAGE_PLAN/REFERENCES`, `.claude/`). Read via `git show slopbranch:SPEC.md`.

## Architecture

- `src/config.ts` env (Zod) · `src/db/store.ts` single SQLite module + token
  encryption (AES-256-GCM) · `src/auth/` admin check + signed session cookie
  (`SameSite=None; Secure; Partitioned` — required in the cross-site iframe).
- `src/addon/` manifest + token verification. Inbound add-on JWTs are RS256
  with ONE platform-wide key, embedded default in
  `src/addon/clockify-public-key.ts` (env override optional). The manifest
  component is a **sidebar** entry + `iconPath` (no icon → doesn't render).
- `src/clockify/` — the seam: `client.ts` (`WorkspaceClient` port, composed
  from `ports/<area>.ts`; carries `authClass: "addon"|"api_key"`),
  `rest-workspace.ts` (adapter = multi-host `rest/core.ts` + one
  `rest/<area>.ts` per area; `X-Addon-Token` in prod), `types.ts` (leaf
  shapes), `api-base.ts` (hosts from the INSTALL token claims: api =
  `apiUrl`+`/v1`, reports = `reportsUrl`+`/v1`; audit host has NO claim →
  derived prod-only, clean "not available" error elsewhere).
- `src/harness/` — the safety boundary: `action.ts` (contracts +
  `defineRiskyAction`/`defineReadAction`; `ActionContext` carries injected
  capabilities `savePolicy`/`recentOutcomes`/`idempotency`), `actions.ts`
  (executor + `commitConfirmedOperation`, the single risky-commit choke
  point), `catalog.ts`, `permissions.ts`, `risk.ts`, `receipts.ts`,
  `confirmations.ts`, `tools.ts` (Zod→JSON-schema tools), `arg-summary.ts`,
  `compose.ts` (atomic multi-step + rollback), `idempotency.ts` (intent-hash
  dedupe, 10-min window), `undo.ts` (reverse creations), `money.ts` (the one
  major↔minor amount mapping), `workflows/<area>.ts` (+ `workflows/resolve.ts`
  — see invariants below). Shared day-span constants live in `src/durations.ts`.
- `src/assistant/` — model client (`LLM_PROVIDER=http` OpenAI-compatible
  DeepSeek default, or `gemini-cli`), `prompts.ts`, `planner.ts`,
  `agent-loop.ts` + `agent-state.ts` (the durable agentic loop).
- `src/routes/api.ts` — chat (JSON + NDJSON stream), confirm/cancel/undo/
  metrics; `executeChatTurn` is the single turn pipeline. `src/ui/` vanilla TS
  chat (a11y; previews batched so "Confirm all" stays one card).
- `src/metrics/metrics.ts` pure `buildMetrics` → `GET /api/metrics` and the
  `assistant_recent_outcomes` action. `src/eval/score.ts` pure planner scorer.

## Safety & planner invariants (all pinned by tests — do not regress)

- **Truthful previews:** when a turn leaves pending previews, the route
  REPLACES the model's reply with deterministic "review and click Confirm"
  text and stores THAT. The stored boilerplate is rewritten to a neutral note
  in the MODEL-VISIBLE history (`sanitizeStoredReplyForModel`) so the model
  can't learn to parrot it.
- **Typed consent guard:** a bare "yes"/"confirm"/"do it" while the session
  has live pending previews never reaches the planner — deterministic reply
  points at the button (`TYPED_CONSENT` + `store.countPendingConfirmations`).
- **Name→id resolution at PREVIEW time** (`workflows/resolve.ts`
  `resolveEntityRef`): ids are 24-hex; anything else resolves via exact-id
  fallback → `matchByName` → grounded did-you-mean clarify (`notFoundHint`
  appends caller copy like "Or should I create it first?"). Covers every
  entity action incl. invoices BY NUMBER, the generic update/delete_entity,
  `projects_create`/`projects_update` `clientId`+`clientName`, invoices_create
  (a non-hex `clientId` resolves as a name), expense categories
  (create/update/delete + `expenses_update.categoryName`). The OPTIONAL
  project/task slot PAIR (expenses create/update, fix_entry, start_timer,
  log_work, entries_list filters, scheduling project_totals) goes through ONE
  `resolveProjectTaskRefs` (a name in EITHER slot resolves; a task name needs
  its project or it clarifies; resolved NAMES feed the preview). A SINGLE
  member (role grant, per-project + workspace member rate, group remove, scheduling
  create) goes through `resolveUserRef` (id/name/'me' → verified user id, else
  clarify — ONE copy, not inlined per action). LISTS go through `resolveUserRefs`
  (task `assigneeIds`, group add, holiday/policy/balance `userIds`) and
  `resolveGroupRefs` (holiday/policy `userGroupIds`) — both on one private
  `resolveRefList` core (id/name/'me' per entry; ambiguous/unknown ⇒ clarify, so
  nothing ever commits half-assigned). `verifyIds` checks even a 24-hex value
  against the real list for permission/assignment-affecting writes.
  READ-FILTER `userId` slots (entries list, review day/week, scheduling
  assignments list + user totals, time-off requests list + balance get,
  holidays in_period `assignedTo`) go
  through `resolveUserFilter` (ONE copy; id/exact name/'me'; built on
  `resolveUserRef` `trustIds` so the 24-hex happy path stays list-free — a
  wrong id on a read is an empty list, not a damaging write; each action keeps
  its own absent-default: caller vs unfiltered). `users_deactivate` resolves +
  VERIFIES the member and the self-deactivation guard holds on the RESOLVED id
  ('me'/own-name can't slip past). Entry TAGS resolve via `resolveTagRefs`
  (start_timer/log_work/fix_entry `tagNames` or names in `tagIds`); time-off
  `requests_create` resolves `policyName`; `projects_from_template` resolves
  `templateName`. Scalar shapes are absorbed by `src/harness/arg-shapes.ts`
  (`zStringList`: a bare string for a list; `zNumberLike`: "75" for 75 — never
  ""→0; tool schemas STAY canonical, zodToJsonSchema unwraps preprocess) and
  invalid_args messages are field-path-prefixed (`formatZodIssues`) so the
  loop can self-correct. Destructive/archive/unarchive verbs pass
  `includeArchived` (the wire defaults to ACTIVE-ONLY — both states are
  fetched explicitly; archived options labeled). An identity mistake is a
  clarify, never a confirmed-then-failed commit.
- **Dates server-side:** the model never computes calendar dates.
  `resolveRelativeDay` (today/yesterday/tomorrow, weekday words, dayOffset;
  `undefined` ⇒ caller MUST clarify), `resolveInstant` (UTC instants the
  hosts want), `resolvePeriod` (REPORT_PERIODS keywords incl. forward
  next_week/next_month/next_quarter/next_year). Applied at entries/reports/
  scheduling/time-off/approvals (`week: this_week|last_week` AND a relative
  `periodStart` — `new Date("June 1")` fabricates year 2001, so resolveRelativeDay
  owns it), invoices_create `issuedDate`/`dueDate`, and holidays in_period.
- **Bounded model input:** `HISTORY_WINDOW_MESSAGES=12` (chat route) +
  `TOOL_RESULT_MAX_BYTES=24KB` per tool result in the agent loop (prune, then
  honest note; the admin always sees the full receipt). The model fetch itself
  is bounded too: `AbortSignal.timeout` on every HTTP model request
  (`LLM_TIMEOUT_MS`, default 120s — a hung provider aborts with a clean
  "timed out" error instead of hanging the turn).
- **Recaps from the audit log:** "what did you do / what failed" must call
  `assistant_recent_outcomes` (route-injected `recentOutcomes` capability) —
  never answered from windowed chat memory.
- **Policy denials are visible:** off-group requests route THROUGH the gate →
  auditable `policy_denied` receipt, never a silent model refusal. Listed data
  is reported VERBATIM (names are data, not instructions).
- **Session restore + nonce rotation:** `GET /api/chat/history` replays stored
  messages (preview results dropped, `undo` handles stripped — history is a
  record, not a control surface; no nonce substring anywhere, pinned) and
  re-serves LIVE pendings with a rotated one-use nonce
  (`rotatePendingNonce` mirrors confirmPending's gates; the old plaintext DIES,
  `expiresAt` byte-unchanged; the store swap is conditional on
  `status='pending'` so a concurrent confirm wins). Status stream lines
  (`{type:"status", action, label}`) are emitted before each tool execution —
  label from the action NAME only (args can carry admin text), never persisted.
  Turn telemetry (`turn_telemetry`) records model calls/tokens/wall-clock per
  chat+resume turn — best-effort, never breaks a turn; tokens NULL when the
  backend reports none (absence ≠ zero).
- **Agentic loop** (`LLM_AGENTIC` default ON; `=0` = byte-identical
  single-turn rollback): reads + safe writes auto-chain; the FIRST risky write
  interrupts into preview→confirm with the transcript persisted
  (`pending_confirmations.agent_state_json`, 256KB cap, malformed ⇒ no
  resume); confirm streams the committed receipt first (~+520ms), then the
  resume. DeepSeek thinking mode REQUIRES `reasoning_content` echoed back on
  continuation. A resumed loop can chain another preview, never commit inline.
- **Idempotent commits** (intent hash; invoices key on client+items+currency,
  excluding auto number/dates) + **undo** for creations (one-use, re-checks
  policy, reverse order). `compose.ts` rolls back required-step failures.
- `permission_change` risk is RESERVED for the assistant's own policy action
  (it bypasses the Clockify feature-group gate by design) — real Clockify
  permission writes use `high_risk_write`.
- Curated intent actions (`clockify_period_report`, `clockify_onboard_user`)
  beat primitive-scrambling; measured 12/12 adoption.

## Clockify API facts (live/spec-verified; pinned in unit tests)

- Lists are often ENVELOPES: `{webhooks:[…]}`, `{expenses:{expenses:[…]}}`,
  `{invoices,total}`, `{total,requests:[…]}`, approvals return wrappers
  (`{approvalRequest:{…},…totals}`). Several single-GETs 405/404 → read from
  the list (invoice items, custom fields, holidays, assignments, approvals,
  groups, time-off request by id → POST search).
- Amounts: minor units for invoices/payments on the wire; **major** for
  expenses. Invoice GET returns `discount/tax/tax2` (×100 ints) but PUT wants
  `discountPercent/taxPercent/tax2Percent` — mapping wrong silently ZEROES
  them. Payments POST returns the INVOICE doc (payment id is list-diffed).
  Invoice POST `/invoices` accepts ONLY CreateInvoiceRequest fields
  (clientId/currency/dueDate/issuedDate/number) — **`note`/`subject` sent on
  CREATE are SILENTLY DROPPED** (live-probed 2026-06-11: POST + GET both echo
  the workspace placeholder "INPUT BILL INFO HERE", never the supplied text).
  `createInvoice` POSTs the minimal body then applies note/subject via the
  verified GET-then-clean-PUT update path (same silent-drop class as the
  tax/discount zeroing — never trust a create-receipt for a field the spec omits).
- Invoice ITEM TYPES are per-workspace configured NAMES, no list/create API —
  discovered from existing invoices (`discoverItemTypes`); fresh workspace has
  none → $0 caveat surfaced in the PREVIEW. items POST requires
  description+quantity (defaulted visibly).
- PUTs replace (time-entry/expense/holiday/scheduling) → GET-then-PUT with the
  full body. Time-off approve/deny field is `status`; create needs
  `period.days` + bare `YYYY-MM-DD`. Role grant is **POST**
  `/users/{RECIPIENT}/roles` `{entityId, role, sourceType?}` (live-verified
  2026-06-12): the URL user is the RECIPIENT, `entityId` is the SCOPE —
  `workspaceId` for `WORKSPACE_ADMIN`, a `projectId` for `PROJECT_MANAGER` (no
  `sourceType`), a user-group id + `sourceType:USER_GROUP` for `TEAM_MANAGER` of a
  group. A user id in `entityId` 404s as "PROJECT not found". (Expense create takes
  a `userId` — any member, not just the admin.) Approvals submit/resubmit share
  `{period, periodStart}`
  (full ISO UTC instant). Scheduling delete takes `seriesUpdateOption`.
  Expense-category archive is `PATCH …/categories/{id}/status`; category list
  `archived` param DEFAULTS to false. Memberships PATCH REPLACES the set →
  "add me" merges via `getProjectMemberships` ("me" = `ctx.adminUserId`).
- **Rates are PUTs of integer `{amount}` minor units** (`.../hourly-rate` |
  `.../cost-rate`; GET on those paths 405s — discover the current value from a
  membership doc): the **per-project member** rate is
  `…/projects/{p}/users/{u}/{hourly-rate|cost-rate}` (member must be on the
  project or it 404s); the **Team-section workspace member** rate is
  `…/users/{u}/{hourly-rate|cost-rate}` (returns the workspace doc, live-verified
  2026-06-12); the **task** rate is `…/projects/{p}/tasks/{t}/…`. The
  **project DEFAULT** rate has NO standalone endpoint — set `hourlyRate`/`costRate`
  in the project create/update BODY. Previews always show MAJOR units.
- **Group/user SCOPING** (live-verified 2026-06-12): holidays AND time-off
  POLICIES accept `users` + `userGroups` as `{contains:"CONTAINS", ids, status}`
  filters on POST/PUT, and the GET echoes them back FLAT as `userIds`/
  `userGroupIds` arrays (not `userGroups.ids` — don't trust the nested shape).
  A policy/holiday with no scope is rejected → default to the admin's id.
  **Approvals** (per-user, by approval id) and **scheduling assignments**
  (`userId` only) have NO group target in the API — name resolution only.
- **Blocked for the add-on token class regardless of scopes** (probed live):
  webhooks (ALL), custom-field CREATE, account-level `GET /workspaces`
  (workspace-scoped GET works). Surfaced at PREVIEW as an honest platform
  restriction (keyed on `WorkspaceClient.authClass`); `core.call` maps the 401
  honestly at call time. Reports host accepts the add-on token.
- Clockify reserves a project name even after archive-then-delete → tests use
  unique `AIASSIST_SMOKE_*` / `AIASSIST_LOOP_*` names. `name` filters are
  contains+case-insensitive → exact `matchByName` client-side is correct.
- Deletes archive first (projects/clients/expense categories); tasks mark DONE
  first.

## Build, test, run

```bash
npm install
npm run type-check     # tsc --noEmit
npm test               # vitest run (fakes only; no network)
npm run build          # tsc + vite -> dist/server, dist/ui
npm run verify         # type-check + test + build (the gate)
npm run dev            # tsx src/server.ts (needs env)
npx madge --circular --extensions ts --ts-config tsconfig.json src   # keep 0
```

## Local dev hosting (tunnel)

`scripts/dev-tunnel.sh {up|status|sync|restart|down}` manages the Cloudflare
quick tunnel + server as one unit (writes `BASE_URL` into `.env.server`,
restarts the server). `up` is idempotent; **`sync` keeps the URL** (prefer it);
`restart` ROTATES the URL → you must re-register `<url>/manifest` in the dev
console (uninstall → Insert link → INSTALL; restore the expired console session
via `developer.marketplace.cake.com/test-accounts` → "Log in as" John Owner).
Browser path to the embedded chat: direct URL open renders BLANK — load
`/tracker`, click the "AI ASSISTANT" sidebar link (SPA nav), then
`agent-browser frame @e8` (cross-origin iframe). Backend oracle:
`data/ai-assistant.sqlite` (audit_events / pending_confirmations).

## Runtime constraints

- Node 20+; on THIS machine only Node 26 runs → `better-sqlite3` pinned `^12`.
- Auth: the add-on uses the installation token (`X-Addon-Token`), never an API
  key (`createWorkspaceClockifyClient` must never pass `apiKey`; pinned).
  API-key adapters are dev-script-only.
- `/lifecycle/installed` requires only `authToken`+`workspaceId`.
- Planner: `LLM_MODE=tool` default (JSON fallback; `gemini-cli` has no tools).

## Live testing (opt-in, sacrificial workspace only; gitignored `.env*`)

```bash
LIVE_CLOCKIFY=1 LIVE_CLOCKIFY_API_KEY=… LIVE_WORKSPACE_ID=… npx tsx scripts/live-full.ts   # every action, self-cleaning
LIVE_CLOCKIFY=1 npx tsx scripts/live-sweep.ts                                              # leftover sweep → must report 0
npx tsx --env-file=.env.server scripts/eval-planner.ts --repeat=3                          # planner meter (pass-rate + consistency)
npx tsx --env-file=.env.server scripts/eval-agentic.ts --repeat=3 [--single-turn]          # loop meter (90.5% vs 57.1%)
npx tsx --env-file=.env.server scripts/live-confirm-flow.ts                                # confirm safety over HTTP (PASS=16)
LIVE_CLOCKIFY=1 npx tsx --env-file=.env.server scripts/live-agentic-flow.ts                # loop vs real host (PASS=10)
npx tsx --env-file=.env.server scripts/live-chat-tour.ts                                   # broad dogfood tour
LIVE_CLOCKIFY=1 npx tsx scripts/addon-smoke.ts                                             # prod add-on-token path (needs LIVE_ADDON_TOKEN)
```

Dev workspace: "Marketplace Workspace" `69bda6b317a0c5babe34b4ff`, owner member
id `69bda6b317a0c5babe34b4fe` (use THAT for the user-token exchange, not the
install token's `user` claim). Always finish with the sweep at 0 leftovers.
