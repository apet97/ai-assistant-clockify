# AGENTS.md — AI Assistant Add-on

Short map for agents and new contributors. **`CLAUDE.md` is the source of truth** —
read its "Safety & planner invariants" and "Clockify API facts" before touching the
harness or the Clockify adapter. `README.md` is the product overview.

## What this is

A Clockify add-on: an **admin-only** embedded chat backed by an internal,
MCP-shaped action harness. The model proposes named actions; a deterministic
harness validates policy/schema/risk and executes; the backend owns all state and
secrets. `npm run verify` runs both TypeScript projects, zero-warning typed ESLint,
the full test/build suite, and circular-dependency/duplication gates. 154 typed
actions, 16 areas, 3 Clockify hosts. Railway is the private-production target
(volume-backed SQLite at `/data`); deploy only through the checked transaction in
`DEPLOYMENT.md`, never a bare `railway up`. Data handling/retention: `PRIVACY.md`.

Fast path: use `README.md` for product/setup, `CLAUDE.md` for invariants and API
facts, `DEPLOYMENT.md` for recovery/release operations, and
`MARKETPLACE_READINESS.md` for historical v1 evidence. Do not duplicate those documents
here; this file is the execution map.

## Current v2 implementation checkpoint

- T00-A authorized `codex/rewrite-api-agent-v2` at `d0f29bc90c28e42d052db441a414abcb37865681`.
- Tasks 1-3 are complete; the raw extractor preserves 142 independently scoped call sites and the byte-identical 118-shape legacy projection.
- Task 4 CLOSED at `6184efa80a95be06020635540185bae01ba1299e`: 140 actions (82 `api`, 23 `composite`, 31 `generic`, 4 `local`), 142 call sites / 118 shapes, inventory schema/generator v2, catalog hash `9e14ae30ce3731b847e3500db7976220734ed4867cd3000ab32fa14632faa82c`.
- T04-R3 remediated the four accepted findings from reviews on `776eb081…`; re-reviews on `6184efa…` accepted zero HIGH/MEDIUM.
- Official OpenAPI snapshot is repository-owned under `evidence/openapi/`; material contracts and schema maxima are fail-closed before registry insertion; adapter identities include `sourceColumn`.
- Task 5 CLOSED: explicit `INTERNAL`/`MODEL_API`/`LOCAL` registries; `catalogForModel`/`toolsForModel` require a registry; v1 callers pass `INTERNAL_ACTION_CATALOG`.
- T06-PROJECTS CLOSED: atomic project API actions (`delete_archived`/`deleteProject`, member hourly `addUsersHourlyRate`, member cost `addUsersCostRate`, `memberships_replace`/`updateMemberships`, closed `estimate_update`/`updateEstimate`). v1 composite/generic project wrappers stay internal.
- T06-TASKS CLOSED at `7b96f12fce1394a96f08eca79672d9021a14451d`: atomic task API actions (`delete_completed`/`deleteTask`, `status_update`/`assignees_replace`/closed `update`/`updateTask`, bounded `create`/`createTask`, hourly `setTaskHourlyRate`, cost `setTaskCostRate`). v1 `clockify_tasks_delete` and `clockify_tasks_rate_update` stay internal.
- T06-CLIENTS CLOSED at `9880859`: atomic client API actions (`create_base`/`createClient`, closed `update`/`archive`/`updateClient`, `delete_archived`/`deleteClient`). v1 `clockify_clients_create` and `clockify_clients_delete` stay internal composites.
- T06-TAGS CLOSED at `e87a255`: all five tag operations (`getTags`/`getTag`/`createNewTag`/`updateTag`/`deleteTag`) were already `apiExposure: "api"` with closed schemas and addon+api_key availability — verified, no split file.
- T06-INVOICE CLOSED: atomic invoice reads/export; embedded items (no items GET); `create_base`; split `fields_update`/`status_update`; one-item add/delete; atomic payments; bounded `import_time`. Composites `clockify_invoices_create`/`update` stay internal. Next: `T06-EXPENSES` category splits.
- T06-EXPENSES RECORDS CLOSED: atomic expense list/get/create/update/delete plus categories list/create on MODEL_API (`workflows/expenses.ts`). Counts unchanged: `MODEL_API` 113; `ACTION_CATALOG` 163. Live: `live_not_run_missing_credentials`.
- T06-EXPENSES CATEGORIES CLOSED: split rename/status/delete_archived API actions; v1 category update/delete composites stay internal. Counts: `MODEL_API` 116; `ACTION_CATALOG` 166. Live: `live_not_run_missing_credentials`.

## Non-negotiable invariants

- [`ADR 001`](./docs/adr/001-api-agent-v2.md) governs the v2 rewrite. V2 coexists
  under `src/assistant-v2/`; `ASSISTANT_ENGINE=v1|v2` will be the sole rewrite
  switch and defaults to v1 until authorized cutover.
  During coexistence, v1 accepts only critical safety, production, and verified Clockify-contract fixes.
- Admin/owner only. Reject non-admins **before** creating a session.
- Per-admin, per-workspace policy; genuinely new admins default to full
  `read_write`, while groups missing from an existing policy migrate to `off`.
  Admins manage only their own policy.
- Reads return immediately. Only actions explicitly classified `safe_write`
  execute immediately with a receipt. **Editing existing data and every risky
  write require a dry-run preview + button-only confirmation.** Typed "yes"
  never executes.
- `Confirm all` applies only to the exact stored batch; partial failure is never
  hidden.
- Confirmation is one-use, time-limited (5 min), bound to
  session/workspace/admin + a salted nonce hash + operation hash + immutable
  capability id/hash. Policy, capability, catalog, and action compatibility are
  re-checked at confirm time.
- Every mutation/confirmation/undo performs a fresh role check and fails closed;
  every primary and compensation step repeats that check immediately before
  dispatch. Clockify host writes are single-flight per workspace and are never
  auto-retried.
- Before the main planner can see Clockify results, a constrained declaration
  pass receives only current and unresolved prior admin-authored text as
  untrusted natural-language input; its trusted envelope also supplies exact
  write-action names, literal-controlled paths, reviewed semantic aliases, and
  the catalog hash. The provider cites an exact quote, its authored segment, and
  its zero-based occurrence; the server rejects absent, out-of-range,
  cross-segment, or polarity-inverted evidence and computes verified UTF-8 byte
  spans. It persists an immutable
  `IntentCapabilityV1`: exact write actions, structured literal constraints,
  cardinality, and request/catalog hashes. Provider failure, malformed evidence,
  invented values, or a provider-returned tool that was not offered durably deny
  writes while reads remain available. Terminal authority denials use
  deterministic server copy rather than another provider turn.
- Literal constraints may contain bounded structured JSON under the one shared
  limit contract in `src/harness/safety-limits.ts`; declaration, persistence,
  authority matching, schemas, and catalog metadata must not diverge.
- Every raw action definition requires API classification and per-auth
  availability. `normalizeRegistryAction` is the sole raw-to-registry boundary:
  it supplies no defaults, validates complete metadata and closed model-write
  schemas, recomputes reviewed write authority, and rejects non-atomic primary
  mutation plans before model-registry insertion.
- Semantic literal aliases are exact, catalog-hashed, and scoped to one
  action/path/value. Every model-controlled boolean path has reviewed aliases or
  an explicit exact-literal exclusion; opposite-polarity containment fails closed.
- Advertised batch limits come from the deterministic worst-case host-call
  estimator; group-member additions cap at 14. Prepared operations bind and hash
  `maxHostCalls` and reserve the full remaining call cost before first dispatch.
- Raw model arguments are matched against that capability before Zod
  preprocessing or server-side id/date resolution. Every one of the 82 Clockify write
  actions has explicit authority metadata; server-derived ids, permitted
  defaults, and exact authoritative preserved-state paths may narrow execution
  but never expand it. The only symbolic-self equivalence is catalog-hashed:
  exact authored `me` may equal the exact authenticated admin id on the two
  reviewed project-member paths, with one raw value and no cross-user matching.
  Safe and confirmed writes bind and atomically consume the
  capability; exact operation replay consumes no additional execution, and
  resume reloads the original capability.
- Full action outcomes live only in `action_results`; turns, chat history, audit,
  confirmations, undo, operation journals, and replay state keep ordered links
  plus bounded summaries. Terminal confirmation/recovery paths scrub nonce
  hashes, saved agent state, and executable operation payloads.
- Every Clockify external write persists normalized nonsecret operation data, an
  exact mutation plan, authoritative target/parent snapshots where applicable,
  and step-bound reconciliation metadata. The catalog has no legacy mutation or
  target-verification exceptions. The REST mutation scope rejects unscoped,
  repeated, excess, or out-of-order calls before the affected dispatch and
  permits at most one mutation call per host step. After the callback and before
  success is reported, it rejects an incomplete primary plan. Compensation is
  allowed only after its durable source step becomes eligible.
- A post-dispatch journal failure never rewrites a known Clockify success as a
  retryable or definitive failure: single safe writes return success with an
  explicit degradation warning, composed writes stop as `partial`, and known
  compensation success is never automatically retried.
- Client cancellation can stop model work or a not-yet-dispatched action, never a
  Clockify mutation after dispatch. Per-session FIFO locks cover route settlement
  and skip disconnected queued requests.
- Installation writes are generation-bound. Inactive/deleted installs reject new
  and queued writes; uninstall immediately tombstones and wipes the token, drains
  only already-dispatched work, erases workspace data, and resumes interrupted
  tombstone deletion at startup. Same-token install retries are authority-neutral even
  while inactive; only STATUS ACTIVE reactivates that token. Replacement/uninstall
  retain only a separate-domain, workspace-unlinked token
  fingerprint so delayed old callbacks cannot restore retired authority. A bounded,
  separate-domain hashed-workspace lineage blocks never-before-seen older tokens after
  row erasure/restart and expires after 24 hours + 2 minutes + 1 second. All add-on JWTs require
  `exp`; lifecycle JWTs require bounded `iat`, persisted per generation so older
  deliveries cannot roll authority back; equal times rank `DELETED > INACTIVE > ACTIVE`.
- Component load performs a forced current Clockify role check after the active-install
  gate and before any session reuse/create. Never authorize it from JWT role alone.
- After any awaited role/provider boundary, synchronously recheck the exact active
  installation generation before creating sessions, policies, results, or audit rows.
- The model never receives Clockify tokens, add-on tokens, session secrets, the
  model API key, or raw headers. Never log tokens/headers. Tokens are encrypted at
  rest (AES-256-GCM).
- The REST adapter does **I/O only** — no risk/policy/confirmation logic; that
  stays in `src/harness/*`. Secrets never enter a `ConfirmableOperation.payload`.
- Resolve identity (names/numbers → ids, incl. archived) and calendar dates
  server-side, at preview time — never trust model-supplied ids or dates.
- Every public Clockify list/search port returns exact
  `ListResult<T> = { rows, truncated }`. Every list/search receipt includes
  `truncated`; `true` adds `list_truncated`. A truncated scan cannot prove
  absence or uniqueness — require an exact id or narrower filter.
- Don't add React/Next/Prisma/Redis/queues/vector DBs. Don't modify sibling repos.
- Verify Clockify behavior against the OpenAPI spec + a live probe, not the code —
  this codebase's API assumptions have repeatedly been wrong. TDD: failing test
  first.

## Commands

```bash
npm install
npm run type-check    # tsc --noEmit
npm test              # build exact server + served UI artifact, then Vitest (no unmocked network)
npm run build         # -> dist/server, dist/ui
npm run lint          # typed eslint across src + scripts
npm run verify        # both type-checks + lint + cycles + dup + test + build
npm run test:e2e      # Chromium + Firefox + WebKit product/browser matrix
npm run perf:local-ui # UI/history/status/20 KiB gzip gates
npm run media:marketplace # deterministic listing asset package
npm run audit:prod    # fail-closed production advisory policy
npm run license:prod  # production license policy + deterministic JSON evidence
npm run eval:smoke    # offline scripted-model safety corpus (no credentials)
npm run check:scope-contract # generated endpoint/scope contract must be current
npm run generate:api-action-inventory # regenerate TS, JSON, and Markdown inventory artifacts
npm run check:api-action-inventory # generated API action inventory must be current
npm run deploy:private-production # guarded release transaction; prerequisites in DEPLOYMENT.md
npm run dev           # tsx src/server.ts (needs env)
```

## Release evidence boundaries

- All currently accepted DeepSeek, private-production, live-browser, and aggregate
  release artifacts are historical v1 evidence only. Validators preserve their
  input schemas/hashes, classify derived conclusions as historical v1, and reject
  any v2 target before parsing; none can establish a v2 conclusion.
- Push/PR CI runs `audit:prod`, `license:prod`, and `verify`, and retains the
  CycloneDX SBOM plus production-license report. Dependency review, gitleaks, and
  CodeQL remain separate automated checks.
- `.github/workflows/live-smoke.yml` is weekly, manual, and reusable. It uses the
  named `clockify-live-smoke-sacrificial` environment, requires only
  `LIVE_CLOCKIFY_API_KEY` and `LIVE_WORKSPACE_ID`, serializes the whole smoke +
  cleanup sequence, always runs a bounded cleanup job, and uploads secret-free
  count/status evidence. Configuring those credentials and proving a real run
  remain operator work.
- Manual `.github/workflows/release-evidence.yml` records the exact commit SHA,
  validated reviewed-PR/head/CI/CodeQL identities, three hashed zero-retry Vitest
  count reports (minimum 2,366 passed, zero skipped/todo), and machine conclusions
  for verify, audit, license, CodeQL, secret scan,
  `eval:smoke`, SBOM, live smoke, backup/restore, deterministic DeepSeek safety,
  and production AUDIT-host clearance. Only the three final admin packages are
  emitted as `not_evaluated`; the workflow does not deploy, approve, or submit.

## Layout

- `src/config.ts` — env config (Zod). `src/db/` — SQLite schema; `store.ts` is a
  thin facade composing per-concern builders in `store/` (sessions, confirmations,
  idempotency ledger, undo, audit/metrics, telemetry, durable turn/operation
  journals, canonical action results + ordered replay/history links, short-lived
  artifacts, installations, immutable intent capabilities + operation bindings +
  usage claims (`store/intent-capabilities.ts`), one-statement/one-transaction
  500-row retention with persisted passive-WAL evidence, and AES-256-GCM token
  encryption/rotation). Full outcomes live only in `action_results`; linked
  summaries are capped at 65,536 bytes. `src/auth/` — admin role check, CSRF,
  signed session cookie.
- `src/addon/` — manifest + Clockify token verification (RS256, one platform key
  built in).
- `src/clockify/` — `client.ts` (the `WorkspaceClient` port, the seam),
  `rest-workspace.ts` (live REST adapter, `X-Addon-Token`; I/O only; per-area
  `rest/*` over `rest/core.ts`; plain/envelope/POST pagination preserves
  `ListResult.truncated`, with shared bounded-page collection in
  `rest/list-pages.ts`; `core.mutate` is the exactly-one-external-mutation
  primitive used by durable workflow steps and its async-local exact-plan scope
  enforces order, at most one mutation call per host step, post-callback plan
  completion before success reporting, compensation eligibility, and the
  per-dispatch role gate; shared date normalization in `rest/wire-dates.ts`),
  `api-base.ts` (hosts from the install token claims), `service-url.ts` (strict
  Clockify-origin validation), `request-governor.ts` (per-workspace rate,
  concurrency, write, and per-turn host-call bounds).
- `src/assistant/` — model client (OpenAI-compatible HTTP or `gemini-cli`), prompt
  builder, planner (native tool-calling default, JSON fallback), the isolated
  admin-text + trusted catalog-metadata declaration pass (`intent-declaration.ts`;
  provider quote references, server-computed UTF-8 spans, reviewed semantic
  aliases),
  `agent-loop.ts`/`agent-state.ts` (durable agentic loop; provider cancellation and
  bounded selection context survive clarification/confirm resume).
- `src/harness/` — the safety boundary: `action.ts` (contracts +
  `defineRiskyAction`/`defineReadAction`), `actions.ts` (executor +
  `commitConfirmedOperation`), `api-operation.ts` (required typed API metadata
  carrier), `action-registry.ts` (fail-closed normalization, duplicate-safe
  inventory, and schema verdict), `api-catalog.generated.ts` (handler-free API
  descriptors), `catalog.ts` (required metadata fingerprints),
  `workflows/structure-api-metadata.ts` (reviewed operation/endpoint/auth/exposure
  and material/presenter evidence for 31 structure definitions), `workflows/time-tracking.ts`
  and `workflows/entries.ts` (equivalent evidence for 11 time definitions), plus
  `workflows/reports.ts`, `workflows/audit.ts`, `workflows/workspace.ts`,
  `workflows/holidays.ts`, and `workflows/webhooks.ts` (equivalent evidence for
  21 reporting/administration definitions); `workflows/invoices.ts`, `expenses.ts`,
  `custom-fields.ts`, `users.ts`, `time-off.ts`, `approvals.ts`, `scheduling.ts`,
  `admin.ts`, and `curated.ts` complete the remaining T04-E through T04-J
  evidence for all 140 definitions, `permissions.ts`, `risk.ts`,
  `receipts.ts` (`listReceipt` is the list/search receipt choke point),
  `confirmations.ts`, `tools.ts`, `intent-capability.ts` (immutable persisted
  declaration contract), `intent-authority.ts` (pre-Zod raw-argument matcher),
  `write-authority.ts` (explicit metadata + exact-plan validation for all 83
  writes: 82 Clockify actions plus the local permission action), `tool-select.ts` (deterministic
  tool subsetting on chat + resume; no match/non-ASCII/>3 areas fail open to the
  full catalog; no Serbian-specific router tokens; **default ON** via
  `LLM_TOOL_SELECT`, `=0` rolls back),
  `mutation-workflow.ts` (operation-scoped prepared→executing→terminal primary
  and compensation steps; ambiguity or degraded settlement stops later dispatch),
  `durable-safe-write.ts` (the real step-journaled safe-write builder),
  `durable-risky-write.ts` (confirmed step adapter), billing fingerprints,
  provenance, create/update/payment reconciliation in the focused `invoice-*`
  modules, `target-snapshots.ts` (authoritative pre-dispatch drift checks),
  `mutation-compatibility.ts` (no-exception durable catalog gate),
  `startup-reconciliation.ts` + `startup-reconciliation-registry.ts` and focused
  workflow registries (read-only executable reconciliation for crash-orphaned
  dispatched steps; never resumes prepared work or compensates),
  `compose.ts` (legacy atomic multi-step/rollback),
  `idempotency.ts` (workspace/admin/action-scoped semantic confirmed-commit
  dedupe for `clockify_setup_project` and `clockify_setup_task`, including partial
  replay; invoice safety is instead anchored to the persisted durable operation
  ID, exact step journal, and reconciliation evidence — never a semantic payload
  hash or second payload-level id), `undo.ts` (local service, not an API action definition),
  `money.ts` (the one major↔minor mapping, both ways —
  `toMinor`/`fromMinor`), `workflows/*` — name→id/date resolution split across
  `resolve.ts` (entities), `resolve-dates.ts` (calendar + `resolveDateRange`),
  `preview-patch.ts`, all re-exported via `resolve.ts`; plus shared
  `resolveScopeRefs`, `clarifyResult` (`action.ts`), and the `rate.ts`
  rate-preview builder.
- `src/routes/` — `lifecycle.ts`, `component.ts`, `api.ts` (the route handlers for
  chat + stream + confirm + undo + metrics + new chat + history switcher). The
  turn/confirm/commit machinery lives in `chat-pipeline.ts` (`createChatPipeline`),
  pure result transforms + guards in `chat-results.ts`, the never-break-a-turn
  bookkeeping wrapper `best-effort.ts`, session FIFO wrapper in `async-handler.ts`,
  NDJSON-stream setup `ndjson.ts`; shared `deps.ts`. Scoped
  `GET /api/operation-runs/:operationId` exposes sanitized bounded operation and
  step status; chat history restores passive operation cards from the same scoped
  view. Chat mutations require a client UUID `requestId`; retries replay the
  durable turn from nonce-free result/preview links (only a still-pending preview
  gets a freshly rotated nonce). Terminal confirmations scrub their nonce hash,
  saved agent state, and operation payload. `server.ts` — `createApp(deps)` + `start()`; `/live` is liveness and
  `/health` performs a committed readiness probe. `release-artifact.ts` binds
  production startup and `/version` to the post-build manifest and exact complete
  `dist/server` bytes before the database/provider initializes.
- `src/ui/` — vanilla TS chat UI (a11y; "New chat" + "Chats ▾" history dropdown);
  HTTP/NDJSON client in `api-client.ts`, composer/stream flows in
  `composer-flow.ts`, rendering in `render.ts`/`shared.ts`, `main.ts` keeps
  `mount()` + a re-export barrel. Preferences are exactly `{theme,timeZone?}`;
  valid legacy `language` is dropped from the retained storage/cookie formats,
  the interface is fixed English through `EN_US_LOCALE`, and Unicode Clockify
  data remains unmodified `textContent`; the dedicated English-interface contract
  pins the locale seam and absent Serbian locale/router branches.
  `tests/` — unit + integration (fakes via `tests/helpers/fake-clockify.ts`;
  `tests/helpers/session.ts` mints an admin cookie in-process). `scripts/` — opt-in
  live exercisers (sacrificial workspace only) plus checksum-verified
  `backup-db.ts`/`restore-db.ts` recovery tooling, a non-overwriting legacy-v7
  metadata binder, plus the caller-read-only, secret-free `verify-restored-db.ts`
  RTO/RPO gate (source-schema read/token proof, private mode-0600 v8 migration clone,
  exact built server identity, and post-shutdown schema/integrity/writer-lock proof).
  `scripts/lib/adapter-endpoints.ts` owns raw fail-closed `RestCore` call-site
  extraction, stable ordering, pagination metadata, and reviewed official-OpenAPI
  correlation; duplicates remain distinct through scope assignment.
  `scripts/generate-api-action-inventory.ts` generates the handler-free catalog,
  JSON evidence, and Markdown inventory from one deterministic evidence model.

## Live request-shape gotchas (encoded in the adapter + unit tests)

- `GET /webhooks` → `{workspaceWebhookCount, webhooks:[…]}`; `GET /expenses` →
  `{expenses:{expenses:[…],count}, …}` — both envelopes, not arrays.
- Time-entry update is GET-then-PUT (PUT replaces and requires `start`).
- Invoice `issuedDate`/`dueDate` and expense `date` need full ISO datetimes.
- Expense create/update is `multipart/form-data` and requires `userId`.
- Webhook create requires `webhookEvent` + HTTPS url + a trigger source.
- A task delete is **project-scoped**: `deleteEntity` for a `task` needs its
  `projectId` (it routes to the typed `deleteTask`), so an undo of a created task
  carries `projectId` on the `EntityRef`.
- Time-off request create is **policy-unit-specific**: a DAYS policy wants bare
  `YYYY-MM-DD` + `period.days`; an HOURS policy wants full ISO datetime
  `period.{start,end}` with **no `days`** (the DAYS body 400s on an HOURS policy).
- Client CREATE silently drops `ccEmails`/`currencyId` (adapter applies them via a
  follow-up PUT); scheduling `publish` is range-scoped, with an optional
  `userFilter` to narrow it to one user.
- Invoice create is the durable reference workflow: minimal base POST, at most
  one enrichment PUT, then one item POST per stored item. Only a base-only create
  can reconcile ambiguity: it requires a complete immediately-pre-dispatch
  baseline, complete post-list, and one exact complete-final fingerprint match.
  A composite create with ambiguous base POST remains unknown and dispatches no
  enrichment/items. The refreshed baseline is durable on the prepared step.
  Payment POST is atomic and POST-only; the harness owns the same durable
  pre-dispatch baseline and authoritative ID matching. Invoice item/payment
  deletes revalidate complete raw snapshots.
- Full set + the money/rate/scoping subtleties: `CLAUDE.md` → "Clockify API facts".
