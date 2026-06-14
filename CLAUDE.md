# CLAUDE.md — AI Assistant Add-on

Read this first in every Claude Code session. History/journals: `docs/HISTORY.md`
(handoff archive); live-test state: `~/Downloads/ai-assistant-loop-checklist.md`
(322/322 closed) + `…-loop-failures.md` (root causes + resolutions).

## Current state (2026-06-14)

Admin-only embedded Clockify chat + an MCP-shaped action harness. Everything
buildable is DONE, live-verified, and DEPLOYED. The arc-by-arc history is in
`docs/HISTORY.md`; this is the current snapshot.

**Verified gate:** `npm run verify` = **1222 tests**; `npm run cycles` (= `madge
--circular …`, now a pinned devDep) = **0** (keep both green). 137 typed actions,
16 areas, 3 hosts. Planner eval **100%** on DeepSeek v4-pro AND both Gemini tiers
(gemini-3.1-flash-lite / 3.5-flash, low effort); agentic loop 7/7 ×3, 0 safety
violations. Gemini-ready: backend swap is env-only (`LLM_MODEL` +
`LLM_REASONING_EFFORT=low`); prod stays DeepSeek until decided.

**Deployed on Railway**, installed + working in Clockify (the dev quick-tunnel is
retired). Live at `https://ai-assistant-production-c2e6.up.railway.app` (project
`ai-assistant-clockify`, env `production`, service `ai-assistant`). Redeploy =
`railway up` from this dir (Nixpacks → `npm run build` → `npm start`, healthcheck
`/manifest`). The SDK (`@apet97/clockify-addon-sdk`, on the request path) is
vendored as an in-repo tarball at `vendor/` so `npm ci` is self-contained; a
Railway **volume at `/data`** backs the SQLite DB (`DATABASE_PATH=/data/…`) so
installs survive redeploys. Env vars + volume live in Railway — never commit
tokens. Full checklist: `DEPLOYMENT.md`.

**Latest — marketplace-submission hardening (2026-06-14):** six TDD items.
**Chat/audit retention** (REVERSES the prior "never pruned" stance): `chat_messages`
+ `audit_events` age out via the hourly sweep on `RETENTION_DAYS` (default 90, floor
30 so the 30-day metrics view never truncates; two `created_at` prune-indexes pinned
by `explainPrunePlan`). **Workspace erasure**: `store.eraseWorkspace` deletes every
workspace-scoped row in one atomic txn (FK-children before `chat_sessions`) +
tombstones the install (status='deleted', token → `encryptSecret("")`); `POST
/lifecycle/deleted` now ERASES (was mark-only), `scripts/erase-workspace.ts` does it
on request (`idempotency_keys` is global/PII-free → skipped). **`PRIVACY.md`** (public
data/retention/erasure doc). **CI**: `npm audit --omit=dev --audit-level=high` +
Dependabot; a **manual** `live-smoke.yml` (`workflow_dispatch` only) drives the real
read→safe-write→preview→confirm→commit→cleanup flow vs a sacrificial WS via `LIVE_*`
secrets + an `if:always()` sweep (proven green live). `main` requires the `verify` CI
check (no forced PR). Detail in git log.

**Recent arcs (detail in git log + `docs/HISTORY.md`):**
- **external-review remediation (2026-06-14, `7f3be68`…`36c940f`):** 7 fixes —
  `COMMIT_TIMEOUT_MS` into validated config (bounded `< CLAIM_TTL_MS`); request
  hardening (32kb body cap; message `.max(4000)`/nonce `.max(256)`; body-parser 4xx
  honored, not masked 500); `DATA_ENCRYPTION_KEY` `.min(32)` (derivation UNTOUCHED);
  `madge` pinned; GET-only bounded retry on transient 429/5xx (writes/timeouts NEVER
  retried). NO `.trim()` on the message schema is deliberate (whitespace → friendly
  new-6 handler, never the planner).
- **live-fix + dogfood (2026-06-14, `3c4f064`…`8e1c447`):** invoice tax end-to-end;
  `invoices_import_time`/`expenses_list` server-side dates; every `*_get` resolves by
  NAME; typed-consent catches batch words; `log_work` negative-length clarify.
- **goated-audit (2026-06-13):** 82 findings → 52 confirmed (3-skeptic) → 43 fixed, 1
  `wont_fix`. Closed a CRITICAL mid-turn-DB-error crash/hang, prod-dead session-restore,
  and the concurrent-confirm duplicate-invoice race (atomic-claim idempotency ledger:
  `store.claimIdempotency`, claim BEFORE commit await, `CLAIM_TTL_MS > COMMIT_TIMEOUT_MS`).
  `wont_fix` = `authz-surface-01` (see Human-gated). Tables:
  `~/Downloads/ai-assistant-goated-audit-NOTES.md`.

**Human-gated only** (unchanged by this work):
1. **Prod security review + token rotation** — the `.env.server` LLM creds were
   reused on Railway; rotate for real prod and review before real users.
2. **Prod AUDIT-host `X-Addon-Token` clearance** — run `scripts/host-auth-spike.ts`
   against the live install with a captured prod `LIVE_ADDON_TOKEN` (dev cleanly
   reports "audit log not available").
3. **`authz-surface-01`** — decide the session-TTL / per-request-role posture
   (the one audit `wont_fix`).

Local dev uses `scripts/dev-tunnel.sh` (quick tunnel + server on :3001); prod no
longer depends on it. **Never `dev-tunnel.sh restart`** for the local flow (it
rotates the URL); a colleague may share `:3001` via a second tunnel.

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
- `main` carries a **required `verify` CI status check** (branch protection, no
  forced PR — admins can still direct-push). CI = verify + cycles + `npm audit`.

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
  metrics + `POST /chat/new` (mints a fresh session/cookie → empty transcript;
  the prior session's messages are NOT deleted — kept under retention + the audit
  log, so its cookie still replays; pinned by `chat-new.test.ts`);
  `executeChatTurn` is the single turn pipeline. `src/ui/` vanilla TS chat (a11y;
  previews batched so "Confirm all" stays one card; a header **"New chat"** button).
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
npm run cycles         # madge --circular … (pinned devDep) — keep 0
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
