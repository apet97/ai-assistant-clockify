# CLAUDE.md — AI Assistant Add-on

The engineering source of truth for this repo. Read it before changing code.
Companion: `AGENTS.md` (short map), `README.md` (product overview), `DEPLOYMENT.md`,
`PRIVACY.md`.

## What this is

An **admin-only** AI assistant embedded inside Clockify: a chat where workspace
admins ask for Clockify work in plain language, backed by an internal,
MCP-shaped **action harness**. The model only ever *proposes* named actions from a
fixed catalog; a deterministic harness validates every proposal against per-admin
permissions and a risk policy and is the only thing that touches Clockify. The
model never executes anything itself and never sees a secret.

**State:** everything buildable is done, live-verified on a real Clockify
workspace, and deployed.

- **Gate:** `npm run verify` runs both TypeScript projects, the full test/build
  suite, a zero-warning typed **ESLint** gate, madge circular-dependency analysis,
  and the jscpd duplication gate. Keep every stage green.
- **Coverage:** 139 typed catalog actions, 16 areas, 3 Clockify hosts (incl. the
  single-approval composites `clockify_setup_project` (create + members + rates)
  and `clockify_setup_task` (create-in-project + assignees + task rate): each is
  one preview → one Confirm → atomic `runComposition`, mirroring `onboard_user`).
- **Model:** backend-agnostic OpenAI-compatible client (DeepSeek default; Gemini
  3.x supported). A backend swap is env-only (`LLM_MODEL` + `LLM_REASONING_EFFORT`).
  Planner + agentic evals last measured 100% on DeepSeek v4-pro and both Gemini
  tiers (opt-in `scripts/eval-*.ts`; results are not committed or CI-gated).
- **Weak-model consistency knobs** (for cheap tiers like Flash Lite 3.1, reached via
  an OpenAI-compatible HTTP endpoint so they get tool-mode): `LLM_TOOL_SELECT` (now
  **default ON**, `=0` rolls back) shows the model only the message-relevant actions
  (+ an always-on core) instead of all 139, on BOTH the chat turn and its confirm
  resume — deterministic, `src/harness/tool-select.ts`. The agentic eval flipped it
  (11 cases × 5, OFF vs ON): **DeepSeek** 100% pass / 0 safety both, ~61% fewer prompt
  tokens/turn (18.7K→7.1K per round-trip), latency down, no case regressed; **both Gemini
  tiers** (flash-latest + flash-lite-3.1 no-think) 100% / 0 safety both, ~65% fewer tokens
  (17.6K→6.1K/round-trip — same tokenizer) with latency down 18–50% (flash p95
  6604→3195ms; flash-lite p50 2560→1704ms). A recall escape hatch retries the full catalog
  when a narrowed CHAT turn does nothing (DeepSeek fired 9.1% of narrowed runs, BOTH Gemini
  tiers 0%; net still −61/−65%). The RESUME has no escape hatch, so a request spanning more areas than
  the 3-group clamp, any non-ASCII request, or a request with no lexical match
  fails open to the full catalog immediately. Unresolved admin-authored clarification
  context is persisted and reused for the terse follow-up and confirm resume, so the
  original domain is not lost. `LLM_SEED` adds a sampling seed for reproducibility.
  `unknown_action` errors carry a "did you mean"
  (`src/harness/action-suggest.ts`). Measure with `scripts/eval-matrix.ts` (per-model
  pass-rate + consistency + spread) and `scripts/eval-agentic.ts --tool-select`
  (per-turn prompt tokens + p50/p95 latency + escape-hatch fire-rate).
- **Deployed on Railway** (Nixpacks → `npm run build` → `npm start`, liveness
  `/live`, committed-write readiness `/health`). Redeploy = `railway up` from this dir. The SDK
  (`@apet97/clockify-addon-sdk`, on the request path) is vendored as an in-repo
  tarball at `vendor/` so `npm ci` is self-contained; a Railway **volume at
  `/data`** backs the SQLite DB (`DATABASE_PATH=/data/…`) so installs survive
  redeploys. Env vars + the volume live in Railway — never commit tokens. See
  `DEPLOYMENT.md`.

**Still human-gated** (operational, not code): rotate the prod LLM credentials,
record the provider DPA/region/retention/training posture, run a production-like
backup/restore drill and deterministic safety eval, and complete a security review
before real users; confirm the prod AUDIT-host
`X-Addon-Token` clearance (run `scripts/host-auth-spike.ts` with a captured prod
`LIVE_ADDON_TOKEN` — dev cleanly reports "audit log not available"). Every write,
confirmation, and undo performs an uncached role recheck and fails closed;
`ROLE_RECHECK=1` additionally enables cached checks for authenticated reads.

## Product contract

- Only Clockify admins/owners; rejected BEFORE a session is created.
- Per-admin, per-workspace assistant permissions; genuinely new admins default to
  full `read_write`, while missing groups in an existing policy migrate to `off`;
  admins manage only their own (owners don't see others').
- Safe writes execute immediately with receipts. Risky writes require a dry-run
  preview + BUTTON confirmation; typed "yes" never executes.
- `Confirm all` applies only to the exact previewed batch. Confirmations are
  one-use, 5-min TTL, bound to session/workspace/admin + nonce + operation hash;
  policy is re-checked at confirm time.
- The model never receives tokens, session secrets, model API keys, or raw
  headers. Not a public Claude connector; not a standalone MCP server.

## Ground truth & verification discipline (READ THIS)

This codebase's Clockify-API assumptions have repeatedly been WRONG; every such
bug was found against the REAL API, not by reading the code.

1. **The OpenAPI spec is ground truth:** `https://docs.clockify.me/openapi.json`.
   Check the real request/response shape before believing a comment or Zod schema.
2. **Sibling references** (read-only, never modify): `../goclmcp`,
   `../clockify-ts-sdk`. When the addon disagrees with them, the addon is usually
   wrong — but verify: goclmcp itself had the invoice tax/discount bug.
3. **Verify live, don't assume:** opt-in scripts hit a sacrificial workspace
   (API key or the install's `X-Addon-Token`). For anything surprising, write a
   throwaway probe, then delete it.
4. **TDD against the verified shape:** failing test first, then the fix. Never fix
   a live-API bug without a test reproducing it.

## Engineering rules

- TypeScript, Express, vanilla Vite UI, SQLite, Zod, Vitest, Supertest, ESLint
  (typed, async-safety rules). No React/Next/Prisma/queues/Redis/vector DBs/workers
  unless the user asks.
- Small files, one responsibility. Failing test first; `npm run verify` before
  claiming done; one focused commit per fix; madge stays at 0 cycles.
- The REST adapter is **I/O only** — all risk/policy/confirmation/resolution logic
  lives in `src/harness/*`. Secrets never enter a `ConfirmableOperation.payload`
  (persisted to DB + audit log).
- Never log/commit/paste tokens or raw auth headers; fake tokens in tests; live
  tests opt-in on a sacrificial workspace only.
- If a safety test fails, stop and fix it before features.

## Architecture

- `src/config.ts` env (Zod) · `src/db/store.ts` thin SQLite facade composing
  per-concern builders in `src/db/store/` (sessions, confirmations, idempotency
  ledger, undo, audit/metrics, telemetry, durable turn/operation journals,
  canonical action results, short-lived artifacts, installations, and bounded
  500-row retention batches (10k rows/pass with event-loop yields and continuation)
  + token encryption/one-release key rotation
  (AES-256-GCM) · `src/auth/` admin check + signed session cookie
  (`SameSite=None; Secure; Partitioned` — required in the cross-site iframe).
- `src/addon/` manifest + token verification. Inbound add-on JWTs are RS256 with
  ONE platform-wide key, embedded default in `src/addon/clockify-public-key.ts`
  (env override optional). The manifest component is a **sidebar** entry +
  `iconPath` (no icon → doesn't render).
- `src/clockify/` — the seam: `client.ts` (`WorkspaceClient` port, composed from
  `ports/<area>.ts`; carries `authClass: "addon"|"api_key"`), `rest-workspace.ts`
  (adapter = multi-host `rest/core.ts` + one `rest/<area>.ts` per area, list
  pagination via `core.paginateEnvelope`, the one bare-date↔ISO normalization in
  `rest/wire-dates.ts`; `X-Addon-Token` in prod), `types.ts` (leaf shapes;
  `ClockifyAuth` lives here), `api-base.ts` (hosts from
  the INSTALL token claims: api = `apiUrl`+`/v1`, reports = `reportsUrl`+`/v1`;
  audit host has NO claim → derived prod-only, clean "not available" error
  elsewhere).
- `src/clockify/request-governor.ts` — shared per-workspace FIFO governor: 10
  requests/sec, burst 10, concurrency 4, one mutation at a time, adaptive `429`
  cooldown, and 60 host calls per chat/resume turn.
- `src/harness/` — the safety boundary: `action.ts` (contracts +
  `defineRiskyAction`/`defineReadAction`; `ActionContext` carries injected
  capabilities `savePolicy`/`recentOutcomes`/`idempotency`), `actions.ts`
  (executor + `commitConfirmedOperation`, the single risky-commit choke point),
  `catalog.ts`, `permissions.ts`, `risk.ts`, `receipts.ts`, `confirmations.ts`,
  `tools.ts` (Zod→JSON-schema tools), `arg-summary.ts`, `compose.ts` (atomic
  multi-step + rollback), `idempotency.ts` (intent-hash dedupe, 10-min window),
  `undo.ts` (reverse creations), `money.ts` (the one major↔minor amount mapping,
  BOTH directions — `toMinor` for the wire, `fromMinor` for major-unit previews),
  `workflows/<area>.ts`. Name→id + date resolution is split across
  `workflows/resolve.ts` (entities), `workflows/resolve-dates.ts` (the calendar
  helpers + `resolveDateRange`), and `workflows/preview-patch.ts` (update-diff
  rendering) — all re-exported through `resolve.ts` so consumers' imports are
  unchanged (see invariants below); plus the shared `resolveScopeRefs`
  (user/group scoping), `clarifyResult` (`action.ts` — the one
  resolver-clarify→`ActionResult` unwrap), and `workflows/rate.ts` (the shared
  rate-preview builder for the project/task/member rate actions). Shared day-span
  constants AND the injectable-clock helpers (`nowDate`/`nowIso`) live in
  `src/durations.ts`.
- `src/assistant/` — model client (`LLM_PROVIDER=http` OpenAI-compatible DeepSeek
  default, or `gemini-cli`), `prompts.ts`, `planner.ts`, `agent-loop.ts` +
  `agent-state.ts` (the durable agentic loop, including bounded selection context
  and provider cancellation).
- `src/routes/api.ts` — chat (JSON + NDJSON stream), confirm/cancel/undo/metrics +
  `POST /chat/new` (mints a fresh session/cookie → empty transcript; the prior
  session's messages are NOT deleted — kept under retention + the audit log) + the
  chat-history switcher (`GET /chat/sessions` lists the admin's live, owned,
  non-empty sessions; `POST /chat/sessions/:id/open` re-cookies to an OWNED target
  — IDOR-guarded 404 + no cookie for a foreign admin/workspace, the target's
  unextended expiry). the 14 route handlers stay in `api.ts`; the turn/confirm/commit
  machinery (`executeChatTurn`, `runResume`, `commitConfirmation`,
  `createTurnMachinery`) lives in `chat-pipeline.ts` (`createChatPipeline(deps)`),
  pure result transforms + guards in `chat-results.ts`, shared constants in
  `chat-constants.ts`. Earlier sibling helpers: `history-sanitizer.ts`
  (model-visible-history rewrite + truthful-preview text), `request-schemas.ts`
  (Zod bodies), `consent-guard.ts` (typed-consent), `async-handler.ts` (session FIFO
  owns the full async handler promise and skips disconnected queued requests),
  `best-effort.ts` (the one never-break-a-turn bookkeeping wrapper), `ndjson.ts`
  (the one NDJSON-stream setup → `{write, signal}`, used by both streaming routes).
  `src/ui/` vanilla TS chat (a11y; previews batched so "Confirm all" stays one
  card; header **"New chat"** + **"Chats ▾"** history dropdown — titles via
  `textContent`, full keyboard nav) — split into the fetch/NDJSON client
  (`api-client.ts`), the composer/stream flows (`composer-flow.ts`), and rendering
  (`render.ts`/`shared.ts`); `main.ts` keeps `mount()` + a re-export barrel.
- `src/metrics/metrics.ts` pure `buildMetrics` → `GET /api/metrics` and the
  `assistant_recent_outcomes` action. `src/eval/score.ts` pure planner scorer.

## Safety & planner invariants (all pinned by tests — do not regress)

- **Durable request identity:** chat clients generate a UUID `requestId` and reuse
  it for transport retries. Same-id/same-intent replays the stored result;
  same-id/different-intent returns `409 operation_id_conflict`. Replay envelopes
  never store plaintext confirmation nonces: ordered result links hydrate the one
  canonical `action_results` row per executed action, while still-pending preview
  descriptors receive a freshly rotated nonce only when served.
- **Canonical result ownership:** full action outcomes live only in
  `action_results`; chat messages, turn runs, audits, confirmations, undo, operation
  journals, and the workspace+admin-scoped idempotency ledger hold ordered links
  and bounded summaries (65,536 bytes). Cancel, expiry, settlement, and restart
  recovery atomically scrub confirmation nonce hashes, agent state, and operation
  payloads. A restart during execution records one linked `outcome_unknown` result.
- **Write authority:** immediately before every write/confirmation/undo, refresh
  the caller's role. Non-admin invalidates that admin's sessions; uncertainty
  fails closed. Writes are journaled as prepared→executing→terminal, and transport
  failure/timeout/408/5xx/malformed success after dispatch remains
  `outcome_unknown` without automatic retry.
- **Closed nested arguments:** unknown fields are rejected at every object depth.
  A dynamic record is open only when its action declares that exact path in
  `argumentOpenPaths` (array records use `memberships[]` notation). Aliases and open
  paths are part of action fingerprints/catalog compatibility hashes, so a pending
  confirmation cannot silently outlive a validation-contract change.
- **Session FIFO covers settlement:** mutation routes hold their per-session FIFO
  lock until the route, journaling, and best-effort bookkeeping promise settles —
  never merely until the response closes. A queued request that disconnects is
  skipped, and its fulfilled tail cannot block later requests.

- **Truthful previews:** when a turn leaves pending previews, the route REPLACES
  the model's reply with deterministic "review and click Confirm" text and stores
  THAT. The stored boilerplate is rewritten to a neutral note in the
  MODEL-VISIBLE history (`sanitizeStoredReplyForModel`) so the model can't learn
  to parrot it.
- **Typed consent guard:** a bare "yes"/"confirm"/"do it" while the session has
  live pending previews never reaches the planner — deterministic reply points at
  the button (`TYPED_CONSENT` + `store.countPendingConfirmations`).
- **Editing existing data previews + confirms:** every `*_update` action — and
  `clockify_fix_entry` (edit an existing time entry: description/project/task/tags/
  billable) — is `high_risk_write`. An update overwrites live data (and has no
  undo, which only reverses creations), so it goes through preview→button-confirm
  like every other risky write; only `safe_write` reads/creates execute
  immediately.
- **Name→id resolution at PREVIEW time** (`workflows/resolve.ts`
  `resolveEntityRef`): ids are 24-hex; anything else resolves via exact-id
  fallback → `matchByName` → grounded did-you-mean clarify (`notFoundHint` appends
  caller copy like "Or should I create it first?"). Covers every entity action
  incl. invoices BY NUMBER, the generic update/delete_entity,
  `projects_create`/`projects_update` `clientId`+`clientName`, invoices_create +
  invoices_update (a non-hex `clientId` resolves as a name), expense categories (create/update/delete
  + `expenses_update.categoryName`). The OPTIONAL project/task slot PAIR (expenses
  create/update, fix_entry, start_timer, log_work, entries_list filters, scheduling
  project_totals) goes through ONE `resolveProjectTaskRefs` (a name in EITHER slot
  resolves; a task name needs its project or it clarifies; resolved NAMES feed the
  preview). A SINGLE member (role grant, per-project + workspace member rate, group
  remove, scheduling create) goes through `resolveUserRef` (id/name/'me' → verified
  user id, else clarify — ONE copy). LISTS go through `resolveUserRefs` (task
  `assigneeIds`, group add, holiday/policy/balance `userIds`) and `resolveGroupRefs`
  (holiday/policy `userGroupIds`) — both on one private `resolveRefList` core
  (id/name/'me' per entry; ambiguous/unknown ⇒ clarify, so nothing ever commits
  half-assigned). `verifyIds` checks even a 24-hex value against the real list for
  permission/assignment-affecting writes. READ-FILTER `userId` slots (entries list,
  review day/week, scheduling assignments list + user totals, time-off requests
  list + balance get, holidays in_period `assignedTo`) go through `resolveUserFilter`
  (ONE copy; id/exact name/'me'; built on `resolveUserRef` `trustIds` so the 24-hex
  happy path stays list-free — a wrong id on a read is an empty list, not a damaging
  write; each action keeps its own absent-default: caller vs unfiltered).
  `users_deactivate` resolves + VERIFIES the member and the self-deactivation guard
  holds on the RESOLVED id ('me'/own-name can't slip past). Entry TAGS resolve via
  `resolveTagRefs` (start_timer/log_work/fix_entry `tagNames` or names in `tagIds`);
  time-off `requests_create` resolves `policyName`; `projects_from_template`
  resolves `templateName`. Scalar shapes are absorbed by `src/harness/arg-shapes.ts`
  (`zStringList`: a bare string for a list; `zNumberLike`: "75" for 75 — never
  ""→0; tool schemas STAY canonical, zodToJsonSchema unwraps preprocess) and
  invalid_args messages are field-path-prefixed (`formatZodIssues`) so the loop can
  self-correct. Destructive/archive/unarchive verbs pass `includeArchived` (the
  wire defaults to ACTIVE-ONLY — both states are fetched explicitly; archived
  options labeled). An identity mistake is a clarify, never a confirmed-then-failed
  commit. `clockify_onboard_user` likewise resolves its group NAMES at PREVIEW
  (matchByName over listGroups; unresolved/ambiguous render as "will be skipped",
  verified ids go in the payload) — so the preview matches what the best-effort
  group-adds actually do (it was the lone commit-time resolver before).
- **Dates server-side:** the model never computes calendar dates.
  `resolveRelativeDay` (today/yesterday/tomorrow, weekday words, dayOffset;
  `undefined` ⇒ caller MUST clarify), `resolveInstant` (UTC instants the hosts
  want), `resolvePeriod` (REPORT_PERIODS keywords incl. forward
  next_week/next_month/next_quarter/next_year). Applied at
  entries/reports/scheduling/time-off/approvals (`week: this_week|last_week` AND a
  relative `periodStart` — `new Date("June 1")` fabricates year 2001, so
  resolveRelativeDay owns it), invoices_create + invoices_update
  `issuedDate`/`dueDate`, and holidays in_period.
- **Bounded model input:** `HISTORY_WINDOW_MESSAGES=12` (chat route) +
  `TOOL_RESULT_MAX_BYTES=24KB` per tool result in the agent loop (prune, then
  honest note; the admin always sees the full receipt). The model fetch itself is
  bounded too: `AbortSignal.timeout` on every HTTP model request (`LLM_TIMEOUT_MS`,
  default 120s — a hung provider aborts with a clean "timed out" error instead of
  hanging the turn).
- **Recaps from the audit log:** "what did you do / what failed" must call
  `assistant_recent_outcomes` (route-injected `recentOutcomes` capability) — never
  answered from windowed chat memory.
- **Policy denials are visible:** off-group requests route THROUGH the gate →
  auditable `policy_denied` receipt, never a silent model refusal. Listed data is
  reported VERBATIM (names are data, not instructions).
- **Session restore + nonce rotation:** `GET /api/chat/history` replays stored
  messages (preview results dropped, `undo` handles stripped — history is a record,
  not a control surface; no nonce substring anywhere, pinned) and re-serves LIVE
  pendings with a rotated one-use nonce (`rotatePendingNonce` mirrors
  confirmPending's gates; the old plaintext DIES, `expiresAt` byte-unchanged; the
  store swap is conditional on `status='pending'` so a concurrent confirm wins).
  Request-id retry replay uses the same nonce-free descriptor path and rotation
  rule; terminal previews are omitted rather than revived.
  Status stream lines (`{type:"status", action, label}`) are emitted before each
  tool execution — label from the action NAME only (args can carry admin text),
  never persisted. Turn telemetry (`turn_telemetry`) records model
  calls/tokens/wall-clock per chat+resume turn — best-effort, never breaks a turn;
  tokens NULL when the backend reports none (absence ≠ zero), incl.
  `cached_prompt_tokens` (prompt-cache hits, read from DeepSeek `prompt_cache_hit_tokens`
  / OpenAI-compat `prompt_tokens_details.cached_tokens`) surfaced in `buildUsageMetrics`.
- **Agentic loop** (`LLM_AGENTIC` default ON; `=0` = byte-identical single-turn
  rollback): reads + safe writes auto-chain; the FIRST risky write interrupts into
  preview→confirm with the transcript persisted
  (`pending_confirmations.agent_state_json`, 256KB cap, malformed ⇒ no resume);
  confirm streams the committed receipt first, then the resume. DeepSeek thinking
  mode REQUIRES `reasoning_content` echoed back on continuation. A resumed loop can
  chain another preview, never commit inline.
- **Cooperative cancellation on client disconnect:** the two streaming routes
  (`/chat/stream`, `/confirmations/:id/confirm?stream=1`) thread an `AbortSignal`
  (fired by `res.on("close")`) through agentic and single-turn planners into every
  model call. HTTP abort cancels the active fetch/backoff without a provider retry;
  Gemini sends one kill and waits for the child to close. Both planner paths check
  cancellation before every not-yet-dispatched tool call. The signal is never
  passed into a Clockify mutation after dispatch starts, so cancellation cannot
  interrupt or retry an external write with an unknown outcome.
- **Idempotent commits** (intent hash; invoices key on client+items+currency,
  excluding auto number/dates) + **undo** for creations (one-use, re-checks policy,
  reverse order). A created TASK ref carries its `projectId` on the `EntityRef`
  (a task delete is project-scoped), so `reverseCreation` can delete it; a task
  ref missing its `projectId` can't be reversed and returns an honest
  `undo_failed`, never a silent success (the fake mirrors this — it no longer
  "deletes" a task without a projectId). `compose.ts` rolls back required-step
  failures. The atomic-claim
  ledger is the cross-row serialization point: the claim is taken BEFORE the commit
  await, so two concurrent confirms reach the host at most once. A long multi-call
  commit **heartbeats** its claim (`touchIdempotencyClaim` on `CLAIM_HEARTBEAT_MS`)
  so a still-live commit is never swept mid-flight. A claim orphaned by a process
  crash between the host write and `fill` is NOT silently re-won within the dedup
  window — `claimIdempotency` returns `stale_unknown` → the confirm surfaces
  "verify in Clockify before retrying" (`commit_outcome_unknown`), never a silent
  duplicate (CLAIM_TTL is the live-vs-crashed discriminator; past the window a
  deliberate re-issue commits). Not fully airtight without Clockify
  create-idempotency, but it converts a silent duplicate into an honest prompt.
- `permission_change` risk is RESERVED for the assistant's own policy action (it
  bypasses the Clockify feature-group gate by design) — real Clockify permission
  writes use `high_risk_write`.
- Curated intent actions (`clockify_period_report`, `clockify_onboard_user`) beat
  primitive-scrambling; measured 12/12 adoption.

## Clockify API facts (live/spec-verified; pinned in unit tests)

- Lists are often ENVELOPES: `{webhooks:[…]}`, `{expenses:{expenses:[…]}}`,
  `{invoices,total}`, `{total,requests:[…]}`, approvals return wrappers
  (`{approvalRequest:{…},…totals}`). Several single-GETs 405/404 → read from the
  list (invoice items, custom fields, holidays, assignments, approvals, groups,
  time-off request by id → POST search).
- Amounts: minor units for invoices/payments on the wire; **major** for expense
  CREATE input, but the expense GET `total` is MINOR (live-probed: $100 → 10000, so
  the `/100` read is correct). Invoice GET returns `discount/tax/tax2` (×100 ints)
  but PUT wants `discountPercent/taxPercent/tax2Percent` — mapping wrong silently
  ZEROES them. Payments POST returns the INVOICE doc (payment id is list-diffed).
  Invoice POST `/invoices` accepts ONLY CreateInvoiceRequest fields
  (clientId/currency/dueDate/issuedDate/number) — **`note`/`subject` sent on CREATE
  are SILENTLY DROPPED** (POST + GET both echo the workspace placeholder).
  `createInvoice` POSTs the minimal body then applies note/subject via the verified
  GET-then-clean-PUT update path (same silent-drop class as the tax/discount
  zeroing — never trust a create-receipt for a field the spec omits).
- Invoice ITEM TYPES are per-workspace configured NAMES, no list/create API —
  discovered from existing invoices (`discoverItemTypes`); a fresh workspace has
  none → $0 caveat surfaced in the PREVIEW. items POST requires
  description+quantity (defaulted visibly).
- PUTs replace (time-entry/expense/holiday/scheduling) → GET-then-PUT with the full
  body. Time-off approve/deny field is `status`; request create is policy-unit
  specific (live-verified): a DAYS policy needs `period.days` + bare `YYYY-MM-DD`;
  an HOURS policy needs full ISO datetime `period.{start,end}` with **NO `days`/
  half-day scaffold** (the DAYS body 400s "datetime must be yyyy-MM-ddThh:mm:ssZ").
  `clockify_time_off_requests_create` reads the resolved policy `timeUnit` at PREVIEW
  (best-effort) and branches — HOURS takes a server-resolved day + `hours` and builds
  09:00→09:00+N instants; a non-DAYS/non-HOURS unit clarifies. Role grant is **POST**
  `/users/{RECIPIENT}/roles`
  `{entityId, role, sourceType?}`: the URL user is the RECIPIENT, `entityId` is the
  SCOPE — `workspaceId` for `WORKSPACE_ADMIN`, a `projectId` for `PROJECT_MANAGER`
  (no `sourceType`), a user-group id + `sourceType:USER_GROUP` for `TEAM_MANAGER` of
  a group. A user id in `entityId` 404s as "PROJECT not found". (Expense create
  takes a `userId` — any member, not just the admin.) Approvals submit/resubmit
  share `{period, periodStart}` (full ISO UTC instant). Scheduling delete takes
  `seriesUpdateOption`. Expense-category archive is `PATCH …/categories/{id}/status`;
  category list `archived` param DEFAULTS to false. Memberships PATCH REPLACES the
  set → "add me" merges via `getProjectMemberships` ("me" = `ctx.adminUserId`).
  **Client CREATE silently drops `ccEmails`/`currencyId`** (live-probed: only
  name+email stick) — `createClient` POSTs the minimal body then applies them via
  GET-then-PUT (same silent-drop class as invoice note/subject); UPDATE sticks via
  getThenPut. `currencyId` is resolved from a CODE (e.g. "EUR") via the workspace
  `currencies[]` (on `GET /workspaces/{id}`, workspace-scoped GET allowed). Scheduling
  `publish` is range-scoped (all drafts overlapping); an optional `userFilter`
  (`{contains,ids}`) narrows it to one user (live-verified accepted).
- **Rates are PUTs of integer `{amount}` minor units** (`.../hourly-rate` |
  `.../cost-rate`; GET on those paths 405s — discover the current value from a
  membership doc): the **per-project member** rate is
  `…/projects/{p}/users/{u}/{hourly-rate|cost-rate}` (member must be on the project
  or it 404s); the **Team-section workspace member** rate is
  `…/users/{u}/{hourly-rate|cost-rate}` (returns the workspace doc); the **task**
  rate is `…/projects/{p}/tasks/{t}/…`. The **project DEFAULT** rate has NO
  standalone endpoint — set `hourlyRate`/`costRate` in the project create/update
  BODY. Previews always show MAJOR units.
- **Group/user SCOPING:** holidays AND time-off POLICIES accept `users` +
  `userGroups` as `{contains:"CONTAINS", ids, status}` filters on POST/PUT, and the
  GET echoes them back FLAT as `userIds`/`userGroupIds` arrays (not
  `userGroups.ids` — don't trust the nested shape). A policy/holiday with no scope
  is rejected → default to the admin's id. **Approvals** (per-user, by approval id)
  and **scheduling assignments** (`userId` only) have NO group target in the API —
  name resolution only.
- **Blocked for the add-on token class regardless of scopes** (probed live):
  webhooks (ALL), custom-field CREATE, account-level `GET /workspaces`
  (workspace-scoped GET works). Surfaced at PREVIEW as an honest platform
  restriction (keyed on `WorkspaceClient.authClass`); `core.call` maps the 401
  honestly at call time. Reports host accepts the add-on token.
- Clockify reserves a project name even after archive-then-delete → tests use
  unique `AIASSIST_SMOKE_*` / `AIASSIST_LOOP_*` names. `name` filters are
  contains+case-insensitive → exact `matchByName` client-side is correct.
- Deletes archive first (projects/clients/expense categories); tasks mark DONE
  first. A task delete is **project-scoped**: the generic
  `deleteEntity({entityType:"task", id, projectId})` routes to the typed
  `deleteTask` (mark DONE → DELETE under the project) and REQUIRES the projectId —
  it throws without one rather than guess (so a created-task undo must carry it).

## Build, test, run

```bash
npm install
npm run type-check     # tsc --noEmit
npm test               # vitest run (fakes only; no network)
npm run build          # tsc + vite -> dist/server, dist/ui
npm run lint           # eslint src, including browser UI; zero warnings
npm run verify         # both type-checks + lint + cycles + dup + test + build
npm run dev            # tsx src/server.ts (needs env)
npm run cycles         # madge --circular … (pinned devDep) — keep 0
```

CI runs `npm run verify` + the cycles check + `npm audit` on every push/PR; `main`
carries a required `verify` status check (branch protection, no forced PR — admins
can still direct-push). A manual `live-smoke.yml` (`workflow_dispatch` only) drives
the real read→safe-write→preview→confirm→commit→cleanup flow against a sacrificial
workspace via `LIVE_*` secrets.

## Runtime constraints

- Node 22.x (matches `package.json` `engines` + the Railway runtime).
  `better-sqlite3` pinned `^12` (the dev machine runs Node 26).
- Auth: the add-on uses the installation token (`X-Addon-Token`), never an API key
  (`createWorkspaceClockifyClient` must never pass `apiKey`; pinned). API-key
  adapters are dev-script-only.
- `/lifecycle/installed` requires only `authToken`+`workspaceId`.
- Planner: `LLM_MODE=tool` default (JSON fallback; `gemini-cli` has no tools).

## Local dev hosting (tunnel)

`scripts/dev-tunnel.sh {up|status|sync|restart|down}` manages a Cloudflare quick
tunnel + the local server as one unit (writes `BASE_URL`, restarts the server).
`up` is idempotent; **prefer `sync`** (keeps the URL) — `restart` ROTATES the URL,
which means you must re-register `<url>/manifest` in the Clockify dev console
(uninstall → Insert link → INSTALL). Prod runs on Railway and does NOT depend on
the tunnel.

## Live testing (opt-in, sacrificial workspace only; gitignored `.env*`)

Tests run entirely against fakes by default — no network, no credentials. Live
checks are opt-in, gated by env (`LIVE_CLOCKIFY=1` + the relevant tokens/IDs), and
**must target a throwaway workspace**.

```bash
LIVE_CLOCKIFY=1 LIVE_CLOCKIFY_API_KEY=… LIVE_WORKSPACE_ID=… npx tsx scripts/live-full.ts   # every action, self-cleaning
LIVE_CLOCKIFY=1 npx tsx scripts/live-sweep.ts                                              # leftover sweep → must report 0
npx tsx --env-file=.env.server scripts/eval-planner.ts --repeat=3                          # planner meter (pass-rate + consistency + spread)
npx tsx --env-file=.env.server scripts/eval-agentic.ts --repeat=3 [--single-turn]          # agentic loop meter
npx tsx scripts/eval-matrix.ts --repeat=5                                                  # weak-model MATRIX: planner+agentic × N models (eval-models.json, gitignored)
npx tsx --env-file=.env.server scripts/live-confirm-flow.ts                                # confirm safety over HTTP
LIVE_CLOCKIFY=1 npx tsx --env-file=.env.server scripts/live-agentic-flow.ts                # loop vs real host
npx tsx --env-file=.env.server scripts/live-chat-tour.ts                                   # broad dogfood tour
LIVE_CLOCKIFY=1 npx tsx scripts/addon-smoke.ts                                             # prod add-on-token path (needs LIVE_ADDON_TOKEN)
```

Always finish a live run with the sweep at 0 leftovers. Never commit or paste live
credentials.
