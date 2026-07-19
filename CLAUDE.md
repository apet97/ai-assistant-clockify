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

**State:** version 1.0.0 is the pre-Marketplace release candidate. Engineering
completion is established only by the exact-commit evidence set described in
`MARKETPLACE_READINESS.md`; checked-in templates or an older deployment are not
release evidence.

- **Gate:** `npm run verify` runs both TypeScript projects, the full test/build
  suite, a zero-warning typed **ESLint** gate, madge circular-dependency analysis,
  and the jscpd duplication gate. Keep every stage green.
- **Release checks:** `npm run audit:prod` applies the fail-closed production
  advisory policy; `npm run license:prod` applies the production-license policy
  and rewrites deterministic JSON evidence; `npm run eval:smoke` runs the
  offline scripted-model safety corpus without credentials.
- **Coverage:** 139 typed catalog actions, 16 areas, 3 Clockify hosts (incl. the
  single-approval composites `clockify_setup_project` (create + members + rates)
  and `clockify_setup_task` (create-in-project + assignees + task rate): each is
  one preview → one Confirm → atomic `runComposition`, mirroring `onboard_user`).
- **Model:** the production release keeps DeepSeek V4 Pro through the existing
  OpenAI-compatible HTTP client, native tool mode, `LLM_AGENTIC=1`, and
  `LLM_TOOL_SELECT=1`. The selected 1.0.0 setting is production-default reasoning,
  represented by an unset `LLM_THINKING_MODE`: the supported lower-effort mode
  failed the same invoice case in two independent exact-source diagnostic cohorts.
  The release gate still derives the setting from fresh final-source corpora and
  fail-closes on any write-safety regression. The client remains backend-configurable
  for development, but provider migration is not part of this release.
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

After all engineering evidence is green, exactly three human/admin packages may
remain: (1) DeepSeek credential rotation + provider governance, (2) monitored
contacts/private vulnerability reporting + independent human security/recovery
sign-off, and (3) Marketplace portal review/upload + **Submit for Review**. The
backup/restore drill, release-model evaluation, private deployment, live browser
flow and cleanup, performance gates, production scope/AUDIT probes, and green PR
checks are engineering work and may not be deferred into a fourth package.
Every authenticated surface performs a mandatory fail-closed role recheck; only a
positive read verdict may be cached, for at most 60 seconds. Every write,
confirmation, undo, and external dispatch is uncached.

## Product contract

- Only Clockify admins/owners; rejected BEFORE a session is created.
- Per-admin, per-workspace assistant permissions; genuinely new admins default to
  full `read_write`, while missing groups in an existing policy migrate to `off`;
  admins manage only their own (owners don't see others').
- Reads return immediately. Only actions explicitly classified `safe_write`
  execute immediately with receipts. Risky writes require a dry-run preview +
  BUTTON confirmation; typed "yes" never executes.
- `Confirm all` applies only to the exact previewed batch. Confirmations are
  one-use, 5-min TTL, bound to session/workspace/admin + nonce + operation hash +
  immutable capability id/hash; policy, capability, catalog, and action
  compatibility are re-checked at confirm time.
- Before the main planner receives Clockify results, an isolated declaration pass
  receives only current and unresolved prior admin-authored text as untrusted
  natural-language input; its trusted envelope also supplies exact write-action
  names and the catalog hash. It persists the exact write authority for that
  request. Invalid declarations deny writes but do not remove read access.
- Declaration literals may be bounded structured JSON, using the one shared
  depth/node/byte/array limit contract in `src/harness/safety-limits.ts`. The same
  contract governs declaration decoding, persistence, raw authority matching,
  action schemas, and catalog metadata; it does not change the capability version.
- Every advertised batch limit is derived from the deterministic worst-case host
  call estimator. Group-member additions are capped at 14. A prepared external
  mutation binds and hashes `maxHostCalls`, reserves its complete remaining cost
  before the first dispatch, and cannot partially execute because the 60-call turn
  budget was exhausted halfway through.
- The model never receives tokens, session secrets, model API keys, or raw
  headers. Not a public Claude connector; not a standalone MCP server.
- Installation tokens are generation-bound. Activation or token replacement
  increments the generation; inactive/deleted installations reject new and queued
  writes. Uninstall writes a tokenless deletion tombstone immediately, drains only
  already-dispatched work through truthful settlement, erases workspace data, and
  is completed at startup if interrupted. Exact same-token callback retries
  are idempotent even when the installation is inactive; only STATUS ACTIVE reactivates
  that token. Before replacement/uninstall, the outgoing token is added to a
  separate-domain, workspace-unlinked fingerprint denylist so a delayed signed
  callback cannot restore retired authority after erasure or restart. A bounded
  separate-domain hashed-workspace lineage also blocks never-before-seen older tokens
  after row erasure/restart and is pruned after 24 hours + 2 minutes + 1 second. Signed lifecycle
  JWT `iat` is persisted per generation; older INSTALLED/STATUS_CHANGED/DELETED events
  are ignored even when delivered later. All accepted add-on JWTs require `exp`, and
  lifecycle JWTs require a bounded `iat`. Equal whole-second issuer times fail closed as
  `DELETED > INACTIVE > ACTIVE`; different-token INSTALLED authority must be strictly newer.

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
  lives in `src/harness/*`. Secrets never enter a `ConfirmableOperation.payload`.
  Its nonsecret payload is persisted transiently in confirmation/operation rows
  and scrubbed at terminal states; audit rows store a canonical result reference
  plus a bounded summary, never a payload copy.
- Never log/commit/paste tokens or raw auth headers; fake tokens in tests; live
  tests opt-in on a sacrificial workspace only.
- If a safety test fails, stop and fix it before features.

## Architecture

- `src/config.ts` env (Zod) · `src/db/store.ts` thin SQLite facade composing
  per-concern builders in `src/db/store/` (sessions, confirmations, idempotency
  ledger, undo, audit/metrics, telemetry, durable turn/operation + ordered
  external-mutation-step journals, immutable intent capabilities + operation
  bindings + atomic usage claims in `intent-capabilities.ts`,
  canonical action results, short-lived artifacts, installations, and bounded
  one-statement/one-transaction 500-row retention batches (10k state
  transitions/pass with an event-loop yield after every statement, persisted
  deleted/expired/backlog/duration + passive-WAL evidence, and continuation)
  + token encryption/one-release key rotation
  (AES-256-GCM) · `src/auth/` admin check + signed session cookie
  (`SameSite=None; Secure; Partitioned` — required in the cross-site iframe).
- `src/addon/` manifest + token verification. Inbound add-on JWTs are RS256 with
  ONE platform-wide key, embedded default in `src/addon/clockify-public-key.ts`
  (env override optional). The manifest component is a **sidebar** entry +
  `iconPath` (no icon → doesn't render).
- `src/clockify/` — the seam: `client.ts` (`WorkspaceClient` port, composed from
  `ports/<area>.ts`; carries `authClass: "addon"|"api_key"`), `rest-workspace.ts`
  (adapter = multi-host `rest/core.ts` + one `rest/<area>.ts` per area; every
  public list/search returns exact `ListResult<T> {rows,truncated}`; plain and
  envelope pagination preserve completeness through `core.paginate*`, while
  POST/search pagination uses `rest/list-pages.ts`; `core.mutate` performs
  exactly one external mutation per durable workflow step; the one bare-date↔ISO
  normalization lives in `rest/wire-dates.ts`; `X-Addon-Token` in prod),
  `types.ts` (leaf shapes;
  `ClockifyAuth` lives here), `api-base.ts` (hosts from
  the INSTALL token claims: api = `apiUrl`+`/v1`, reports = `reportsUrl`+`/v1`;
  audit host has NO claim → derived prod-only, clean "not available" error
  elsewhere).
- `src/clockify/request-governor.ts` — shared per-workspace FIFO governor: 10
  requests/sec, burst 10, concurrency 4, one mutation at a time, adaptive `429`
  cooldown, and 60 host calls per chat/resume turn. Its write path accepts an
  abort signal and an `onDispatch` boundary: queued cancellation is definitive,
  while cancellation after the external fetch starts waits for truthful
  settlement. `workspace-mutation-coordinator.ts` provides the generation-aware
  workspace settlement barrier used by lifecycle and mutation routes.
- `src/harness/` — the safety boundary: `action.ts` (contracts +
  `defineRiskyAction`/`defineReadAction`; `ActionContext` carries injected
  capabilities `savePolicy`/`recentOutcomes`/`idempotency`), `actions.ts`
  (executor + `commitConfirmedOperation`, the single risky-commit choke point),
  `catalog.ts`, `permissions.ts`, `risk.ts`, `receipts.ts` (`listReceipt` always
  emits `truncated` and adds `list_truncated` for incomplete results), `confirmations.ts`,
  `tools.ts` (Zod→JSON-schema tools), `arg-summary.ts`, `intent-capability.ts`
  (immutable `IntentCapabilityV1`), `intent-authority.ts` (pre-Zod raw-argument
  matcher), `write-authority.ts` (explicit authority and exact-plan metadata for
  all 81 external writes), `mutation-workflow.ts`
  (durable one-dispatch steps + partial/unknown classification),
  `durable-risky-write.ts` (confirmed one-dispatch adapter), the focused
  `invoice-create-workflow.ts`/`invoice-update-workflow.ts`/
  `invoice-payment-workflow.ts` reconciliation modules,
  `target-snapshots.ts` (authoritative pre-dispatch drift checks),
  `mutation-compatibility.ts` (no-exception durable catalog gate),
  `startup-reconciliation.ts` + `startup-reconciliation-registry.ts` and focused
  workflow registries (read-only executable reconciliation for crash-orphaned
  dispatched steps; never resumes prepared work or compensates),
  `compose.ts` (legacy atomic multi-step + rollback), `idempotency.ts`
  (workspace/admin/action-scoped semantic confirmed-commit dedupe for
  `clockify_setup_project` and `clockify_setup_task`, with a 10-min window and
  canonical partial replay; invoice replay and duplicate suppression instead use
  the persisted durable operation ID, exact step journal, and reconciliation
  evidence — never a semantic payload hash or second payload-level id),
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
  default, or `gemini-cli`), `prompts.ts`, `planner.ts`,
  `intent-declaration.ts` (the isolated admin-text + trusted catalog-metadata
  declaration pass),
  `agent-loop.ts` + `agent-state.ts` (the durable agentic loop, including bounded
  selection context, persisted capability bindings, and provider cancellation).
- `src/routes/api.ts` — chat (JSON + NDJSON stream), confirm/cancel/undo/metrics +
  `POST /chat/new` (mints a fresh session/cookie → empty transcript; the prior
  session's messages are NOT deleted — kept under retention + the audit log) + the
  chat-history switcher (`GET /chat/sessions` lists the admin's live, owned,
  non-empty sessions; `POST /chat/sessions/:id/open` re-cookies to an OWNED target
  — IDOR-guarded 404 + no cookie for a foreign admin/workspace, the target's
  unextended expiry). The 17 route handlers stay in `api.ts`; the turn/confirm/commit
  machinery (`executeChatTurn`, `runResume`, `commitConfirmation`,
  `createTurnMachinery`) lives in `chat-pipeline.ts` (`createChatPipeline(deps)`),
  pure result transforms + guards in `chat-results.ts`, shared constants in
  `chat-constants.ts`. Earlier sibling helpers: `history-sanitizer.ts`
  (model-visible-history rewrite + truthful-preview text), `request-schemas.ts`
  (Zod bodies), `consent-guard.ts` (typed-consent), `async-handler.ts` (session FIFO
  owns the full async handler promise and skips disconnected queued requests),
  `best-effort.ts` (the one never-break-a-turn bookkeeping wrapper), `ndjson.ts`
  (the one NDJSON-stream setup → `{write, signal}`, used by both streaming routes).
  Scoped `GET /api/operation-runs/:operationId` returns only sanitized bounded
  operation/step status; chat-history responses restore passive operation cards
  from that same workspace+admin+session-scoped view. History hydration batches
  operation runs and steps instead of issuing an N+1 query. `route-authority.ts`
  owns the authenticated API role gate; `api.ts` does not carry bespoke authority
  branches.
  `src/ui/` vanilla TS chat (a11y; previews batched so "Confirm all" stays one
  card; header **"New chat"** + **"Chats ▾"** history dropdown — titles via
  `textContent`, full keyboard nav) — split into the fetch/NDJSON client
  (`api-client.ts`), runtime-decoded HTTP/NDJSON contracts (`protocol.ts`), the
  composer/stream flows (`composer-flow.ts`), product copy/preferences
  (`product.ts`), and rendering (`render.ts`/`shared.ts`); `main.ts` keeps
  `mount()` + a re-export barrel. The shell renders before parallel initialization,
  emits local understanding feedback before provider work, localizes through
  `Intl`, and remains usable without horizontal overflow at 280px.
- `src/metrics/metrics.ts` pure `buildMetrics` → `GET /api/metrics` and the
  `assistant_recent_outcomes` action. `src/eval/score.ts` pure planner scorer.
- `src/public-documents.ts` renders script-free public Privacy, Support, and
  Security pages. `src/release-artifact.ts` verifies the post-build manifest and
  complete generated `dist/server` + `dist/ui` hash before production opens its
  database; `/version` returns only that verified full source-candidate
  SHA/archive hash and compatibility-named runtime artifact hash, never raw
  environment claims. `/api/me` exposes only
  sanitized UI preferences and public document/contact links.

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
  fails closed. Every primary and compensation step repeats the role check
  immediately before network dispatch. Writes are journaled as
  prepared→executing→terminal; `queued_at` records queue admission and
  `dispatched_at` is set only immediately before the external fetch begins.
  Typed pre-dispatch budget/cancellation failures are definitive and are never
  classified as ambiguous. Transport failure/timeout/408/5xx/malformed
  success after dispatch remains `outcome_unknown` without automatic retry.
- **Admin-authored intent capability:** before any main-planner turn can receive
  Clockify results, the constrained declaration pass receives only the exact
  current and unresolved prior admin-authored text as untrusted natural-language
  input; its trusted envelope also supplies exact write-action names and the
  catalog hash. It persists an immutable
  `IntentCapabilityV1` with exact write action names, verified UTF-8 byte spans,
  normalized literal constraints, maximum executions (one by default), and
  request/catalog hashes. Provider failure, malformed spans, or invented values
  produce a durable `deny_all_writes` capability; reads remain available. The
  harness matches the model's raw arguments before Zod preprocessing and before
  server-side id/date resolution against explicit authority metadata for all 81
  writes. Server-derived ids, permitted defaults, and exact authoritative
  preserved-state paths can only narrow authority.
  Each safe or confirmed operation binds the capability and atomically consumes
  one execution; replay of that same bound operation consumes none. Confirmation
  and resume reload the original persisted capability, reject capability/catalog
  drift, and journal any resumed write under a new bound operation.
- **Durable external effects:** every Clockify external write persists normalized
  nonsecret intent and an exact mutation plan before dispatch. Every host effect is an
  ordered prepared→executing→terminal step. Safe writes own the single operation
  start; confirmed writes inherit the one-use claim's start and receive only a
  step journal scoped to that exact operation. Duplicate/cross-operation step
  starts fail before host dispatch. A later definitive failure after a known
  effect returns `partial`, while ambiguity stops all later steps. Compensation
  uses its dedicated eligibility/dispatch/settlement path; a rejected or unknown
  compensation never erases the known-succeeded source. Host dispatch and local
  settlement have separate error boundaries: after a known host success, full
  settlement failure uses a bounded best-effort marker without effect JSON. A
  safe single-step write still returns success with
  `operation_journal_degraded`; a composition stops as nonretryable `partial`;
  compensation preserves the known result. Even if the fallback marker cannot
  persist, the synthetic result stays truthful and the already-created unique
  step identity blocks redispatch. The async-local REST mutation scope rejects
  unscoped, repeated, excess, or out-of-order calls before the affected dispatch,
  permits at most one mutation call per host step, and after the callback rejects
  an incomplete primary plan before success is reported. It poisons later primary
  dispatch after a caught denial/failure and admits compensation only after its
  durable source step is eligible. Startup recovery is read-only:
  store recovery marks only dispatched orphan steps unknown, then the production
  reconciliation registry executes the action/step's complete-list or exact-target
  read strategy before traffic is accepted. Compatible authoritative evidence
  settles the step and operation; incomplete, zero/multiple, truncated,
  handler-missing, or fingerprint-drift evidence remains unknown. It never resumes
  prepared work or compensates automatically. `mutation-compatibility.ts` rejects any external
  write lacking normalized nonsecret operation data, an exact plan,
  authoritative targeting, or step-bound complete-evidence reconciliation
  metadata; there is no exception bridge. `clockify_tags_create` is the
  step-journaled safe-write reference. Invoice writes are the confirmed-write
  reference:
  they persist the exact operation plan and journal each base create,
  enrichment, item, status, payment, delete, and import mutation separately.
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
  commit. A truncated entity/user/group/tag scan never establishes absence or
  uniqueness: exact-id hits remain usable, but symbolic one/none matches clarify
  for an exact id or narrower filter. `clockify_onboard_user` likewise resolves
  its group NAMES at PREVIEW (matchByName over a complete listGroups result;
  unresolved/ambiguous render as "will be skipped", verified ids go in the
  payload; a truncated result clarifies) — so the preview matches what the
  best-effort group-adds actually do (it was the lone commit-time resolver before).
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
  cancellation before every not-yet-dispatched tool call and through the governor
  into REST. A queued mutation cancels definitively and refunds its reservation.
  Once dispatch begins, the signal cannot interrupt or retry the external write;
  cancellation waits for its known/unknown outcome to settle.
- **Operation identity and selective semantic dedupe:** workspace/admin/action-scoped
  semantic dedupe remains only for `clockify_setup_project` and
  `clockify_setup_task`. Invoice safety is operation-level: replay reuses the same
  durable `operationId` and its prepared/executing/terminal step journal and
  reconciliation evidence; a separately authored preview is a distinct intentional
  operation, even if its payload is equal. **Undo** for creations runs in reverse
  order, is one-use, and re-checks policy. A created TASK ref carries its
  `projectId` on the `EntityRef`
  (a task delete is project-scoped), so `reverseCreation` can delete it; a task
  ref missing its `projectId` can't be reversed and returns an honest
  `undo_failed`, never a silent success (the fake mirrors this — it no longer
  "deletes" a task without a projectId). `compose.ts` rolls back required-step
  failures. For the two semantically deduplicated setup actions, the atomic-claim
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
  The durable invoice workflow POSTs the minimal base body, performs one
  read-prepared clean enrichment PUT for note/subject/tax/tax2/discount, then one
  stored-order POST per item. Only a base-only create can reconcile an ambiguous
  POST, using complete immediately-pre-dispatch/post lists and one exact
  complete-final fingerprint match. A composite create remains unknown and
  dispatches no enrichment/items. The refreshed baseline is stored on the
  prepared step before it enters `executing`; zero, multiple, or truncated
  matches remain unknown. Payments use a POST-only mutation with the same durable
  pre-dispatch baseline; the harness owns list-diff matching and exposes an id
  only for one exact, complete new match. A failed/truncated immediate baseline
  dispatches no POST.
  Compatibility wrappers remain closure-bound and delegate to the same atomic
  methods.
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
npm test               # build exact server + served UI artifact, then Vitest; no unmocked network
npm run build          # tsc + vite -> dist/server, dist/ui
npm run lint           # typed eslint across src + operational scripts; zero warnings
npm run verify         # both type-checks + lint + cycles + dup + test + build
npm run test:e2e       # Chromium + Firefox + WebKit product/browser matrix
npm run perf:local-ui  # local UI, history, status, and 20 KiB gzip gates
npm run media:marketplace # deterministic icon/banner/screenshots/demo package
npm run audit:prod     # fail-closed production advisory gate
npm run license:prod   # production license gate + deterministic JSON report
npm run eval:smoke     # offline scripted safety corpus; no network/credentials
npm run db:capture-backup-boundary -- BOUNDARY # create-only pre-snapshot RPO timestamp
npm run db:bind-legacy-backup-metadata -- BACKUP SHA256 V1_JSON BOUNDARY V2_JSON # non-overwriting v7 release sidecar
npm run db:verify-restore -- RESTORED SHA256 METADATA # private-clone RTO/RPO + built-start proof
npm run dev            # tsx src/server.ts (needs env)
npm run cycles         # madge --circular … (pinned devDep) — keep 0
```

Push/PR CI runs `audit:prod`, `license:prod`, and `verify`; it retains the
CycloneDX SBOM and deterministic production-license report together. Dependency
review, gitleaks, and CodeQL are separate checks. `main` carries the required
`verify` status check (branch protection, no forced PR — admins can still
direct-push).

`live-smoke.yml` runs weekly, manually, or as a reusable workflow against the
named `clockify-live-smoke-sacrificial` environment. The two required secrets are
`LIVE_CLOCKIFY_API_KEY` and `LIVE_WORKSPACE_ID`. Repository-wide concurrency
serializes smoke and its separate always-run cleanup job; both are timeout-bounded
and always upload sanitized prefix/count/status evidence without credentials,
resource ids/names, payloads, response bodies, or prompts.

Manual `release-evidence.yml` records the exact commit SHA, API-validated reviewed
PR/head/CI/CodeQL identities, and three hashed zero-retry Vitest count reports
(minimum 2,366 passed with zero skipped/todo) plus machine conclusions for verify,
production audit/license, CodeQL, gitleaks,
`eval:smoke`, SBOM, live smoke, backup/restore, deterministic DeepSeek safety, and
production AUDIT-host clearance. Only the three admin packages named above are
human `not_evaluated` gates. Workflow presence is not sign-off, deployment
evidence, or Marketplace approval; no workflow deploys or submits the add-on.

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
npm run eval:smoke                                                                   # deterministic offline safety floor
LIVE_CLOCKIFY=1 LIVE_CLOCKIFY_API_KEY=… LIVE_WORKSPACE_ID=… npx tsx scripts/live-full.ts   # every action, self-cleaning
LIVE_CLOCKIFY=1 npx tsx scripts/live-sweep.ts                                              # leftover sweep → must report 0
npx tsx --env-file=.env.server scripts/eval-planner.ts --repeat=3                          # planner meter (pass-rate + consistency + spread)
npx tsx --env-file=.env.server scripts/eval-agentic.ts --repeat=3 [--single-turn]          # agentic loop meter
npx tsx scripts/eval-matrix.ts --repeat=5                                                  # weak-model MATRIX: planner+agentic × N models (eval-models.json, gitignored)
npx tsx --env-file=.env.server scripts/live-confirm-flow.ts                                # confirm safety over HTTP
LIVE_CLOCKIFY=1 npx tsx --env-file=.env.server scripts/live-agentic-flow.ts                # loop vs real host
npx tsx --env-file=.env.server scripts/live-chat-tour.ts                                   # broad dogfood tour
LIVE_CLOCKIFY=1 LIVE_SCOPE_FRESH_INSTALL=1 npm run probe:scopes                            # aggregate scope + explicit AUDIT reachability on a server-attested fresh install
LIVE_CLOCKIFY=1 npx tsx scripts/host-auth-spike.ts                                         # API/reports/AUDIT add-on-token clearance
```

For `eval-agentic`, `--only=<exact case id>` selects exactly one case. A non-exact
value keeps the ad-hoc substring behavior for selecting several related case IDs.

Always finish a live run with the sweep at 0 leftovers. Never commit or paste live
credentials.
