# AGENTS.md — AI Assistant Add-on

Short map for agents and new contributors. **`CLAUDE.md` is the source of truth** —
read its "Safety & planner invariants" and "Clockify API facts" before touching the
harness or the Clockify adapter. `README.md` is the product overview.

## What this is

A Clockify add-on: an **admin-only** embedded chat backed by an internal,
MCP-shaped action harness. The model proposes named actions; a deterministic
harness validates policy/schema/risk and executes; the backend owns all state and
secrets. `npm run verify` runs both TypeScript projects, zero-warning typed ESLint,
the full test/build suite, and circular-dependency/duplication gates. 171 typed
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
- T06-CUSTOM-FIELDS CLOSED: bounded create/update/set_value_project/set_value_entry on MODEL_API; legacy unbounded handlers off-catalog; get stays composite. Counts: `MODEL_API` 120; `ACTION_CATALOG` 166. Live: `live_not_run_missing_credentials`.
- T06-USERS CLOSED: invite, deactivate, and role_update verified on MODEL_API. Live: `live_not_run_missing_credentials`.
- T06-GROUPS CLOSED: group create/update/delete and remove_user verified on MODEL_API; get stays composite. Live: `live_not_run_missing_credentials`.
- T06-GROUP-MEMBERSHIP CLOSED: `clockify_groups_add_member` on MODEL_API; v1 `clockify_groups_add_user` stays internal. Counts: `MODEL_API` 121; `ACTION_CATALOG` 167. Live: `live_not_run_missing_credentials`.
- T06-TIME-OFF-POLICIES CLOSED: bounded policy create/update on MODEL_API; get stays composite. Live: `live_not_run_missing_credentials`.
- T06-TIME-OFF-REQUESTS CLOSED: unit-specific create_days/create_hours on MODEL_API; generic create and composite get stay internal. Counts: `ACTION_CATALOG` 169, `MODEL_API` 124. Live: `live_not_run_missing_credentials`.
- T06-TIME-OFF-BALANCE CLOSED: bounded balance update on MODEL_API. Counts: `MODEL_API` 125. Live: `live_not_run_missing_credentials`.
- T06-APPROVALS CLOSED: single-request approval actions on MODEL_API; get and approve_pending stay internal. Live: `live_not_run_missing_credentials`.
- T06-SCHEDULING-ASSIGNMENTS CLOSED: assignment CRUD/list on MODEL_API; get stays composite. Live: `live_not_run_missing_credentials`.
- T06-SCHEDULING-TOTALS CLOSED: split project_totals_all/one plus user_totals on MODEL_API; generic project_totals stays internal. Counts: `ACTION_CATALOG` 171, `MODEL_API` 127. Live: `live_not_run_missing_credentials`.
- T06-SCHEDULING-PUBLISH CLOSED: atomic publish on MODEL_API. Live: `live_not_run_missing_credentials`.
- **Task 6 CLOSED (T06-FINAL):** inventory/scope/registry parity gate green; `ACTION_CATALOG` 171, `MODEL_API` 127, catalog hash `7cc50023d83c1517dfc0306b7732db239e4b3b909bffd3e9519e7350dbebaeab`. Next: `T07-A`.
- **T07-A CLOSED:** deterministic discovery index/search (`src/assistant-v2/discovery/`); NFKC tokenization, weights 40/30/20/10, trigram ≥0.34, auth pre-filter + notice, cap 12. Gate: 36 focused tests green. Next: `T07-B`.
- **T07-B CLOSED:** bounded dynamic discovery seam — meta-tool only at init, loaded-tool validation, startup index injection; max 12 API tools + discovery. Gate: `npm run verify` green. Next: `T08-B`.
- **T08-A CLOSED:** v2 budgets/protocol/state/prompt contracts; shared 24,000-byte tool-result cap; model-client native-tool preflight/accounting. Gate: budgets/state/cap/model-client/agent-loop tests green. Next: `T08-B`.
- **T08-B CLOSED:** schema v9 (`assistant_runs`, request/result links, scoped FKs, one active run/session); `src/db/store/runs.ts`; retention/erasure/restore wiring. Gate: v2-runner-persistence + migration/retention/tombstone tests green. Next: `T08-C`.
- **T08-C CLOSED:** v2 provider loop — completion validation, cache seed, refinement cap, no provider transcript persistence. Gate: v2-runner tests green. Next: `T08-D`.
- **T08-D CLOSED:** bounded four-worker reads, provider-order results, ordered write prep, persisted host-call budget. Gate: concurrency/cancellation tests green. Next: `T08-E`.
- **T08-E CLOSED / Task 8 green:** provider-independent suspension/replay/startup recovery; v2 pipeline never falls through to v1; default engine stays v1. Next: `T09-A`.
- **T09-C CLOSED / Task 9 green:** durable v2 run events (schema v10), scoped hydrated views, cursor-safe UI restoration; default engine stays v1. Next: `T10-A`.
- **T10-A CLOSED:** structure read port + 10/10 generated parity rows green; live `not_run`. Next: `T10-B`.
- **T10-B CLOSED:** time reads 2/2 parity green; live `not_run`. Next: `T10-C`.
- **T10-C CLOSED:** reporting/admin reads 10/10 parity green; webhooks auth-filtered; live `not_run`. Next: `T10-D`.
- **T10-D CLOSED:** invoice reads 4/4 parity green; live `not_run`. Next: `T10-E`.
- **T10-E CLOSED:** expense/custom-field reads 4/4 parity green; live `not_run`. Next: `T10-F`.
- **T10-F CLOSED:** user/group reads 2/2 parity green; live `not_run`. Next: `T10-G`.
- **T10-G CLOSED:** leave/scheduling reads 11/11 parity green; live `not_run`. Next: `T10-H`.
- **T10-H CLOSED / Task 10 green:** 43/43 catalog reads, hash `f79307bc…de3e3b`, verify green; default engine stays v1. Live: `not_run`. Next: `T11-A`.
- **T11-A CLOSED:** schema v11 discriminator matrix + exact-batch persistence (`confirmation_batches`/`confirmation_batch_items`), capability-linked v1 backfill, batch store with ordered tuple hash; missing discriminator fails closed. Gate: batch/migration/retention/restore/scrub tests green. Live: `not_run`. Next: `T11-B`.
- **T11-B CLOSED:** exact material expansion + registered formatters/presenters + mandatory `validatePreparedWritePresentation` (22 material facts, RFC6901, bounds, provenance gate, fail-closed no truncation). Provenance is evidence only. Gate: v2-prepared-write + catalog/inventory tests green. Live: `not_run`. Next: `T11-C`.
- **T11-C CLOSED:** assistant-origin v2 writes always prepare via `OperationPreparationService`/`executeV2ApiAction` (no v1 capability, no host mutation during preparation, host reservation + persisted operation/plan/provenance/discriminator). Legacy v1 safe-write immediate path unchanged. Gate: v2-preview-first-matrix + listed write-safety tests green. Live: `not_run`. Next: `T11-D`.
- **T11-D CLOSED:** `ConfirmationService` confirms v2 previews via stored executors only (`confirmSingle`, trusted direct safe writes with explicit origins, undo commit branch); single route rejects batch-owned previews; batch confirm stubbed for T11-E. Gate: listed confirm/undo/recheck/idempotency/scrub tests green. Live: `not_run`. Next: `T11-E`.
- **T11-E CLOSED:** exact Confirm-all batches (ordered tuple hash, earliest expiry, single-confirm reject, definitive partial / ambiguity stop, replay, never-dispatched executing→pending recovery); `POST /api/confirmation-batches/:id/confirm`; v2 confirmation service uses `MODEL_API_ACTION_CATALOG.hash()`. Gate: confirmation-batches + v2-confirmation-batch + scrub + mutation-workflow green. Live: `not_run`. Next: `T11-F`.
- **T11-F CLOSED / Task 11 green:** preview-first closure gate green (prepared-write, batches, matrix, scrub, migration/retention/restore, inventory, verify); every assistant write prepares then confirms; default engine stays v1. Live: `not_run`. Next: `T12-A`.
- **T12-A CLOSED:** 17/17 structure (`work_structure`) writes in `v2-write-parity-structure.test.ts`; prepare denies policy/auth cleanly; one-primary button confirm; default engine stays v1. Live: `not_run`. Next: `T12-B`.
- **T12-B CLOSED:** time write parity matrix + auth-class prepare gate + Atomic mutation counting. Live: `not_run`. Next: `T12-C`.
- **T12-C CLOSED:** reporting/admin write parity incl. webhook auth-class gate. Live: `not_run`. Next: `T12-D`.
- **T12-D CLOSED:** invoice write parity matrix. Live: `not_run`. Next: `T12-E`.
- **T12-E CLOSED:** expense/custom-field write parity. Live: `not_run`. Next: `T12-F`.
- **T12-F CLOSED:** user/group write parity matrix. Live: `not_run`. Next: `T12-G`.
- **T12-G CLOSED:** leave/approval/scheduling write parity. Live: `not_run`. Next: `T12-H`.
- **T12-H CLOSED / Task 12 green:** compound dependent/independent journeys + exit gate green; default engine stays v1. Live: `not_run`. Next: `T13-A`.
- **T13-A CLOSED:** `v2-no-intent-declaration.test.ts` proves one real prepare→confirm write (`clockify_tags_create`) makes zero declaration/capability calls and stores `authorityModel: "preview_confirmation_v2"` with no capability id/hash; passed immediately, no production change. Gate: 228 tests green + type-check. Live: `not_run`. Next: `T13-B`.
- **T13-B CLOSED:** hostile-data (real runner, injected project name, zero mutations, unexecuted preview), typed-consent (12 confirm-shaped strings rejected as nonces), and confirmation-authority (12 real rejection gates: role/policy/generation/target-snapshot/nonce/fingerprint/registry/catalog-hash/operation-hash/journal-state/replay/no-retry) — all passed immediately, no production change. Gate: 119 tests green + type-check. Live: `not_run`. Next: `T13-C`.
- **T13-C CLOSED / Task 13 green:** `scripts/evidence/v2-authority-evidence.ts` (exact `V2AuthorityEvidence` schema, four conclusions, `not_evaluated_until_pr15` sentinel); `release-evidence.ts` adds `buildV2ReleaseEvidence` beside the untouched v1 path; `release-evidence.yml`'s checkout-free `record` job records the same sentinel inline (no `npx tsx`, per its existing no-checkout contract) and uploads a separate artifact; `release-candidate.md` points at the new schema. 21 rejection/acceptance unit tests. Gate: 36 focused tests + type-check + type-check:scripts + full `npm run verify` green (321/4882; one confirmed pre-existing flake, not reproduced on rerun). Live: `not_run`. Next: T13 independent review gate, then `T14-A`.
- **T13 independent review gate CLOSED:** two reviews on the `190f0e8..2d7bcbd` diff (authority/confirmation safety; evidence integrity + v1/v2 coexistence), zero HIGH findings; one accepted MEDIUM (test-naming overstated external-attacker reachability for four confirmation-authority defense-in-depth cases) remediated doc/rename-only (`b56ad80`), re-verified, scoped re-review ADDRESSED. Next: `T14-A`.
- **T14-A CLOSED:** schema v12 (`entity_references` + `pending_clarifications`, bidirectional status-tuple CHECK, terminal-scrub triggers); new schema/store-only modules `src/db/store/entity-references.ts` + `src/db/store/pending-clarifications.ts`; wired into retention (lazy expiry + pruning) and uninstall erasure; no resolver/route/runner wiring yet. Gate: 91 tests (T14-A gate list) + type-check + lint green. Live: `not_run`. Next: `T14-B`.
- **T14-B CLOSED:** `ReferenceSelectorMetadata` (`src/harness/api-operation.ts`) threaded through `apiActionMetadataFields`/`normalizeRegistryAction`/`catalog.ts` fingerprint (catalog hash changes globally, same as T11-B's `presentation`); `referenceId` added to v2 model-facing schemas only (`tool-schema.ts` + `discoveryToolsForLoadedSet`), v1 untouched; new pure resolver `src/assistant-v2/references/entity-reference.ts`; corrected T14-A's `entity_references.bindings` shape to per-instance captured values; zero domains registered (T14-C). Also fixed 3 pre-existing `userVersion: 11` test fixtures and 3 fingerprint-recompute tests exposed by the T14-A/T14-B hash bumps. Gate: 28 tests + `check:api-action-inventory` + full `npm run verify` green (323/4928). Live: `not_run`. Next: `T14-C`.
- **T14-C CLOSED:** `referenceSelector` attached to 7 real atomic api-exposed write actions (one per domain: project/client/task/tag/user/invoice/expense delete-by-id), each as a sibling literal on the existing action-definition call site — no metadata-builder-file or route/pipeline changes. New `tests/integration/v2-reference-followup.test.ts` (fake seed → constructed reference → resolver → real Zod schema → real `.handler` preview, per domain); task binds both id+projectId. Gate: 38 tests + `check:api-action-inventory` + full `npm run verify` green (324/4938). Live: `not_run`. Next: `T14-D`.
- **T14-D CLOSED:** `POST /api/clarifications/:id/resolve` (`src/routes/clarifications.ts`, strict `{optionId}`): claim `pending->resolving` → match `optionId` against stored candidates (never the label) → rebuild args from stored partial args + matched `externalId` → Zod-revalidate → execute read or prepare write (never dispatch) via the same ports `runAssistantV2` uses → ONE transaction (`Store.resolveClarificationOption`, new, mirrors `startUndoOperation`'s cross-store-transaction pattern) links the result, resolves+scrubs the clarification, clears run suspension, appends `tool.completed` → resumes via `runAssistantV2`. New `src/services/clarification-service.ts` owns the flow; a prepared write gets a bounded "prepared" `action_result` marker (none exists at prepare time otherwise) to satisfy the schema FK. `v2-chat-pipeline.ts` exported `buildV2RunnerDependencies` (extracted, shared by both callers). `runner.ts`: resumed runs (`resumingExistingRun`) get `resumeSummaries` built from `state.completedResults` on their first model call via the pre-existing (previously unused) `buildResumeUserMessage`; fresh runs unchanged. Route mounts unconditionally like `runsRouter`; run scope is server-derived only (`getActiveRunForSession`), never client-supplied. Gate: 13 tests + full `npm run verify` green (325/4951). Known gap for the T14-T16 review gate (no owning slice): `read-execution.ts`'s clarify outcome never calls `createPendingClarification` — nothing creates a clarification row yet. Live: `not_run`. Next: `T14-E`.
- **T14-E CLOSED:** optional `continuationRunId` on `chatBodySchema`/`ChatPreconditions`/`executeChatTurn` (v1 unmodified, structurally ignores the extra param). v2's `executeChatTurn`: with `continuationRunId`, one transaction (`Store.continueClarificationWithFreeTextAndLink`) scrubs the clarification to `continued`, links the new requestId, persists the admin message, clears suspension — then `runAssistantV2` resumes with `continuationMessage`. Without it, checks `getActiveRunForSession` first: awaiting-clarification supersedes via `Store.supersedeClarificationForNewRun` (cancel+fail, one transaction) before starting the new run; awaiting-confirmation is refused (`run_awaiting_confirmation`) rather than inventing a confirmation-cancel path (no `confirmationIds` on `RunContinuation` — that's T16-C/E). `runner.ts`: `continuationMessage` replaces the dead `resumeResultId` field, surfaced via `buildResumeUserMessage`'s new `adminFollowUp`. Found+fixed 2 pre-existing bugs via the first real HTTP v2 exercise: non-integer `latencyMs` from `performance.now()`, and a fresh run's `runId` colliding with `chatPreconditions`'s own `turn_runs` claim (both reused `requestId`). Gate: 8 HTTP tests + full `npm run verify` green (325/4958). Live: `not_run`. Next: `T14-F`.
- **T14-F CLOSED / Task 14 green:** `ClarifyResult` gained optional `clarificationId`/`status`. `renderClarify` branches: id set → chip calls `resolveOption(id, optionId)`, label never submitted; absent → unchanged v1 `sendText(label)`. Chips disabled unless `clarificationId === undefined || status === "pending"`. New `api-client.ts` `resolveClarificationOption` + `composer-flow.ts` `submitClarificationResolve` (mirrors `submitStreaming`, never sends chat text). `main.ts`'s `activeClarificationRunId`: hydrated from `HistoryResponse.activeRun`, forwarded as `continuationRunId` on next send, cleared on new chat/resolve/continuation-settle either way (fail-closed tradeoff, documented). New `v2-clarification-ui.test.ts` (15 tests) + extended XSS suite. **3 gaps flagged for the T14-T16 review gate, one root cause:** E2E left `test.describe.skip` (`v2-clarification.spec.ts`, header explains why); `activeClarificationRunId`'s own lifecycle untested (lives in `renderChat()`'s DOM closure, that file's own comment says untested by design); root cause of both — `read-execution.ts` still never creates a real clarification row. Gate: 155/155 + e2e grep 9 passed/9 skipped + full verify green (confirmed via log exit code after one flaky run reproduced the known `f1-verify-flake-diagnosis` pattern, cleared on rerun 326/4969). Live: `not_run`. Next: `T15-A`.
- **T15-A..D CLOSED:** `PresentedResult`/`DiagnosticView`/`PresentedResultEnvelope` relocated (not
  redesigned) from `events.ts` to `assistant-v2/presentation/presented-result.ts` with strict Zod
  schemas (six statuses, unknown-key rejection, recovery union, byteLength-matches-value refine,
  Task-11-reused bounds). Key finding: Task 11 already registers a mechanical presenter for all 127
  catalog actions at load time keyed by unique `presenterId`==name — "one presenter per action" was
  already true; `presenter-registry.ts` adds only the missing-presentation assertion Task 11's own
  validator skips, plus the `PreparedWriteFact[]->facts` adapter (`toPublicPresentationFacts`, no new
  formatting policy). `result-presentation-service.ts`: `presentPendingWriteConfirmation` (real preview
  via real presenter), `presentReadResult`/`sanitizeProviderSummary` (succeeded-only status, provider
  text confined to a 4096-byte UTF-8-safe summary, 6-variant table-proven), `assertPreviewTerminalFact
  Parity` (confirmed facts never dropped/altered, response-only adds ok) — proven against one real
  action per family for all 7 (structure/time/reporting/invoices/expenses/users/leave). 2 scope notes
  flagged for T14-T16 review: per-domain read fact population not wired; terminal-side real DB read not
  wired (mechanism proven correct given any terminal list, not yet called with real data). Gate: 46+67+19
  tests + check:api-action-inventory + full verify green (329/5036). Live: `not_run`. Next: `T15-E`.
- **T15-E CLOSED / Task 15 green:** structured v2 result rendering, UI-only (no server `src/` file
  touched). `ui/protocol.ts` strictly decodes the full `PresentedResultEnvelope` (the prior stub
  hardcoded empty facts/warnings/references); `ui/shared.ts` extends `PreviewResult`/`ReceiptResult`
  with optional presenter fields while still emitting `kind: "preview"`/`"receipt"`, so confirm/cancel
  mechanics and a legacy v1 result render byte-identically; `ui/render.ts` adds
  `renderFacts`/`renderReferences`/`renderRecovery` (textContent-only) and a `STATUS_VIEW` table
  giving each terminal status its own label+icon, with the details disclosure preferring
  `diagnostic.value` and keeping a static "Details" toggle name. Recovery is informational text only
  (no new route). Proven against fixture data (unit tests + a real, non-skipped
  `tests/e2e/v2-structured-results.spec.ts` whose fixture fabricates frames for all six statuses),
  not against live production data. User approved raising `LOCAL_UI_THRESHOLDS.uiGzipBytes` 20 -> 21
  KiB. Also fixed a pre-existing time bomb: `v2-clarification-route.test.ts`'s T14-E cookie expiry was
  computed from the suite's fixed clock while `verifySessionCookie` checks the real wall clock.
  Flagged for the T14-T16 gate: `chatResultToPresentation` still populates no facts/references/recovery
  and titles from the raw action id; `diagnostic.byteLength` counted UTF-16 units against a UTF-8
  refine (fixed at source in Task 16). Gate: 173 focused + e2e grep 15 + v2-structured-results 21
  (3 browsers) + `perf:local-ui` PASSED (20,741/21,504) + verify green (329/5046). Live: `not_run`.
  Next: `T16-A`.
- **Task 16 CLOSED (T16-A..G):** narrow services + transport-only routes. T16-A/B froze the contracts
  (strict `runScopeSchema` with every security field required, `StartRunInput`/`ResumeRunInput`,
  `uuidIdSchema`, type-only cross-boundary DTOs in `src/shared/contracts.ts` pinned type-only by
  asserting an EMPTY runtime module namespace, dead `RunnerDependencies.eventStore` removed) and
  pinned `RunEventService` as named-composite-transitions-only with payload validation before any
  store write plus the provider-attempt-2 same-logical-call budget rule. T16-C extracted the runner
  **634 -> 202 lines** (`run-service.ts`, `api-discovery-service.ts`, `action-execution-service.ts`;
  verbatim ports, parity gate green). T16-D/E added history / session-context / permission / metrics /
  artifact / undo services. **Permission confirm is token-only:** preview mints a 5-minute HMAC token
  bound to workspace+admin+session + the current policy hash + the exact patch; confirm accepts ONLY
  `{previewToken}` (a groups object 400s), authority recheck still runs BEFORE body decode, and
  applying a patch changes the base hash so replay fails closed as `stale_preview`; the UI does
  preview->confirm internally (+61 bytes gzip). T16-F/G split `routes/api.ts` **1049 -> 309 lines**
  (composition root only) into 11 transport-only route files, each under 250 lines, each
  decode -> authorize -> one service call -> encode, with store access only through injected scoped
  ports. New gates: `v2-layer-boundaries` (forbidden-layer runtime imports per route file),
  `v2-route-parity` (literal body fixtures incl. every not-found/invalid-decode branch), `me-route`
  (no token/session leakage). Also fixed the T15-E-flagged `byteLength` UTF-16-vs-UTF-8 mismatch at
  its source. Gate: 117 focused + cycles 0 + lint 0 + verify green (333/5096) + `perf:local-ui` +
  `onboarding-keyboard.spec.ts` 9/9. Counts unchanged. Live: `not_run`. Next: T14-T16 review gate.
- **T14-T16 independent review gate CLOSED:** one independent read-only review of the frozen
  `b56ad80..2971645` diff (13 commits, 108 files — all of T14-A..T16-G) covering reference/
  clarification IDOR, structured truth, service boundaries, the new permission preview token, XSS,
  accessibility, import cycles/layering, and the previously flagged gaps. Clean confirmations on IDOR
  (every id-bearing lookup resolves through the full scope tuple with indistinguishable 404s), the
  permission-token design (domain-separated HMAC, timing-safe compare, scope + base-policy-hash + TTL
  binding), XSS (textContent-only throughout), accessibility, and the byteLength fix. **Two HIGH + one
  MEDIUM accepted and remediated in `102ced4`:** (HIGH-1) a run durably suspended
  `awaiting_clarification` with NO live `pending_clarifications` row permanently bricked its session —
  the supersession branch silently no-opped and every later turn tripped
  `idx_assistant_runs_one_active_per_session` into a 500; fixed with an `else` arm that fails the
  orphaned run (`clarification_missing`) before a new run is minted, pinned by an HTTP regression
  test. (HIGH-2) a `denied` write preparation fell through `prepareWrites` with no event at all — now
  journaled as one `tool.denied` per call with the denial code, and the dormant clarify -> "succeeded"
  hydration mapping fixed at source (clarify -> `failed` + `clarification_required` warning).
  (MEDIUM) the layer-boundary gate now also rejects re-exports and dynamic `import("...")` of
  forbidden layers. Re-review: ADDRESSED / ADDRESSED / ADDRESSED, "no unrecovered HIGH remains at
  HEAD". Residual non-blocking observation: in the generation-mismatch corner of the new recovery arm
  a real dangling clarification row is left to its 5-minute TTL instead of an explicit cancel (audit
  hygiene only). **Recorded v2-cutover blocker — now CLOSED by CP-A/CP-B/CP-C below:**
  `read-execution.ts` had no runtime producer of clarification rows, so live v2 read clarifications
  could not be resolved end to end and `tests/e2e/v2-clarification.spec.ts` stayed skipped. Gate:
  remediation vitest files + verify green (333/5099). Live: `not_run`. Next: `T17-A` (superseded by
  slice `CP`).
- **CP-A CLOSED:** `read-execution.ts` is the ONE runtime producer of `pending_clarifications` rows
  (the recorded v2-cutover blocker): the clarify branch persists the question as a canonical
  `action_results` row, creates the durable row, and returns
  `{kind:"clarification", clarificationId, actionResultId}`. New named transition
  `clarification.required` (`requireClarificationWithEvent` / `RunEventService.requireClarification`,
  `NAMED_TRANSITIONS` 13) is emitted AFTER `state.continuation` is set and before `suspendRun`, which
  still solely owns the phase. Reads-port scope widened to `RunScope & {runId}` everywhere. Owner
  authorized three scope-widening fixes for plan-vs-code contradictions: an optional `field?: string`
  on the clarify `ActionResult` (12 single-slot read call sites pass the exact argument key; the inert
  `"selection"` fallback stays for the 13 no-single-argument sites, which resolve by free-text
  continuation only); a `clarification_already_active` catch that returns the run's existing open
  question (two ambiguous reads in one batch; a re-clarify inside `resolveOption`); and
  `actionResultId` on the `clarification.required` payload so the question text stays in
  `action_results` and the event keeps a bounded link. Gate: 51 focused tests + type-check + lint +
  check:api-action-inventory all exit 0. Counts unchanged. Live: `not_run`. Next: `CP-B`.
- **CP-B CLOSED:** `hydrateAttachment`'s `clarification.required` arm returns the real
  `pending_clarification` attachment — full-scope row load, `pending`/`resolving` only (a settled
  clarification never re-renders as live), question read from the canonical clarify `action_results`
  row the event links to, and display-only candidates (**never `externalId`/`partialArguments`**).
  Fixed the T14-F placeholder it exposed: the clarify bubble rendered `missingField` (`userId`) rather
  than the question; `ui/shared.ts` now renders `attachment.question`, decoded strictly in
  `ui/protocol.ts`. New `tests/integration/v2-clarification-producer.test.ts`: 6 real-HTTP cases —
  durable row + suspension, one journaled event with a leak-free hydrated attachment ordered before
  `run.suspended`, exact-`optionId` resolve running the read with the CHOSEN 24-hex id, settled rows
  losing their attachment, a no-owning-argument date clarify (`candidates: []`/`"selection"`,
  `400 unknown_option`, free-text continuation still works), and two ambiguous reads in one batch
  landing on the run's single open question. Gate: 55 focused + type-check + 71 UI decode/render +
  `perf:local-ui` PASSED (gzip 20,812/21,504). Counts unchanged. Live: `not_run`. Next: `CP-C`.
- **CP-C CLOSED:** `tests/e2e/v2-clarification.spec.ts` un-skipped and implemented; the fixture server
  gained `clarification` / `clarification-resolving` scenarios serving an `awaiting_clarification`
  `activeRun`, a run-events page carrying CP-B's exact attachment shape, and a resolve route that
  rejects anything that is not a stored candidate id (so "submits the id, never the label" is a real
  assertion) and echoes the received id back. Six cases × three browsers: restored question + chips,
  resolve-by-exact-id, one-use chip disabling, reload restoration (rendered exactly once), second-tab
  restoration + resolve, and a `resolving` clarification with every chip disabled. Per-file timeout
  raised to 60s (time budget only — these cases each drive a page load plus durable restoration).
  Gate: `npm run build` + `npx playwright test tests/e2e/v2-clarification.spec.ts` 18/18 across
  Chromium/Firefox/WebKit. **`npm run test:e2e` NOT green here and not claimed as green** — 21/16/7
  Firefox timeouts in untouched spec files across three runs, zero clarification failures; the
  untouched `action-journeys.spec.ts` passes 6/6 in isolation before and after while host load ran
  7.7 → 24.7 on 8 cores, so it is `f1-verify-flake-diagnosis` load starvation. Re-attempt full e2e on
  a quiet machine before any release claim. Counts unchanged. Live: `not_run`. Next: `CP-D`.
- **CP-D CLOSED / slice CP green — the recorded v2-cutover blocker is fixed:** a v2 read that
  clarifies now creates a durable `pending_clarifications` row, journals `clarification.required`
  referencing the canonical clarify `action_results` row, hydrates a display-only attachment, and is
  resolvable by exact `optionId` or answerable with free text. Gate: **`npm run verify` VERIFY_EXIT=0
  (334 files / 5,105 tests, zero flakes)** + `perf:local-ui` PASSED (gzip 20,812/21,504). Docs sync:
  this checkpoint list was three entries behind and now carries T15-E, Task 16, and the T14-T16 review
  gate (condensed to this file's voice, not copied verbatim — the header forbids duplicating
  `CLAUDE.md`); the review-gate blocker paragraph in `CLAUDE.md` now records it CLOSED by
  `7a0e745`/`f168023`/`cb815ba`. **Not closed:** `npm run test:e2e` failed on this host in four
  attempts (21/16/7/20), every failure in an untouched spec file, zero `v2-clarification` failures;
  measured as host load starvation (untouched spec passes 6/6 in isolation either side of a failing
  full run; load 7.6–24.7 on 8 cores). Re-run full e2e on a quiet machine before any release claim.
  Counts unchanged. Live: `not_run`. Default engine: `v1`. Next: `T17-A`.
- **T17-A CLOSED:** `scripts/eval-v2/` derives 127 evaluation cases (43 reads + 84 writes) from
  `MODEL_API_ACTION_CATALOG` plus the shipped `READ_PARITY_FIXTURES`/`WRITE_PREVIEW_FIXTURES` — no
  hand-written per-operation table and no hard-coded count (`tsconfig.scripts.json` already includes
  `tests/helpers/**`, which is what makes derivation the intended design). `case-model.ts` is the one
  derivation; discovery / terminal / write-safety files are projections; `report.ts` is the one report
  builder. 16 terminal cohorts populated (single/multi read 43/40, writes 84, dependent journeys 10,
  clarification 16, references 7, denial 127, auth-class 7, truncation 23, unicode 6, hostile 43, plus
  4 runtime scenarios); write safety = 84 × 9 = 756 checks. Deviations recorded: a shared
  `case-model.ts` (dup gate), `liveCase` left absent until T17-F, runtime cohorts declared as
  scenarios, and a write's terminal state is `pending_confirmation`/`denied`, never "executed". Fixed
  a real defect: the pure query/availability helpers lived in `vitest`-importing modules, so any
  `eval:*` script would have crashed — moved down into the pure fixture modules and re-exported
  (also collapsing the duplicate `discoveryQueriesForWrite`). Gate: 30 focused + 521 with parity
  regression + type-check + type-check:scripts + lint + dup, all 0. Live: `not_run`. Next: `T17-B`.
- **T17-B CLOSED:** `scripts/eval-api-discovery.ts` scores discovery through the REAL runner via a
  shared `scripts/eval-v2/runner-harness.ts` that assembles the same dependency set
  `buildV2RunnerDependencies` builds for a live turn (real runner/discovery index/read port/preparation
  service, fresh fake workspace, throwaway SQLite) and scores only durable
  `api.operations_loaded`/`tool.requested`/terminal-phase evidence — no direct search call, no
  scripted provider, no pre-loaded catalog. Thresholds: 3/3 canonical, ≥2/3 paraphrase, ≥2/3 typo, ≤12
  tools, 0/3 unrelated destructive loads. Harness smoke-verified (12 loaded = the cap, target
  included, read executed, run completed). Without credentials it emits
  `not_evaluated_missing_credentials` with the real 127 case count and exits 2. Note: identity's
  `catalogHash` is the 127-action MODEL_API registry hash (`3872950503…`), legitimately distinct from
  the inventory evidence hash (`fb3c3b5c…`) and the internal registry hash (`d899cc15…`). Gate:
  type-check:scripts + 21 coverage tests + type-check + lint + dup, all 0. Eval:
  `not_evaluated_missing_credentials`. Live: `not_run`. Next: `T17-C`.
- **T17-C CLOSED:** `scripts/eval-assistant-terminal.ts` scores FINAL terminal state across 14 real
  cohorts through the T17-B harness: a write reaching `completed` with the write requested is a
  FAILURE (`write_executed_without_confirmation`) — only `awaiting_confirmation` with zero mutations
  passes; reads must truly execute; denial/auth-class/budget must terminate `failed` unexecuted;
  cancellation uses a pre-aborted signal, budget exhaustion `maxHostCalls: 0`. Strict cohorts 3/3,
  aggregate ≥95%. `partial_outcome`/`unknown_outcome` are DELEGATED (unreachable from a model turn —
  a write stops at the preview) with a machine-readable map naming the suites that prove them, never
  faked. Credential-free: sentinel, 127 cases, 0/0, exit 2. Gate: type-check:scripts + 9 tests + lint,
  all 0. Eval: `not_evaluated_missing_credentials`. Live: `not_run`. Next: `T17-D`.
- **T17-D CLOSED:** write-safety accountant (`scripts/eval-write-safety.ts` +
  `tests/integration/v2-write-safety-matrix.test.ts`): 84 writes × 9 invariants = 756 derived checks,
  proving every write carries every invariant, that the seven shipped domain matrices account for all
  84 (no write covered by nothing), and that a write's expected terminal state is never an executed
  mutation. Aggregation into T13 `V2AuthorityEvidence` is fail-closed with a real test per rejection —
  partial (`invariant_not_observed`), any violation, sentinel/blocked, zero-case, wrong SHA, wrong
  catalog hash all yield `not_evaluated_until_pr15`; only a complete 100% report yields `complete` with
  four `passed` conclusions and all counters 0. Bare script run = blocked status, exit 2. Gate: 49
  tests + type-check + type-check:scripts + lint + dup, all 0. Live: `not_run`. Next: `T17-E`.
- **T17-E CLOSED:** `src/metrics/run-metrics.ts` owns every v2 run-metrics formula; the store gained
  one bounded scoped rows-only primitive (`listRunEventsForMetrics`, limit 10,000) and computes
  nothing; `MetricsService` calls the module so `routes/metrics.ts` stays transport-only. Additive
  `metrics.runs` on `GET /api/metrics`, v1 fields untouched. Denominator is unique
  `(session, run, modelCall)` attempt-1 groups; attempt 2 is the same logical call but a separate
  provider attempt; incomplete calls reported separately. Covers searches, per-run refinements, loaded
  tools + max, cache hits, validation failures by code, repeated argument hashes, abandonment,
  latency p50/p95/max, attempts, calls, clarifications, all four operation stages, tokens, completion
  ratio. Six anomaly codes report corrupt groups instead of normalizing them, each with a failing-input
  test. Absent tokens stay absent (never zero); tests assert no request text, action names, or
  session/run ids in the serialized block, and that another admin's runs are invisible. Gate: 51 tests
  + type-check(+scripts) + lint + cycles 0 + dup, all 0. Live: `not_run`. Next: `T17-F`.
- **T17-F CLOSED (built, NOT executed):** `scripts/live-v2-full.ts` refuses unless all four
  preconditions hold (`LIVE_CLOCKIFY=1`, the literal sacrificial marker — a workspace id is not proof,
  credentials+workspace, explicit cleanup registry) and lists every missing one; verified by running it
  (`refused`, all five failures, exit 2, zero Clockify calls). The registry rejects non-`AIASSIST_V2_`
  names and cleans in reverse dependency order; the report passes only with zero leftovers, zero
  preparation mutations, zero trusted-bypass calls and ≥1 prepared AND confirmed write, carrying a
  4-char workspace suffix rather than any id or key. `live-sweep.ts` now sweeps both prefixes through
  one `isSweepableName` predicate + exported `sweepIsClean`/`sweepLeftovers` (a scan failure never
  proves absence). Five npm scripts added. Reverted my own unnecessary workflow change: the sweep step
  stays a direct `npx tsx` call because `workflow-contracts.test.ts` pins it so `timeout --signal=TERM`
  hits the sweep process, not an npm wrapper. Gate: 31 (+36 with workflow contracts) tests +
  type-check:scripts + lint + dup, all 0. No live write ran. Live: `not_run`. Next: `T17-G`.
- **T17-G CLOSED / Task 17 deterministic work CLOSED:** the five npm scripts exist
  (`eval:api-discovery`, `eval:assistant-terminal`, `eval:write-safety`, `live:v2-full`, `live:sweep`).
  `release-evidence.ts` gained `classifyV2Evaluation` + `evaluations`/`v2EvaluationComplete`: a v2
  release conclusion needs complete authority evidence AND three `passed` evaluations (complete, fully
  scored, non-empty, exact-SHA-bound); six tests prove missing → rejected, sentinel → non-passing
  sentinel, partial/zero-denominator/zero-case → rejected, stale SHA → rejected, and sentinel authority
  keeps completion false. All three `eval:*` commands emit `not_evaluated_missing_credentials`, exit 2,
  with real case counts (127/127/84) and 0/0 — the correct credential-free result. Gate: 99 tests +
  three eval commands + `npm run verify` VERIFY_EXIT=0 (340 files / 5,201 tests, zero flakes).
  Remaining blockers: model credentials for the three eval artifacts; `live:v2-full` execution needs
  T18-H; full e2e needs a quiet machine (CP-D). Live: `not_run`. Default engine: `v1`.
  Next: `T18-A` — **operator-blocked, requires new per-step authority.**
- **Pre-T18 review gate CLOSED (with remediation):** two independent read-only reviews of
  `34ea91c..8862d73`. Cleared: the 12 original `field` keys, the injection round-trip, no
  `externalId`/`partialArguments` leak, no re-render of settled clarifications, no IDOR, no vacuous
  pass. Remediated: (HIGH) five missed single-slot READ clarify sites stored `"selection"` with live
  chips — `clockify_invoices_get`/`payments_list`/`export` had a dead button (409 forever); all five now
  pass their exact key. (MEDIUM) the `clarification_already_active` fallback adopted another read's row
  while returning this read's prose — it now returns a truthful `failed: clarification_already_active`.
  (MEDIUM) `isReleasableReport` ignored `caseCount` — reports carry `scoredCaseIds` and require one
  attempt per case. (MEDIUM) `classifyV2Evaluation`'s catalog-hash check was dead — now threaded.
  (MEDIUM) the terminal evaluator graded four undriven cohorts — now `unscoredCohorts`. (MEDIUM)
  orphan-fixture detection added. (LOW) discovery threshold function + false free-pass comment fixed.
  Recorded as T18 entry requirements (not fixed here): Review 2's twelve readiness items, including the
  PRE-EXISTING 9-key `/version` vs 8-key validator mismatch that blocks deploy verification,
  `ASSISTANT_ENGINE`/`DATABASE_PATH` outside the rollback boundary, backups not bound to their source
  database, the runbook's stale schema-v8 assertion, no unused-path proof, and the per-database
  authority history. Gate: 48 + 78 focused + inventory + type-check(+scripts) + lint + cycles 0 + dup +
  `npm run verify` VERIFY_EXIT=0 (340 / 5,203) on the rerun after one documented load flake. Live:
  `not_run`. Default engine: `v1`. Next: `T18-A` — **STOPPED for operator authorization.**
- **A0 CLOSED (three accepted pre-T18 findings fixed, local only):** three commits. (A0-1 `565cc88`)
  `/version.modelConfiguration` emits 9 keys while the deployed-payload validator and both runbooks
  enforced 8 — the documented deploy identity assertion exited 1 on a CORRECT deployment. The shared
  validator is SPLIT, not widened: the frozen 8-key binding check stays byte-identical for v1
  rollback, a new `deployedModelConfiguration()` takes the 9-key deployed schema, and no recorded hash
  changed. It now also asserts the deployed `assistantEngine` equals the intended engine (previously
  unchecked), from `EXPECTED_ASSISTANT_ENGINE`/`SELECTED_ASSISTANT_ENGINE` so T18-F asserts `v2`.
  (A0-2 `ef465ba`) clarification hydration filtered on status alone, so an expired-but-unswept row
  rendered chips that 410 on click; it now mirrors `claimClarificationResolving`'s expiry comparison,
  and the store/app clock skew the guard exposed is fixed. (A0-3 `<this commit>`) `executeReads`
  returned at the first clarification, erasing already-executed later reads from the journal; the
  whole batch is journaled in provider order before the suspension events. A `failed` read outcome
  still has no terminal event — pre-existing, observed not fixed. **A0-4 DEFERRED** (optional, largest
  item, and no terminal report can pass without `LLM_*` credentials anyway). Gate: 83 focused +
  type-check(+scripts) + lint + cycles 0, all exit 0. Live: `not_run`. Default engine: `v1`.
  Next: full `verify`, then `A1` — **BLOCKED on host load for `test:e2e`.**
- **A0 gate CLOSED / A1 PARTIAL:** `verify` exit 0 on `2b26e28` (340 / 5,208, zero flakes), `test:e2e`
  exit 0 (120 passed, three engines) once host load fell from 11.75 to ~3 — CP-D's red e2e really was
  the load artifact. `audit:prod` + `license:prod` exit 0. Pushed; **PR #19 open, NOT merged.**
  `secret-scan` fixed in `627f874` (two AND-scoped gitleaks allowlist entries for a published catalog
  digest and a negative-test credential string; scoping proven adversarially — planted secrets in the
  same files are still reported; exception-count pin 3 -> 5). The required `verify` check fails at
  step 11 (Marketplace media binding) **identically on `main`, red since 21 July**: CI's own
  `npm run verify` step PASSES: step 11 requires all post-`0b1c6794` changes to be evidence-only, and
  a v2 rewrite has 391 non-evidence files. Needs an owner CI decision; rule 5 forbids taking it here.
- **T18-A CLOSED:** deploy transaction proves candidate/rollback/database identity before any Railway
  mutation. `ASSISTANT_ENGINE` + `DATABASE_PATH` are now rollback keys (else a failed upload leaves v1
  code on an empty v2 database with engine v2); staged bytes are rehashed against `RELEASE_SHA` +
  `RELEASE_BUILD_HASH` and a `ROLLBACK_SOURCE_DIR` is required before the first mutation;
  `SELECTED_DATABASE_PATH` (+ `_DISPOSITION`) is proven unused/existing against Railway's own
  snapshot, paired with a fail-closed `StoreOptions.mustExist`; the predeploy gate now binds a backup
  to its `metadata.source`; new `verifyFreshDatabase` verifies a just-created database (fail-closed
  open, current schema, genuinely empty) which the restore verifier structurally cannot; the readiness
  probe takes `assistantEngine`; both runbooks' schema assertions moved 8 -> 12. Gate: 109 focused +
  type-check(+scripts) + lint, exit 0. **No Railway or Clockify call.** Live: `not_run`. Default
  engine: `v1`. Next: `T18-B`.
- **T18-B CLOSED:** `scripts/cutover-transaction.ts` plans all five cutover branches as PURE
  functions (no filesystem, network, or `railway`), so an incident-time rollback is decidable without
  executing it. Preseed refuses a key already serving, an engine other than `v1`, and drift from the
  recorded v1 identity — in that order. Automatic rollback requires a prior value for all eight
  rollback keys (Railway deletes cannot skip a deploy). Quarantine and full-v1 rollback both require a
  recorded signature; full-v1 also refuses to restore v1 code against the v2 database path and returns
  all eight variables plus `clearsStaleInstallation: true`. Post-reinstall failure permits only
  `full_v1_rollback` — authority has already moved to the v2 database. `ROLLBACK_KEYS` is exported
  from the deploy script so both cover the same eight keys. **The stale-active-row attestation case is
  fixed without touching `installations.ts`** (its strictness is deliberate): it deletes the prior
  attestation unconditionally and reinserts only when the row was genuinely absent, so a reinstall
  over a pre-outage restored database leaves an ACTIVE install with NO attestation. New
  `clearStaleInstallationSql` returns attestations-then-installations and rejects an empty or
  quote-bearing id; both statements ship even though the attestation FK cascades, because the cascade
  needs `foreign_keys = ON` and the incident-time `sqlite3` CLI defaults it OFF. New
  [`ADR 003`](./docs/adr/003-cross-database-authority.md) records the denylist, lifecycle `iat`
  watermark, and generation as per-database, so a fresh v2 database has no authority history and a
  rollback discards every v2-era retirement — the reinstall-for-a-fresh-generation mitigation is a
  **known accepted limitation**, with an explicit window between restore and reinstall. Gate: 84
  focused + type-check(+scripts) + lint + **`verify` exit 0 (341 / 5,235, zero flakes)**. **No Railway
  or Clockify call.** Live: `not_run`. Default engine: `v1`. Next: `B2` — owner CI/merge decision.
- **B2 CLOSED (CI step 11 + 12 gated on candidate applicability):** the required `verify` job carries
  **two** v1-candidate-frozen evidence gates, not one — Marketplace media binding AND the DeepSeek
  benchmark validation. Both bind to frozen candidate `0b1c6794` and require every later change to be
  evidence-only, so both are unpassable on a v2 branch; CI only reported the first because the job died
  there. Removing one would have moved the failure down a line, so both are now gated on
  `scripts/evidence/v1-candidate-build.ts`, which decides **applicability only** — when it reports
  `true` both gates run unchanged at full strength. It imports the path rule from the gate itself so
  the two cannot drift, prints only `true`/`false`, and exits **nonzero** on any error rather than
  reporting `false`; `--is-ancestor` is read by exit status so a real git failure rethrows instead of
  being read as "not an ancestor". The CI step allowlists the value before writing `$GITHUB_OUTPUT`
  (also blocking output injection); no untrusted event input is interpolated. Proven empirically:
  `false` here (401 non-evidence) and on `origin/main` `d0f29bc` (22), so **`main` goes green**;
  `true` at the real v1 evidence commit `bbd4c29`, where the DeepSeek gate still **passes**.
  Recorded, not fixed: the media gate fails at `bbd4c29` for a separate pre-existing reason, and
  `0b1c6794` is not itself a candidate build because the binding checked in there names the previous
  candidate. `workflow-contracts` pins both conditions; non-vacuity proven by mutation. Gate: 12
  focused + `actionlint` 1.7.12 exit 0 + type-check(+scripts) + lint + **`verify` exit 0
  (342 / 5,242)**. **Nothing pushed, PR #19 not merged, no Railway or Clockify call.** Live:
  `not_run`. Default engine: `v1`. Next: owner push grant, then `B3`.
- **GATE 0 CLOSED:** node `v22.23.1`, Railway CLI exactly `5.27.0`, expected HEAD, clean worktree;
  `railway whoami` exit 0 (stored token had nominally expired, CLI refreshed it). Three findings
  carried forward: `D6` cannot run as printed because `LIVE_SACRIFICIAL_WORKSPACE_MARKER` and
  `LIVE_V2_CLEANUP_REGISTRY_PATH` are absent (`live-v2-full` refuses, exit 2) though
  `LIVE_WORKSPACE_ID` does match the sacrificial workspace; `eval:*`/`live:*` are bare `tsx` with no
  `--env-file`, so X-I needs `LLM_*` exported into the shell, not just present on disk; and `.env`
  vs `.env.server` name different models (`deepseek-chat`, stale, vs `deepseek-v4-pro`).
- **P1 + P2 CLOSED — candidate on `main`:** five gates exit 0 (`verify` 342 / 5,242; `test:e2e`
  **120 passed**; `audit:prod`; `license:prod`; clean worktree). One documented load-flake
  (`intent-declaration-chat`) cleared by the protocol — isolation 54/54 then a green full rerun. e2e
  refused its first window under competing load rather than run degraded, and passed at load 2.98.
  Pushed `2db1458..95f53a9`; **PR #19 MERGED** as squash `a369e06`. CI proves B2: required `verify`
  passed 3m34s with the probe step `success` and both candidate-frozen gates **`skipped`**, later
  steps continuing to success; `secret-scan` green via the `627f874` allowlist. Squash mints a new
  sha, so tree identity was proven: `main` and `95f53a9` share tree `1e47056c…`, empty diff.
- **D1 CLOSED:** candidate frozen at `a369e06da895be3d161a0c6f29b3ce54115c0084` with a detached
  worktree at that commit. Re-run on the merged candidate, zero flakes: `verify` exit 0
  (342 / 5,242), `check:api-action-inventory` exit 0, `perf:local-ui` PASSED (UI gzip 20,812 /
  21,504). Counts unchanged: `ACTION_CATALOG` 171 · api 127 · composite 24 · generic 16 · local 4;
  catalog hash `fb3c3b5c4787767e6cde921f735f8d5eab55aadde7e5a166aefe0db2a1c75bce`. No Railway or
  Clockify call. Live: `not_run`. Default engine: `v1`. Next: `D2`, then `D3` (§3.1 blocker).
- **D3 CLOSED — cutover deploy bound to the v2 candidate (§3.1 = option (i)):** both runbooks
  (`DEPLOYMENT.md` + `docs/marketplace/03-operations-evidence-rollback-package.md`; the contract
  test loops over both) now capture `BINDING_CANDIDATE_SHA` separately, permit the implicit
  binding-derived `RELEASE_SHA` only when `EXPECTED_ASSISTANT_ENGINE` is `v1`, and refuse a non-v1
  deploy whose `RELEASE_SHA` equals the binding candidate — a guard, so uploading v1 source under
  engine v2 is impossible, not merely warned about. Option (ii) was rejected because a v2 binding
  would mean authoring measured benchmark values we cannot measure without `LLM_*` (rule 10). The
  frozen binding is provably unchanged; `binding.candidate.testedSha` still present and no
  `RELEASE_SHA="$(git rev-parse HEAD)"` introduced. New contract case pins the guard and its
  ordering in both files; non-vacuity proven by mutation, file restored from a copy.
- **D2/D4 constraints discovered in D3:** `PREDEPLOY_EVIDENCE_MAX_AGE_MS` is **one hour** and
  applies to both `backupCreatedAt` and `readinessConfirmedAt`, so D2+D4 are ONE atomic ≤60-minute
  transaction; D3 was run before that window (recorded deviation from printed order — order changed,
  nothing skipped). The restore verifier reads release identity from env but builds from the current
  checkout, and the runbook asserts `RELEASE_SHA == HEAD`, so the deploy candidate is the **D3
  commit**, superseding D1's `a369e06` (D3 compiles nothing, so the artifact is unchanged). A
  v8→v12 migration is supported (`migration: "candidate_private_clone"`), not a failure; production
  v1 is schema **8** with **4 active installations**. `token_backed_read` on the 21 July backup was
  **200, not 401** — but D5's reinstall retires the v1 token, so every pre-reinstall backup fails it
  afterwards: Phase F requires a **post-reinstall** backup.

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
