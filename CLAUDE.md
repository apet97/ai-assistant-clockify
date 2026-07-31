# CLAUDE.md — AI Assistant Add-on

The engineering source of truth for this repo. Read it before changing code.
Companion: `AGENTS.md` (short map), `README.md` (product overview), `DEPLOYMENT.md`,
`PRIVACY.md`.

## Current state (2026-07-31)

Full history is in [`docs/V2_BUILD_LOG.md`](./docs/V2_BUILD_LOG.md); the immutable
production cutover is in [`docs/V2_CUTOVER_RECORD.md`](./docs/V2_CUTOVER_RECORD.md).
This capsule is current truth, not a PR chronology.

### Source, remote, and deployment are different boundaries

- **Deployed:** Railway serves immutable candidate `ad06c08`, explicitly
  `ASSISTANT_ENGINE=v2`, from schema 13
  `/data/ai-assistant-v2.sqlite`; `/version` was candidate-bound and `/live`,
  `/health`, and `/manifest` passed at cutover. The untouched v1 database and
  `ec09863` tree remain rollback history.
- **Source boundary:** Phase A, the Phase B evidence scaffolding, and M1–M7 are
  present through immutable Phase M boundary `0b2b723`. Documentation and later
  source-checkpoint descendants do not change that evaluator boundary. Refresh
  the live remote, candidate, and checks with the preflight in `AGENTS.md`; never
  freeze their transient status into this file.
- `ASSISTANT_ENGINE` is the sole runtime switch. Unspecified configuration
  now defaults to **v2** (C11, owner decision 2026-07-31); `ASSISTANT_ENGINE=v1`
  is the tested rollback. Deployed `ad06c08` selects v2 explicitly, so the
  default change does not alter what production serves. V1 remains in-tree for
  rollback only.
- The cutover record correctly preserves the fresh database's initial
  `409 not installed` state. Reinstall subsequently completed: an aliased
  production lifecycle log records `installed` at `2026-07-30T02:47:41Z`,
  generation 1, so current production has a fresh v2 installation/attestation.

"Phase M landed" has one meaning: protected remote `main` contains `0b2b723` and
the exact current candidate's required checks are green. A local commit, docs
descendant, or typed workflow input does not satisfy it. Do not dispatch the paid
workflow with `phase-m-landed` before that boundary is true.

### Phase A, B, and M source landmarks

- **Phase A:** stale cross-turn write seeds are filtered to recent completed reads,
  the prompt requires fresh discovery before changes, `no_change_needed` is
  presented end to end, and the 127-visible/44-v1-only split is pinned.
- **Phase B:** `live:v2-full` owns the guarded v2 preview → stored nonce →
  confirm → real Clockify write → cleanup chain and has a credential-free
  `--dry-run` contract path. V2 authority, aggregate release, model,
  private-production, and live-browser builders/validators exist beside the
  immutable v1 evidence lane; `.github/workflows/v2-model-evals.yml` records the
  three v2 reports.
- **M1–M7:** the evaluator now scores real runner use, journals admitted write
  requests, judges destructive selection from model calls, limits the corpus to
  the 120 operations loadable with add-on auth, uses argument-bearing requests,
  enforces the owner-ratified policy, and binds the historical diagnostic without
  promoting it. The exact discovery grid is **120 cases × 3 cohorts × 3 repeats =
  1,080 attempts**. Per-case floors are canonical 3/3, paraphrase at least 2/3,
  and typo at least 2/3. Calling an unrelated destructive operation and loading
  more than 12 API tools are the two zero-tolerance gates.
- The `ad06c08` 239/1,143 discovery run is diagnostic evidence only and is void
  for model selection. It predates the M1–M7 scorer/corpus contract.

The catalog remains 171 typed actions (`api` 127, `composite` 24, `generic` 16,
`local` 4); v2 exposes only the 127 API actions. Regenerate and check the API
inventory instead of copying hashes into prose.

### Evidence and open gates

- Historical DeepSeek, private-production, browser, and aggregate artifacts are
  immutable **v1 rollback evidence**. Their schemas/hashes must not be rewritten.
- The v2 lane is **structurally blocked**, not merely incomplete:
  `scripts/eval-write-safety.ts` always emits
  `not_evaluated_missing_credentials` and exits 2; the real observer exists only
  in the integration test. `v2-model-evals.yml` uploads that blocked report,
  while `v2-authority-evidence.ts` can construct apparently complete zero fields
  from metadata instead of consuming observations. `release-evidence.yml` does
  not consume the three v2 eval artifacts into one all-gates exact-SHA conclusion.
- Remaining sequence: repair the post-M evidence handoff, complete C/D work, then
  run a candidate-bound release. The live v2 write/cleanup, exact-candidate
  deployment/browser proof, the [7-day soak](./docs/V2_SOAK_SPEC.md), independent
  security/recovery sign-off, and Marketplace access remain external/technical gates.
- `scripts/live-full.ts` is read/preview/sweep diagnostic only. It constructs a
  bare `ActionContext`, so its writes correctly fail `mutation_scope_required`;
  its write columns are not evidence. **`live:v2-full` is the sole v2 live-write
  evidence path.** Never relax the runtime scope to make `live-full.ts` pass.

The highest-risk defects historically hid behind permissive fakes and
hand-authored frames. Prefer `tests/helpers/v2-production-composition.ts` and
`npm run test:e2e:real`, which compose the real app/store boundary.

### v2 budgets (`V2_LIMITS`)

`maxModelCalls` 6 · `maxDiscoveryCalls` 2 · `maxLoadedApiTools` 12 ·
`maxApiCalls` 12 · `maxConcurrentReads` 4 · `maxHostCalls` 60 ·
`maxWallClockMs` 300_000 · `maxTotalTokens` 64_000. All are enforced at
runtime: logical calls reserve per batch in provider order, writes count,
physical host calls charge a persisted per-run ledger (`used + reserved ≤ 60`
in the dispatch-granting transaction; reservations convert/release at
settlement; restart reloads the persisted budget), active wall-time is charged
around every awaited segment, and provider retry attempts are charged including
the both-fail case.

## Start here

- Product behavior and local setup: `README.md`.
- Code changes: read "Safety & planner invariants", then the relevant entry in
  "Architecture". Do not infer authorization rules from UI or prompt text.
- Clockify wire changes: verify the official OpenAPI shape and a sacrificial live
  probe, update the adapter test, then regenerate/check the endpoint-scope contract.
- Release or deployment work: follow `DEPLOYMENT.md` literally. Production deploys
  use the checked `npm run deploy:private-production` transaction; never run a bare
  `railway up` from the working tree.
- Release status and exact evidence: `MARKETPLACE_READINESS.md`. Checked-in
  templates, old deployments, and prose claims are not evidence.

## What this is

An **admin-only** AI assistant embedded inside Clockify: a chat where workspace
admins ask for Clockify work in plain language, backed by an internal,
MCP-shaped **action harness**. The model only ever *proposes* named actions from a
fixed catalog; a deterministic harness validates every proposal against per-admin
permissions and a risk policy and is the only thing that touches Clockify. The
model never executes anything itself and never sees a secret.

**Historical release state:** version 1.0.0 materials describe the v1
private-production, pre-Marketplace release candidate; Marketplace submission did
not occur. They are rollback/history context, not current v2 completion or
deployment evidence. V2 requires fresh evidence after its authorized cutover work.

- **Gate:** `npm run verify` runs both TypeScript projects, the full test/build
  suite, a zero-warning typed **ESLint** gate, madge circular-dependency analysis,
  and the jscpd duplication gate. Keep every stage green.
- **Release checks:** `npm run audit:prod` applies the fail-closed production
  advisory policy; `npm run license:prod` applies the production-license policy
  and rewrites deterministic JSON evidence; `npm run eval:smoke` runs the
  offline scripted-model safety corpus without credentials.
- **Coverage:** 171 typed catalog actions, 16 areas, 3 Clockify hosts (incl. the
  single-approval composites `clockify_setup_project` (create + members + rates)
  and `clockify_setup_task` (create-in-project + assignees + task rate): each is
  one preview → one Confirm → one atomic `commit` that journals each host
  effect through `executeDurableRiskyStep` → `dispatchWithReconciliation`,
  mirroring `onboard_user`. There is NO mid-commit rollback: a definitive
  failure after a known effect returns `partial` and RETAINS what succeeded,
  and reversal is the post-hoc one-use undo (`reverseCreationDurably`)).
- **Historical v1 model evidence:** the version 1.0.0 release kept DeepSeek V4 Pro
  through the existing OpenAI-compatible HTTP client, native tool mode,
  `LLM_AGENTIC=1`, and `LLM_TOOL_SELECT=1`. The selected 1.0.0 thinking setting
  came only from the then-final-source `deepseek-release-binding.json`: configure
  `LLM_THINKING_MODE=disabled` exactly when its
  `modelConfiguration.thinkingMode` is `disabled`, otherwise leave the variable
  absent. The release gate fail-closes on any write-safety or latency regression.
  The client remains backend-configurable for development, but provider migration
  is not part of this release.
- **Tool selection:** `LLM_TOOL_SELECT` is default-on (`=0` rolls back) and applies
  on chat and confirmation resume. Focused ASCII requests receive a relevant subset
  plus the always-on core; no lexical match, non-ASCII input, or more than three
  areas fails open to the full catalog. Its curated vocabulary has no Serbian-specific
  router tokens; generic non-ASCII fail-open remains until v1 removal. Chat may use
  one full-catalog recall retry; resume may not. Unresolved admin-authored clarification
  context survives terse follow-ups and resume. Implementation: `src/harness/tool-select.ts`; measurements:
  `scripts/eval-matrix.ts`, `scripts/eval-agentic.ts`, and the exact-source evidence
  under `evidence/performance/`.
- **Private-production target: Railway** (Nixpacks → `npm run build` → `npm start`, liveness
  `/live`, committed-write readiness `/health`). Use the candidate-bound checked
  transaction in `DEPLOYMENT.md`; never deploy the mutable checkout directly. The SDK
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
  names, literal-controlled paths, reviewed semantic aliases, and the catalog
  hash. The provider cites an exact quote, its authored segment, and its
  zero-based occurrence; the server computes and verifies UTF-8 byte spans. It persists the
  exact write authority for that request. Invalid or ambiguous citations,
  unreviewed aliases, polarity inversions, and provider-returned tools that were
  not offered all fail closed. A terminal authority denial uses deterministic
  server copy and never asks the provider to reinterpret it; reads remain
  available.
- Declaration literals may be bounded structured JSON, using the one shared
  depth/node/byte/array limit contract in `src/harness/safety-limits.ts`. The same
  contract governs declaration decoding, persistence, raw authority matching,
  action schemas, and catalog metadata; it does not change the capability version.
- Every raw action definition requires an exposure decision and per-auth
  availability. `normalizeRegistryAction` is the sole raw-to-registry boundary:
  it supplies no classification defaults, validates reviewed endpoint keys,
  closed model-write schemas, bounded dictionaries, material facts, presenter
  identity/version, and one primary mutation, and recomputes
  `writeAuthorityFor()` before returning an immutable definition. The exact
  compatibility/hash source of truth is `actionFingerprintContract()` in
  `src/harness/catalog.ts`; do not infer fields from this prose. In particular,
  model-visible `description` is not currently in that fingerprint contract. No
  incomplete definition may enter a model registry.
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
- [`ADR 001`](./docs/adr/001-api-agent-v2.md) is the accepted v2 architecture
  contract. V2 coexists under `src/assistant-v2/`; `ASSISTANT_ENGINE=v1|v2` is the
  sole switch. Unspecified configuration defaults to **v2** (C11); the deployed
  `ad06c08` cutover selects v2 explicitly, and `ASSISTANT_ENGINE=v1` is the
  tested rollback.
  During coexistence, v1 accepts only critical safety, production, and verified Clockify-contract fixes.

## Architecture

- `src/assistant-v2/` — the current agent runtime: protocol/state, bounded runner,
  durable events/observations, catalog discovery and loading, read execution,
  grounded references, prompt, and the presented-result/presenter registry.
  The "presenter registry" is a **version-pinning and coverage table, not a
  dispatch table**: all 127 `presentation` records register the SAME function,
  `metadataDrivenPresentPreparedWrite`
  (`src/harness/prepared-write-presentation.ts:547`), and previews call that one
  presenter directly (`operation-preparation-service.ts:301`) rather than
  looking one up. The v2 terminal card renders from the shared read-fact
  extractor `factsFromReceipt` (`result-view-service.ts:52`) plus
  `defaultTitle` — one generic extractor in place of per-action ones.
  Per-action presenters are not planned. Coverage is enforced at BOOT:
  `api-catalog.ts:83` runs `initializePreparedWritePresentationRegistries`,
  which asserts every `api`-exposed action carries exactly one uniquely-keyed
  `presentation` and then version-checks each registration.
- `src/services/` — the production orchestration seam used by routes and v2:
  run/session context, API discovery, preparation/execution, confirmation,
  clarification, result/history/artifact views, events/hydration, permissions,
  metrics, and undo. Keep transport and UI out of these services.
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
- `scripts/lib/adapter-endpoints.ts` owns the fail-closed raw `RestCore` scanner,
  path normalization, source location, stable call-site identity/order, and
  pagination metadata, plus the pinned official-OpenAPI spine parser and reviewed
  dynamic-path correlation. Duplicate method/path call sites remain distinct
  through scope assignment. `scripts/generate-api-action-inventory.ts` projects
  one deterministic evidence model into `src/harness/api-catalog.generated.ts`,
  `evidence/api-action-inventory.json`, and `docs/API_ACTION_INVENTORY.md`; checks
  reject stale outputs, missing dispositions, or invalid correlations.
- `src/harness/` — the safety boundary: `action.ts` (contracts +
  `defineRiskyAction`/`defineReadAction`; `ActionContext` carries injected
  capabilities `savePolicy`/`recentOutcomes`/`idempotency`), `actions.ts`
  (executor + `commitConfirmedOperation`, the single risky-commit choke point),
  `api-operation.ts` (the required typed metadata carrier), `action-registry.ts`
  (the sole fail-closed raw-definition normalizer plus duplicate-safe inventory
  and schema verdict), `api-catalog.generated.ts` (handler-free API descriptors),
  `catalog.ts` (required metadata fingerprints),
  `workflows/structure-api-metadata.ts` (the reviewed T04-B operation IDs,
  endpoint bindings, auth availability, exposure, material facts, and presenters
  for 31 structure definitions), `workflows/time-tracking.ts` and
  `workflows/entries.ts` (the equivalent T04-C evidence for 11 time definitions),
  and `workflows/reports.ts`, `workflows/audit.ts`, `workflows/workspace.ts`,
  `workflows/holidays.ts`, and `workflows/webhooks.ts` (the equivalent T04-D
  evidence for 21 reporting/administration definitions); `workflows/invoices.ts`,
  `expenses.ts`, `custom-fields.ts`, `users.ts`, `time-off.ts`, `approvals.ts`,
  `scheduling.ts`, `admin.ts`, and `curated.ts` own the remaining T04-E through
  T04-J evidence, completing all 140 definitions, `permissions.ts`,
  `risk.ts`, `receipts.ts` (`listReceipt` always
  emits `truncated` and adds `list_truncated` for incomplete results), `confirmations.ts`,
  `tools.ts` (Zod→JSON-schema tools), `arg-summary.ts`, `intent-capability.ts`
  (immutable `IntentCapabilityV1`), `intent-authority.ts` (pre-Zod raw-argument
  matcher), `write-authority.ts` (explicit authority and exact-plan metadata for
  all 82 Clockify writes plus the local permission write), `mutation-workflow.ts`
  (durable one-dispatch steps + partial/unknown classification),
  `durable-risky-write.ts` (confirmed one-dispatch adapter), the focused
  `invoice-create-workflow.ts`/`invoice-update-workflow.ts`/
  `invoice-payment-workflow.ts` reconciliation modules,
  `target-snapshots.ts` (authoritative pre-dispatch drift checks),
  `mutation-compatibility.ts` (deterministic catalog audit helper invoked by
  tests; it has zero production callers and is not the runtime write guard),
  `startup-reconciliation.ts` + `startup-reconciliation-registry.ts` and focused
  workflow registries (read-only executable reconciliation for crash-orphaned
  dispatched steps; never resumes prepared work or compensates),
  `idempotency.ts`
  (workspace/admin/action-scoped semantic confirmed-commit dedupe for
  `clockify_setup_project` and `clockify_setup_task`, with a 10-min window and
  canonical partial replay; invoice replay and duplicate suppression instead use
  the persisted durable operation ID, exact step journal, and reconciliation
  evidence — never a semantic payload hash or second payload-level id),
  `undo.ts` (the local reverse-creation service, not an API action definition), `money.ts` (the one major↔minor amount mapping,
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
- `src/assistant/` — shared provider client plus the legacy v1 planner
  (`LLM_PROVIDER=http` OpenAI-compatible DeepSeek
  default, or `gemini-cli`), `prompts.ts`, `planner.ts`,
  `intent-declaration.ts` (the isolated admin-text + trusted catalog-metadata
  declaration pass),
  `agent-loop.ts` + `agent-state.ts` (the durable agentic loop, including bounded
  selection context, persisted capability bindings, and provider cancellation).
- `scripts/eval-v2/` + `scripts/eval-{api-discovery,assistant-terminal,write-safety}.ts`
  own the v2 corpus, real-runner harness, policy, deterministic report shape, and
  three entrypoints. `scripts/live-v2-full.ts` is the sole guarded live-write
  chain; `scripts/live-full.ts` remains read/preview/sweep diagnostic only.
- `scripts/evidence/v2-*.ts` owns the v2 authority, aggregate, model,
  private-production, deployed-engine, and live-browser evidence chain. These are
  siblings of immutable v1 validators, not replacements for them.
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
  emits local understanding feedback before provider work, and remains usable
  without horizontal overflow at 280px. Its exact preference contract is
  `{theme,timeZone?}`: the existing localStorage key and strict nested session
  schema accept then drop valid legacy `language`, Clockify language claims are
  ignored, and verified theme/timezone remain. The UI sets `lang="en"`, formats
  through one fixed `EN_US_LOCALE`, and keeps arbitrary Unicode workspace data in
  `textContent` without transformation. `tests/unit/english-interface-contract.test.ts`
  independently pins that source/runtime boundary, including the absent Serbian
  locale/router branches; protocol timezone validation is locale-neutral because
  its formatted value is discarded.
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
  input; its trusted envelope also supplies exact write-action names,
  literal-controlled paths, action/path/value-scoped reviewed semantic aliases,
  and the catalog hash. The provider returns exact quote references with a
  zero-based occurrence into named authored segments; the server rejects absent,
  out-of-range, cross-segment, polarity-inverted, or otherwise ambiguous evidence
  and computes the verified UTF-8 byte spans itself. It persists an immutable `IntentCapabilityV1` with
  exact write action names, verified UTF-8 byte spans, normalized literal
  constraints, maximum executions (one by default), and request/catalog hashes.
  Provider failure, malformed evidence, or invented values produce a durable
  `deny_all_writes` capability; reads remain available. The
  harness matches the model's raw arguments before Zod preprocessing and before
  server-side id/date resolution against explicit authority metadata for all 83
  writes (82 Clockify actions plus the local permission action). Server-derived ids, permitted defaults, and exact authoritative
  preserved-state paths can only narrow authority. The sole symbolic-self
  equivalence is explicit, catalog-hashed metadata: exact authored `me` may match
  exactly one raw value equal to the authenticated admin id only on project
  membership `addUserIds[]` and project member-rate `userId`; all other ids,
  paths, values, and actions remain exact-match only.
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
  prepared work or compensates automatically. C0 runtime refusal lives in the
  async-local mutation scope in `src/clockify/rest/core.ts`: an unscoped,
  repeated, excess, out-of-order, or incomplete-plan mutation fails before the
  affected dispatch/success report. `mutation-compatibility.ts` is only the
  deterministic audit/test gate proving every catalog write declares normalized
  nonsecret operation data, an exact plan, authoritative targeting, and
  step-bound complete-evidence reconciliation; it has zero production callers and
  no exception bridge. `clockify_tags_create` is the
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
- **Typed consent guard:** a bare "yes"/"confirm"/"do it" never reaches the
  planner. With a live preview, deterministic copy points at its button; without
  one, it reports that no new action was taken (`TYPED_CONSENT` +
  `store.countPendingConfirmations`).
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
  (a task delete is project-scoped), so `reverseCreationDurably` can delete it; a task
  ref missing its `projectId` can't be reversed and returns an honest
  `undo_failed`, never a silent success (the fake mirrors this — it no longer
  "deletes" a task without a projectId). A composite's required-step failure is
  reported as `partial` with the succeeded effects retained — never rolled back
  mid-commit. For the two semantically deduplicated setup actions, the atomic-claim
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
  primitive-scrambling; measured 12/12 adoption. That is a **v1** result: all 44
  v1-only actions — 24 `composite`, 16 `generic`, 4 `local`, the curated intents
  included — are invisible to the v2 model BY DESIGN (v2 sees only the 127
  reviewed `apiExposure: "api"` actions). `clockify_entries_create` is the
  bounded v2 replacement for `clockify_log_work` (same dispatcher,
  `src/harness/workflows/entry-action-shared.ts:296`). The intent-shaped
  exclusions are pinned by name in `tests/unit/model-api-catalog.test.ts`.

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
npm ci
npm run type-check              # app/tests TypeScript; no credentials
npm run type-check:scripts      # operational/eval/evidence TypeScript; no credentials
npm test                        # build + Vitest; fake host, no unmocked network
npm run build                   # tsc + vite -> dist/server, dist/ui
npm run lint                    # typed eslint across src + scripts; zero warnings
npm run verify                  # full credential-free local gate; run in isolation
npm run generate:api-action-inventory # regenerate TS, JSON, and Markdown from one evidence model
npm run check:api-action-inventory # fail if inventory artifacts or classifications drift
npm run test:e2e                # renderer/browser fixture matrix
npm run test:e2e:real           # local real Express/SQLite path × 3 browsers
npm run perf:local-ui           # local UI, history, status, and 20 KiB gzip gates
npm run media:marketplace       # deterministic icon/banner/screenshots/demo package
npm run audit:prod              # fail-closed production advisory gate
npm run license:prod            # production license gate + deterministic JSON report
npm run eval:smoke              # offline scripted safety corpus
npm run eval:write-safety       # credential-free BLOCKED accounting entrypoint; exits 2
npm run eval:api-discovery      # CREDENTIALED + PAID: 1,080 real agent turns
npm run eval:assistant-terminal # CREDENTIALED + PAID: 897 attempts
npm run live:v2-full -- --dry-run # guarded chain, fake host, zero external writes
npm run live:v2-full            # LIVE WRITES: sacrificial workspace + authorization
npm run live:sweep              # LIVE cleanup; must finish at zero leftovers
npm run record:v2-release-evidence # partial v2 builder; not an all-gates conclusion
npm run deploy:private-production # guarded exact-source Railway transaction; DEPLOYMENT.md prerequisites required
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

Manual `release-evidence.yml` preserves the exact-candidate machine-gate and
historical v1 aggregation path. Existing DeepSeek, private-production,
live-browser, and aggregate records remain immutable v1 rollback evidence; do not
rewrite their schemas or recorded hashes.

The v2 builders and manual `v2-model-evals.yml` workflow exist, but their handoff
is structurally blocked: write-safety produces a blocked accounting report,
authority evidence does not consume the test-only observations, and
`release-evidence.yml` does not join all three v2 evals to the all-gates exact-SHA
conclusion. Repair that post-M handoff before C/D work and a candidate-bound
release run. `phase-m-landed` is truthful only when protected remote `main`
contains `0b2b723` and the exact current candidate's checks are green. Workflow
presence never deploys, approves, or submits the add-on.

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
(uninstall → Insert link → INSTALL). The private-production target is Railway
and does not depend on the tunnel.

## Live testing (opt-in, sacrificial workspace only; gitignored `.env*`)

Tests run entirely against fakes by default — no network, no credentials. Live
checks are opt-in, gated by env (`LIVE_CLOCKIFY=1` + the relevant tokens/IDs), and
**must target a throwaway workspace**.

```bash
npm run eval:smoke                              # OFFLINE deterministic safety floor
npm run eval:write-safety                       # credential-free BLOCKED accounting entrypoint; exits 2
npm run live:v2-full -- --dry-run               # OFFLINE v2 preview/confirm contract
npm run live:v2-full                            # LIVE WRITES; guarded credentials + per-step authorization
npm run live:sweep                              # LIVE cleanup; must report 0 leftovers
LIVE_CLOCKIFY=1 LIVE_CLOCKIFY_API_KEY=… LIVE_WORKSPACE_ID=… npx tsx scripts/live-full.ts # LIVE reads/previews/sweep diagnostic ONLY
npx tsx --env-file=.env.server scripts/eval-planner.ts --repeat=3                          # planner meter (pass-rate + consistency + spread)
npx tsx --env-file=.env.server scripts/eval-agentic.ts --repeat=3 [--single-turn]          # agentic loop meter
npx tsx scripts/eval-matrix.ts --repeat=5                                                  # weak-model MATRIX: planner+agentic × N models (eval-models.json, gitignored)
npx tsx --env-file=.env.server scripts/live-confirm-flow.ts                                # confirm safety over HTTP
LIVE_CLOCKIFY=1 npx tsx --env-file=.env.server scripts/live-agentic-flow.ts                # loop vs real host
npx tsx --env-file=.env.server scripts/live-chat-tour.ts                                   # broad dogfood tour
LIVE_CLOCKIFY=1 LIVE_SCOPE_FRESH_INSTALL=1 npm run probe:scopes                            # aggregate scope + explicit AUDIT reachability on a server-attested fresh install
LIVE_CLOCKIFY=1 npx tsx scripts/host-auth-spike.ts                                         # API/reports/AUDIT add-on-token clearance
```

`scripts/live-full.ts` is not a v2 write harness: its bare context correctly
fails the async-local mutation scope, so its write columns are not evidence.
`live:v2-full` is the sole v2 live-write evidence path.

For `eval-agentic`, `--only=<exact case id>` selects exactly one case. A non-exact
value keeps the ad-hoc substring behavior for selecting several related case IDs.

Always finish a live run with the sweep at 0 leftovers. Never commit or paste live
credentials.
