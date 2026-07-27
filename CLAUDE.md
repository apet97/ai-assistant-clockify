# CLAUDE.md — AI Assistant Add-on

The engineering source of truth for this repo. Read it before changing code.
Companion: `AGENTS.md` (short map), `README.md` (product overview), `DEPLOYMENT.md`,
`PRIVACY.md`.

## Current v2 implementation checkpoint

- T00-A authorized `codex/rewrite-api-agent-v2` at `d0f29bc90c28e42d052db441a414abcb37865681`.
- Tasks 1-3 are complete; the raw extractor preserves 142 independently scope-assigned call sites and the byte-identical 118-shape legacy projection.
- Task 4 is CLOSED at product SHA `6184efa80a95be06020635540185bae01ba1299e` (`fix: resolve atomic API inventory review findings`).
- T04-K classified all 140 definitions as 82 `api`, 23 `composite`, 31 `generic`, and 4 `local` (zero unclassified actions/shapes).
- T04-R1/R2 on `776eb081bcee3e693903d972d8205d69dc1605a9` accepted four findings (material-contract binding; schema maxima; fatal official OpenAPI corroboration; recursive/columnar adapter identity). T04-R3 remediated them; re-reviews on `6184efa80a95be06020635540185bae01ba1299e` returned zero HIGH/MEDIUM (LOW candidates explicitly rejected with evidence).
- Inventory schema/generator version 2 emits `api-catalog.generated.ts`, JSON evidence, and Markdown from one model with catalog hash `7cc50023d83c1517dfc0306b7732db239e4b3b909bffd3e9519e7350dbebaeab`.
- Evidence covers 142 raw call sites / 118 shapes (each site carries `sourceColumn`), repository-owned `evidence/openapi/clockify.official.openapi.yaml` (SHA-256 `044e2d2e3de91325c0ac26ab84dfe676d6a36432d678cced8ea8f37a3a640de2`), canonical official correlations, per-auth availability, material fields plus fingerprinted `normalizedOperationMaterialContract`, presenters, and primary/compensation counts; the audit POST alone records `official_operation_id_missing`.
- Classification and availability are required on every raw definition, participate in fingerprints, and receive no normalization defaults.
- V1 remains the default (`ASSISTANT_ENGINE=v1`). The v2 native-tool runner lives under `src/assistant-v2/runner.ts` with `createV2RunnerPipeline`; read/write Clockify ports wire in Task 9+. V2 never falls through to v1; model resume stays disabled until later tasks.
- Node 22 proof on the repair SHA: focused Task 4 suite 223 passed; full `npm run verify` 272 files / 3,394 tests passed. No live, deployment, or external action ran.
- Task 5 CLOSED: `src/harness/api-catalog.ts` exports `INTERNAL_ACTION_CATALOG`, `MODEL_API_ACTION_CATALOG`, and `LOCAL_ASSISTANT_ACTIONS`. Compatibility identity is `registryId + registry.hash()`. `catalogForModel`/`toolsForModel` require an exact registry; v1 callers pass `INTERNAL_ACTION_CATALOG`. No confirmation discriminator migration (Task 11).
- T06-PROJECTS CLOSED at `61e18157969fb508eaf184a2e5e1c92bf07c8083`: `delete_archived` (`deleteProject`), member hourly/cost rates (`addUsersHourlyRate`/`addUsersCostRate`), `memberships_replace` (`updateMemberships`), closed `estimate_update` (`updateEstimate`).
- T06-TASKS CLOSED at `7b96f12fce1394a96f08eca79672d9021a14451d`: `delete_completed` (`deleteTask`), `status_update`/`assignees_replace`/closed `update` (`updateTask`), bounded `create` (`createTask`), hourly/cost (`setTaskHourlyRate`/`setTaskCostRate`).
- T06-CLIENTS CLOSED at `9880859`: `create_base` (`createClient`), closed `update`/`archive` (`updateClient`), `delete_archived` (`deleteClient`). v1 `clockify_clients_create` and `clockify_clients_delete` stay internal composites.
- T06-TAGS CLOSED at `e87a255`: all five tag operations already exposed as atomic `api` actions in `workflows/tags.ts` — verified, no empty split file.
- T06-ENTRY-READS CLOSED: exact `clockify_entries_list` (`getTimeEntries`) and `clockify_entries_get` (`getTimeEntry`) with server-resolved dates and `truncated` list receipts; `clockify_status`, review-day/week, and work-package convenience stay off MODEL_API. Live: `live_not_run_missing_credentials`.
- T06-ENTRY-UPDATE CLOSED: `clockify_entries_update` (`updateTimeEntry`, GET-then-PUT), existing `clockify_entries_delete`, and bounded `clockify_entries_mark_invoiced` (`updateInvoicedStatus`, max 21 ids); `clockify_fix_entry` stays generic/off MODEL_API.
- T06-REPORTS CLOSED: `clockify_reports_summary` (`generateSummaryReport`), `clockify_reports_detailed` (`generateDetailedReport`), and `clockify_reports_weekly` (`generateWeeklyReport`) with server-resolved date ranges on the reports host; `clockify_period_report` stays composite/off MODEL_API.
- T06-AUDIT CLOSED: `clockify_entity_changes_created`/`updated`/`deleted` (`getCreatedEntityInfo`/`getUpdatedEntityInfo`/`getDeletedEntityInfo`) on the api host; `clockify_audit_logs_search` stays generic with `official_operation_id_missing`; legacy `clockify_entity_changes_list` stays generic/off MODEL_API.
- T06-WORKSPACE CLOSED: `clockify_workspace_get` (`getWorkspaceOfUser`), `clockify_templates_list`/`get` (`getProjects`/`getProject` on project endpoints).
- T06-HOLIDAYS CLOSED: bounded `clockify_holidays_create`/`update` (`createHoliday`/`updateHoliday`, max 8 users + 8 groups); list/in_period/delete stay or promote as before; `clockify_holidays_get` stays composite/off MODEL_API.
- T06-INVOICE CLOSED (READS/CREATE/UPDATE/ITEMS/PAYMENTS/IMPORT): atomic `clockify_invoices_list`/`get`/`export`; `clockify_invoices_items_list` stays generic (embedded GET items); `clockify_invoices_create_base` (minimal POST only); `clockify_invoices_fields_update`/`status_update` (split PUT/PATCH); one-item `items_add`/`items_delete`; atomic `payments_*`; bounded `import_time` (max 19 projectIds, one host POST). v1 `clockify_invoices_create`/`update` stay internal composites. Next: `T06-EXPENSES` category splits.
- T06-EXPENSES RECORDS CLOSED: atomic `clockify_expenses_list`/`get`/`create`/`update`/`delete` plus `clockify_expenses_categories_list`/`create` on MODEL_API (already in `workflows/expenses.ts`). Counts unchanged at `ACTION_CATALOG` 163 / `MODEL_API` 113. Live: `live_not_run_missing_credentials`.
- T06-EXPENSES CATEGORIES CLOSED: split `clockify_expenses_categories_rename` (`updateCategory`), `clockify_expenses_categories_status_update` (`updateExpenseCategoryStatus`), and `clockify_expenses_categories_delete_archived` (`deleteCategory`); v1 `clockify_expenses_categories_update`/`delete` stay internal composites. Counts: `ACTION_CATALOG` 166, `MODEL_API` 116. Live: `live_not_run_missing_credentials`.
- T06-CUSTOM-FIELDS CLOSED: bounded `clockify_custom_fields_create`/`update`/`set_value_project`/`set_value_entry` on MODEL_API; legacy unbounded handlers stay off-catalog; `clockify_custom_fields_get` stays composite/off MODEL_API. Counts: `ACTION_CATALOG` 166, `MODEL_API` 120. Live: `live_not_run_missing_credentials`.
- T06-USERS CLOSED: atomic `clockify_users_invite` (`addUsers`), `clockify_users_deactivate`, and `clockify_users_role_update` (`createUserRole`) verified on MODEL_API. Live: `live_not_run_missing_credentials`.
- T06-GROUPS CLOSED: atomic `clockify_groups_create`/`update`/`delete` and `clockify_groups_remove_user` verified on MODEL_API; `clockify_groups_get` stays composite/off MODEL_API. Live: `live_not_run_missing_credentials`.
- T06-GROUP-MEMBERSHIP CLOSED: atomic `clockify_groups_add_member` (`addUser`, one userId per call); v1 `clockify_groups_add_user` stays internal composite (up to 14). Counts: `ACTION_CATALOG` 167, `MODEL_API` 121. Live: `live_not_run_missing_credentials`.
- T06-TIME-OFF-POLICIES CLOSED at `c3274dc`: bounded `clockify_time_off_policies_create`/`update` (`createTimeOffPolicy`/`updateTimeOffPolicy`, max 8 users + 8 groups); list/get/archive stay atomic; `clockify_time_off_policies_get` stays composite/off MODEL_API. Live: `live_not_run_missing_credentials`.
- T06-TIME-OFF-REQUESTS CLOSED at `1a5fa1a`: unit-specific `clockify_time_off_requests_create_days`/`create_hours` (`createTimeOffRequest` with closed DAYS/HOURS bodies); v1 `clockify_time_off_requests_create` stays generic/internal; list/delete stay atomic; `clockify_time_off_requests_get` stays composite/off MODEL_API. Counts: `ACTION_CATALOG` 169, `MODEL_API` 124. Live: `live_not_run_missing_credentials`.
- T06-TIME-OFF-BALANCE CLOSED at `577eeb6`: bounded `clockify_time_off_balance_update` (`updateTimeOffBalance`, max 8 userIds); `clockify_time_off_balance_get` stays atomic. Counts: `MODEL_API` 125. Live: `live_not_run_missing_credentials`.
- T06-APPROVALS CLOSED at `f3f2d59`: single-request `clockify_approvals_list`/`submit`/`approve`/`reject`/`withdraw`/`resubmit` verified on MODEL_API; `clockify_approvals_get` and `clockify_approvals_approve_pending` stay composite/off MODEL_API. Live: `live_not_run_missing_credentials`.
- T06-SCHEDULING-ASSIGNMENTS CLOSED at `3a55ffa`: assignment list/create/update/delete verified on MODEL_API; `clockify_scheduling_assignments_get` stays composite/off MODEL_API. Live: `live_not_run_missing_credentials`.
- T06-SCHEDULING-TOTALS CLOSED at `af7797d`: split `clockify_scheduling_project_totals_all` (`getFilteredProjectTotals`, POST) and `clockify_scheduling_project_totals_one` (`getProjectTotalsForSingleProject`, GET); `clockify_scheduling_user_totals` stays atomic; v1 `clockify_scheduling_project_totals` stays generic/off MODEL_API. Counts: `ACTION_CATALOG` 171, `MODEL_API` 127. Live: `live_not_run_missing_credentials`.
- T06-SCHEDULING-PUBLISH CLOSED at `b66e140`: `clockify_scheduling_publish` (`publishAssignments`, one PUT primary) verified on MODEL_API with optional `userFilter`. Live: `live_not_run_missing_credentials`.
- **Task 6 CLOSED (T06-FINAL):** full inventory/scope/model-registry parity gate green; `ACTION_CATALOG` 171, `MODEL_API` 127, catalog hash `7cc50023d83c1517dfc0306b7732db239e4b3b909bffd3e9519e7350dbebaeab`. Node verify green. Live domains: `live_not_run_missing_credentials`. Next: `T07-A` (deterministic API discovery index).
- **T07-A CLOSED:** pure NFKC/token/trigram discovery index in `src/assistant-v2/discovery/` (`api-text.ts`, `api-index.ts`, `api-search.ts`); field weights 40/30/20/10, exact-name bonus 1000, trigram threshold 0.34, auth pre-filter with unavailable-only notice, max 12. Focused gate: `v2-api-index` + `v2-api-search` + `model-api-catalog` 36 passed. Live: N/A. Next: `T07-B`.
- **T07-B CLOSED:** sole meta-tool `assistant_find_api_operations`, discovery-only `initialV2ToolSet`, `refineLoadedToolSet` (max 12 API + discovery), `validateLoadedToolCall`, startup index injection via `createApp`/`server.ts`; shared schema helper in `harness/tool-schema.ts`. Gate: discovery integration + tools tests + `npm run verify` green (276 files / 3473 tests). Live: N/A. Next: `T08-B`.
- **T08-A CLOSED:** v2 runner contracts in `src/assistant-v2/{state,budgets,protocol,prompt}.ts`; shared `src/assistant/tool-results.ts` (`TOOL_RESULT_MAX_BYTES=24_000`); model client `maxOutputTokens` + `onProviderAttempt`; two-attempt token preflight/reservation. Gate: `v2-budgets`, `v2-run-state`, `tool-result-cap`, model-client, agent-loop tests green. Live: N/A. Next: `T08-B`.
- **T08-B CLOSED:** schema v9 assistant run/link tables, scoped store in `src/db/store/runs.ts`, retention/erasure/restore/orphan wiring; never persists provider reasoning/transcript. Gate: v2-runner-persistence + migration/retention/tombstone tests green. Live: N/A. Next: `T08-C`.
- **T08-C CLOSED:** v2 provider loop in `src/assistant-v2/runner.ts` — atomic completion validation, mixed-discovery-only batches, exact-scope cache seed, max two refinements, fresh system/user prompt only. Gate: v2-runner + budgets/state tests green. Live: N/A. Next: `T08-D`.
- **T08-D CLOSED:** four-worker read pool with provider-order results, ordered write preparation only (no host mutation dispatch), persisted host-call allowance via `withHostCallBudgetFromUsed`. Gate: v2 concurrency/cancellation/runner tests green. Live: N/A. Next: `T08-E`.
- **T08-E CLOSED / Task 8 green:** durable provider-independent v2 runner (`runAssistantV2`, `createV2RunnerPipeline`); suspension/replay with zero model calls on terminal replay; startup orphan recovery for active assistant runs; `ASSISTANT_ENGINE` default remains v1. Gate: Task 8 Vitest + `npm run verify` green. Live: N/A. Next: `T09-A`.
- **T09-A CLOSED:** schema v10 `run_events` with transactional allowlisted state+event methods, closed Zod payloads, monotonic sequence, cascade/retention/restore ownership. Gate: run-event store/transactionality/migration tests green. Next: `T09-B`.
- **T09-B CLOSED:** scoped `GET /api/runs/:id/events` paging/hydration, non-production inspector, history `activeRun`. Gate: route/restoration/inspector/NDJSON/history tests green. Next: `T09-C`.
- **T09-C CLOSED / Task 9 green:** cursor-safe UI run-event restoration (dedupe, gap paging, reload/second-tab); `ASSISTANT_ENGINE` default remains v1. Gate: Task 9 Vitest + `npm run verify` green. Live: N/A. Next: `T10-A`.
- **T10-A CLOSED:** v2 read execution port (`src/assistant-v2/read-execution.ts`) wired in `v2-chat-pipeline.ts`; generated structure read parity matrix covers all 10 catalog `access:"read"` rows in `work_structure` (projects/tasks/clients/tags/templates list+get). Gate: `v2-read-parity-structure` + Task 6A structure gates + inventory check green. Live: `live_not_run_missing_credentials`. Next: `T10-B`.
- **T10-B CLOSED:** time-entry read parity matrix covers both catalog `time_tracking` reads (`clockify_entries_list`, `clockify_entries_get`) with server date normalization and truncated list receipts. Gate: `v2-read-parity-time` + Task 6B gates + inventory check green. Live: `live_not_run_missing_credentials`. Next: `T10-C`.
- **T10-C CLOSED:** reporting/admin read parity matrix covers all 10 catalog reads in reports/audit/workspace/webhooks groups; addon-unavailable webhook reads stay out of discovery/schemas and deny under addon auth. Gate: `v2-read-parity-reporting` + Task 6C gates + inventory check green. Live: `live_not_run_missing_credentials`. Next: `T10-D`.
- **T10-D CLOSED:** invoice read parity matrix covers all 4 catalog invoice reads (list/get/payments/export); no composite item GET exposure. Gate: `v2-read-parity-invoices` + Task 6D gates + inventory check green. Live: `live_not_run_missing_credentials`. Next: `T10-E`.
- **T10-E CLOSED:** expense/custom-field read parity matrix covers all 4 catalog reads with nested expense envelope and truncated list truth preserved. Gate: `v2-read-parity-expenses` + Task 6E gates + inventory check green. Live: `live_not_run_missing_credentials`. Next: `T10-F`.
- **T10-F CLOSED:** user/group read parity matrix covers both catalog `users_groups` reads (`clockify_users_list`, `clockify_groups_list`). Gate: `v2-read-parity-users` + Task 6F gates + inventory check green. Live: `live_not_run_missing_credentials`. Next: `T10-G`.
- **T10-G CLOSED:** leave/approval/scheduling read parity matrix covers all 11 catalog reads across `time_off_approvals`, `scheduling`, and `approvals`; no list/find GET-one wrappers. Gate: `v2-read-parity-leave` + Task 6G gates + inventory check green. Live: `live_not_run_missing_credentials`. Next: `T10-H`.
- **T10-H CLOSED / Task 10 green:** all 43 `MODEL_API_ACTION_CATALOG` rows with `apiOperation.access === "read"` covered by seven generated domain matrices (structure 10, time 2, reporting 10, invoices 4, expenses 4, users 2, leave 11); catalog hash `f79307bc42bf82b07a9bfbe33003706a0454000580f269a0a4e0e3e604de3e3b`; v1/v2 semantic receipt parity on identical fakes; `ASSISTANT_ENGINE` default remains v1. Gate: full Task 10 exit Vitest + inventory + `npm run verify` green (304 files / 3919 tests). Live: `live_not_run_missing_credentials`. Next: `T11-A`.
- **T11-A CLOSED:** schema v11 adds closed origin/registry/authority/executor discriminators on pending confirmations and operation runs, exact-batch tables (`confirmation_batches`, `confirmation_batch_items`), scoped composite FKs, matrix triggers, v1 capability-linked backfill (`intent_capability_v1` + `legacy_v1`), and the confirmation-batch store with ordered tuple hashing. Missing discriminator fails closed; no action-name inference. Gate: confirmation-batches + migration + retention + restore + terminal-scrub tests green. Live: `live_not_run_missing_credentials`. Next: `T11-B`.
- **T11-B CLOSED:** `prepared-write-presentation.ts` registers pure formatters/presenters at model-catalog startup, mechanically expands reviewed `materialFields` (`value|array_item|dictionary_entry`, RFC6901, schema maxima, 22 material + 2 public facts), and gates every prepared preview with exact fact/provenance/formatter coverage — no truncation (`presentation_limit_exceeded`). Provenance is presentation/evidence only, never authority. Fingerprints/inventory include `presentationRulesVersion`. Gate: v2-prepared-write + strict-args + target-snapshots + model-catalog + inventory tests green. Live: `live_not_run_missing_credentials`. Next: `T11-C`.
- **T11-C CLOSED:** `OperationPreparationService` + `executeV2ApiAction` prepare every assistant-origin v2 write with zero host mutations: strict raw-args gate (no v1 capability), single-primary mutation plan + write-authority validation, presentation gate, atomic run-budget host reservation, and persisted operation/plan/targets/provenance/discriminator rows + `operation.prepared` events. Legacy `executeAction` safe-write immediate execution unchanged. Gate: v2-preview-first-matrix + v2-prepared-write + risky-preview + safe-writes + safe-write-audit + mutation-workflow + verified-mutation-step tests green. Live: `live_not_run_missing_credentials`. Next: `T11-D`.
- **T11-D CLOSED:** `ConfirmationService` is the sole assistant-write dispatch seam for v2 previews (`confirmSingle` executes stored `prepared_safe_write`/`risky_commit` only — no re-prepare/re-resolve), trusted direct safe writes require explicit origins, and undo commits use the closed `direct_ui`/`v2-local`/`undo_v2`/`undo_commit` discriminator. Single-confirm rejects batch-owned previews; batch confirm remains stubbed for T11-E. Gate: v2-preview-first-matrix confirm coverage + role-recheck + idempotency-race + terminal-scrub + undo tests green. Live: `live_not_run_missing_credentials`. Next: `T11-E`.
- **T11-E CLOSED:** exact batch confirmation with one transactional ownership claim before dispatch; single confirm rejects batch-owned members; replay validates nonce only for pending items; definitive failure may continue independent items; unknown stops later dispatch; crash recovery returns never-dispatched `executing` batches to `pending`. Route confirms against model-API catalog hash. Gate: confirmation-batches + v2-confirmation-batch + terminal-scrub + mutation-workflow green. Live: `live_not_run_missing_credentials`. Next: `T11-F`.
- **T11-F CLOSED / Task 11 green:** Task 11 exit Vitest block + `check:api-action-inventory` + `npm run verify` green; zero preparation mutations, exact presentation, one-primary confirmation, reservation accounting, batch truthfulness; `ASSISTANT_ENGINE` default remains v1. Live: `live_not_run_missing_credentials`. Next: `T12-A`.
- **T12-A CLOSED:** structure write parity matrix covers all 17 `work_structure` model-API writes (discovery/schema/policy/role/typed-consent/zero-prep-mutation/one-primary confirm/replay/concurrent/Unicode); `OperationPreparationService` surfaces `policy_denied`/`unavailable_for_auth_class` as `denied`; fake `archiveClientAtomic` no longer double-counts. Gate: structure write matrix + structure durable/domain/v2-structure actions + preview-first + inventory green. Live: `live_not_run_missing_credentials`. Next: `T12-B`.
- **T12-B CLOSED:** time write parity matrix for all `time_tracking` writes; preparation enforces auth-class availability before preview; Atomic-aware mutation counting; preview-first uses `api_key` when addon-unavailable. Gate: time + preview-first + inventory green. Live: `live_not_run_missing_credentials`. Next: `T12-C`.
- **T12-C CLOSED:** reporting/admin write parity (`reports`/`audit_log`/`workspace_settings`/`webhooks`); addon-unavailable webhook writes denied on addon and confirmed via `api_key`. Gate: reporting write matrix + preview-first + inventory green. Live: `live_not_run_missing_credentials`. Next: `T12-D`.
- **T12-D CLOSED:** invoice write parity matrix (incl. rates under invoices group); payment delete fixture uses `invoiceId`. Gate: invoices write matrix + preview-first + inventory green. Live: `live_not_run_missing_credentials`. Next: `T12-E`.
- **T12-E CLOSED:** expense and custom-field write parity; archived category delete fixture seeds `archived: true`. Gate: expenses write matrix + preview-first + inventory green. Live: `live_not_run_missing_credentials`. Next: `T12-F`.
- **T12-F CLOSED:** user/group write parity matrix. Gate: users write matrix + preview-first + inventory green. Live: `live_not_run_missing_credentials`. Next: `T12-G`.
- **T12-G CLOSED:** leave/approval/scheduling write parity matrix. Gate: leave write matrix + preview-first + inventory green. Live: `live_not_run_missing_credentials`. Next: `T12-H`.
- **T12-H CLOSED / Task 12 green:** compound journeys prove dependent writes need separate confirmations + canonical prerequisite results; independent existing-target Confirm-all batches; truthful prepare/confirm failure without semantic success; seven write matrices + preview-first + inventory + verify green; `ASSISTANT_ENGINE` default remains v1. Live: `live_not_run_missing_credentials`. Next: `T13-A`.
- **T13-A CLOSED:** proved the v2 prepare→confirm path is capability-free — a real `tests/integration/v2-no-intent-declaration.test.ts` drives one complete `clockify_tags_create` prepare→confirm through `OperationPreparationService`/`ConfirmationService` against a real store and spies on `declareIntentCapability` plus `createIntentCapability`/`bindIntentCapabilityOperation`/`consumeIntentCapabilityExecution`/`consumeIntentCapabilityForOperation`/`getIntentCapabilityForOperation` — all zero calls; confirms the stored `OperationRun.authorityModel === "preview_confirmation_v2"` with no `capabilityId`/`capabilityHash`. Test passed immediately at the T12-H baseline (no production change needed). Gate: `npx vitest run tests/integration/v2-no-intent-declaration.test.ts tests/integration/intent-declaration-chat.test.ts tests/unit/intent-declaration.test.ts tests/unit/intent-capability.test.ts` (228 passed) + `npm run type-check` exit 0. Counts: unchanged. Live: `live_not_run_missing_credentials`. Default engine: `v1`. Next: `T13-B`.
- **T13-B CLOSED:** hostile-data, typed-consent, and confirmation-authority proof, all passing immediately (no production change). `v2-prompt-injection-write.test.ts` drives the real `runAssistantV2` runner against a real store/fake workspace where a Clockify project name embeds an injected delete-everything instruction; even after a scripted model "follows" it into a write tool call, the run only suspends `awaiting_confirmation` with zero mutation calls, and the preview is never confirmed. `v2-typed-consent.test.ts` feeds 12 typed-consent-shaped strings (`yes`/`Yes`/`YES`/`confirm`/`do it`/exact button label/whitespace variants/Cyrillic and full-width Unicode lookalikes/empty string) as the confirmation **nonce** — v2 has no natural-language confirm path, so every case is rejected `invalid_confirmation` with zero dispatch. `v2-confirmation-authority.test.ts` covers 12 real rejection gates on `ConfirmationService.confirmSingle`: wrong role (`admin_required`), denied policy (`policy_denied`), stale installation generation (`installation_changed`), stale target snapshot (`stale_target`, via a mutated fake client after `clockify_clients_archive` preview), wrong nonce, tampered action fingerprint, wrong registry ID, wrong catalog hash, tampered operation payload (`operation_mismatch`), non-`prepared` operation journal (`operation_not_prepared`), confirmation replay (`not_pending`), and no auto-retry after an `outcome_unknown` settlement. Mutation-plan tampering was investigated and found not to be an independently reachable boundary at this layer (the confirmation record is DB-fetched by id only, never client-supplied) — folded into the operation-payload-tamper case rather than fabricated. Gate: `npx vitest run tests/integration/v2-prompt-injection-write.test.ts tests/integration/v2-typed-consent.test.ts tests/integration/v2-confirmation-authority.test.ts tests/integration/v2-preview-first-matrix.test.ts tests/unit/write-authority-literal-aliases.test.ts` (119 passed) + `npm run type-check` exit 0. Counts: unchanged. Live: `live_not_run_missing_credentials`. Default engine: `v1`. Next: `T13-C`.
- **T13-C CLOSED / Task 13 green:** `scripts/evidence/v2-authority-evidence.ts` implements the exact `V2AuthorityEvidence` schema (`schemaVersion:1`, `engine:"v2"`, `registryId:"v2-api"`, full-40-hex `candidateSha`, full-64-hex `catalogHash`, nonzero `assistantWriteCases`, `assistantWritesPreviewOnly:true`, and eight fields pinned to `0`) plus the four exact derived conclusions (`all_assistant_writes_preview_only`/`exact_operation_binding`/`zero_mutation_before_confirmation`/`prompt_injection_drafts_cannot_execute`) and the `not_evaluated_until_pr15` sentinel used through Task 16. `release-evidence.ts` re-exports it and adds `buildV2ReleaseEvidence` alongside the untouched v1/DeepSeek `buildReleaseEvidence`/`classifyHistoricalV1Evidence` path. `release-evidence.yml`'s checkout-free `record` job gained an inline (no `npx tsx`, matching its existing no-checkout contract pinned by `workflow-contracts.test.ts`) step that writes the same sentinel and uploads it as a separate `release-v2-authority-evidence-<run>` artifact. `release-candidate.md` gained one paragraph pointing at the new schema/sentinel without adding fabricated v2 rows to the historical v1 template. 21 schema unit tests cover every required rejection (stale SHA, stale catalog hash, zero cases, each nonzero mutation/dispatch/mismatch/capability field, wrong schema version, wrong engine/registryId, and the legacy structured-intent-span field) plus the sentinel/complete report paths and a defensive re-check inside `deriveV2AuthorityConclusions`. Gate: `npx vitest run tests/unit/v2-authority-evidence.test.ts tests/unit/release-evidence.test.ts` (36 passed) + `npm run type-check`/`type-check:scripts` exit 0 + `npm run verify` green (321 files / 4882 tests; one `agentic-chat.test.ts` flake reproduced only under full-verify load, confirmed pre-existing and unrelated — passes in isolation and on rerun, matches the documented `f1-verify-flake-diagnosis` pattern). Counts: unchanged. Live: `live_not_run_missing_credentials`. Default engine: `v1`. Next: `T13` independent review gate, then `T14-A`.
- **T13 independent review gate CLOSED:** two independent read-only reviews (scoped to the T12-H..T13-C diff, `190f0e8..2d7bcbd`, i.e. the three new T13 test-only commits — Tasks 11/12 already carried their own prior review closures): one on authority/confirmation safety, one on evidence integrity and v1/v2 coexistence. Both returned zero HIGH findings. One MEDIUM finding accepted (confirmation-authority tampered-record cases overstate external-attacker reachability — `src/routes/api.ts` always refetches the confirmation record fresh from the store before calling `confirmSingle`, so a client can never supply that object; the tests genuinely lock `confirmSingle`'s own defense-in-depth checks, just not an externally reachable path) — remediated in one focused commit `b56ad80` (doc/rename-only, zero assertion changes), reran the affected test file plus full `npm run verify` (321/4882 green), obtained a scoped re-review confirming ADDRESSED with no new findings. Next: `T14-A`.
- **T14-A CLOSED:** schema v12 adds `entity_references` (grounded per-session entity sightings, upserted in place on re-sighting, CASCADE from `assistant_runs`) and `pending_clarifications` (exact-choice clarification state machine — `pending` (one active per run, unique partial index) → `resolving` → one terminal status; a bidirectional SQL CHECK enforces the exact selection/reason/result/operation/timestamp tuple per status, and BEFORE INSERT/UPDATE triggers reject any terminal row whose `partial_arguments_json`/`candidates_json` were not scrubbed to `{}`/`[]`). New store modules `src/db/store/entity-references.ts` (`upsertEntityReference`/`getEntityReference`/`listRecentActiveEntityReferences`/`markEntityReferenceStatus`) and `src/db/store/pending-clarifications.ts` (`createPendingClarification`/`claimClarificationResolving`/`resetClarificationToPending`/`resolveClarificationWithOption`/`cancelClarification`/`continueClarificationWithFreeText`, five-minute TTL) are schema/store-only — no resolver, route, or runner wiring yet (T14-B onward). Wired into retention (lazy `pending`→`expired` sweep + 30-day terminal-row/90-day reference pruning, FK-safe ordering ahead of `operation_runs`/`action_results`) and uninstall erasure (`EraseCounts.entityReferences`/`pendingClarifications`). Gate: `npx vitest run tests/unit/pending-clarifications.test.ts tests/unit/entity-references.test.ts tests/unit/db-migration.test.ts tests/unit/store-retention.test.ts tests/unit/deletion-tombstones.test.ts tests/unit/restore-verification.test.ts` (91 passed) + `npm run type-check` + `npm run lint` exit 0. Counts: `ACTION_CATALOG`/`MODEL_API` unchanged (no catalog metadata touched). Live: `live_not_run_missing_credentials`. Default engine: `v1`. Next: `T14-B`.
- **T14-B CLOSED:** `ReferenceSelectorMetadata`/`ReferenceSelectorBinding` (`src/harness/api-operation.ts`) — reviewed `externalId`/`scope.projectId` bindings to RFC 6901 raw-argument pointer paths, threaded through `apiActionMetadataFields`. `normalizeRegistryAction` gained `normalizeReferenceSelector` (mirrors `normalizePresentation`): validates entity type, nonempty unique-field bindings, RFC 6901 pointers, and fails closed with `unexpected_reference_selector` outside `api` exposure (referenceId only ever reaches the v2 model-facing tool schema). `actionFingerprintContract` (`src/harness/catalog.ts`) includes `referenceSelector` — this changes every action's fingerprint/catalog hash exactly like T11-B's `presentation` did (old `0742474f…`, new recorded in `evidence/api-action-inventory.json`). `src/harness/tool-schema.ts` adds the one shared `actionParametersSchemaWithReference` helper (optional `referenceId` string property, added only when `referenceSelector` is present) wired solely into `discoveryToolsForLoadedSet`/`toolsForV2LoadedSet` — v1's `toolsForModel` is untouched, so v1 never sees `referenceId`. New pure resolver `src/assistant-v2/references/entity-reference.ts` (`resolveEntityReference`) implements resolution-order steps 1-4/7 (scope+status+entity-type load, explicit-id equality fails closed on conflict, inject reviewed binding values, strip `referenceId` before Zod) — steps 5/6/8/9 (narrowing-only authority, fresh Clockify lookup, post-outcome status transitions, bounded discovery context) are explicitly deferred to T14-D/T14-C by design. Corrected T14-A's `entity_references.bindings` shape from action-metadata-shaped `{referenceField,argumentPath}` to per-instance captured scope VALUES `{field,value}` (e.g. a task's parent `projectId`) — the metadata/instance distinction the canonical plan draws between action `ReferenceSelectorMetadata` and a stored `EntityReference`'s own bindings; no schema/migration change needed (`bindings_json` stayed free-form). **Zero domains registered** (T14-C's job) — no real action carries `referenceSelector` yet. Fixed three pre-existing tests that hard-coded schema `userVersion: 11` (now `LATEST_SCHEMA_VERSION`, a T14-A gap the T14-A gate list didn't cover) and three fingerprint-recompute tests that independently rebuild `actionFingerprintContract`'s shape. Gate: 28 entity-references tests + `check:api-action-inventory` + full `npm run verify` green (323 files / 4928 tests). Live: `live_not_run_missing_credentials`. Default engine: `v1`. Next: `T14-C`.
- **T14-C CLOSED:** attached `referenceSelector` to exactly seven real `api`-exposed atomic write actions, one per domain — `clockify_projects_delete_archived` (externalId→`/id`), `clockify_clients_delete_archived` (externalId→`/id`), `clockify_tasks_delete_completed` (externalId→`/id`, scope.projectId→`/projectId`), `clockify_tags_delete` (externalId→`/id`), `clockify_users_deactivate` (externalId→`/userId`), `clockify_invoices_delete` (externalId→`/id`), `clockify_expenses_delete` (externalId→`/id`). Each is a plain sibling literal on the existing `defineRiskyAction`/`defineAction` call site (no metadata-builder-file changes) — proving referenceSelector attachment needs no `apiActionMetadataFields`-callsite change, just a field on the definition object `normalizeRegistryAction` already reads. Deliberately used the atomic `_delete_archived`/`_delete_completed`/`_delete` variants, never the v1-internal composite `clockify_projects_delete`/`clockify_tasks_delete`/`clockify_clients_delete` (those stay off MODEL_API and would be rejected — `referenceSelector` requires `apiExposure:"api"`). New `tests/integration/v2-reference-followup.test.ts`: one table row per domain (real `createFakeWorkspace` seed → constructed `EntityReference` matching it → `resolveEntityReference` → the resolved args pass the REAL action's Zod schema → the real action's `.handler(ctx, args)` returns a `"preview"` result with the expected target id) — no runner/route/pipeline wiring touched (that's T14-D's "v2 runner/service wiring" modify-list item; nothing calls the resolver at runtime yet). Gate: 38 tests + `check:api-action-inventory` + full `npm run verify` green (324 files / 4938 tests). Live: `live_not_run_missing_credentials`. Default engine: `v1`. Next: `T14-D`.
- **T14-D CLOSED:** `POST /api/clarifications/:id/resolve` (`src/routes/clarifications.ts`, strict `{optionId}` body) is the sole exact-option-resolution route: transactionally claims `pending -> resolving`, matches `optionId` against stored candidates only (never the label), reconstructs the stored strict partial arguments plus the matched candidate's `externalId`, revalidates via the real action's Zod schema, then executes a read (`reads.execute`) or prepares a write (`preparations.prepare` — never dispatches a Clockify mutation) using the same ports `runAssistantV2` itself uses. One new composed store method, `Store.resolveClarificationOption` (`src/db/store.ts`, alongside the existing `startUndoOperation` cross-store transaction), wraps `resolveClarificationWithOption` + `completeToolWithEvent` in ONE `db.transaction()` so the result link, clarification resolution/scrub, run-phase clear, and durable `tool.completed` event commit or roll back together. `src/services/clarification-service.ts` (`createClarificationService`) owns the flow end to end; a prepared write has no `action_result` at prepare time in the existing write-prep path, so the service records a bounded "prepared, pending confirmation" marker via `store.recordActionResult` to satisfy the schema's `action_result_id NOT NULL` FK. `src/routes/v2-chat-pipeline.ts` gained an exported `buildV2RunnerDependencies(deps, installation, scope, signal)` factory (extracted from `executeChatTurn`) so the chat pipeline and the new route build byte-identical `RunnerDependencies`. `src/assistant-v2/runner.ts`: `runAssistantV2` now tracks `resumingExistingRun` (state pre-existed the call) and on the first model call of a resumed invocation builds `resumeSummaries` from `state.completedResults` via the pre-existing `buildResumeUserMessage` (previously never called) — a fresh run's first message stays byte-identical. The route mounts unconditionally on `apiRouter` (same as `runsRouter`; CSRF/rate-limit inherited from existing `router.use` middleware) and derives its run scope server-side only from `getActiveRunForSession` — a client never supplies a runId. Gate: 13 new tests (7 service-level error/state-machine cases incl. concurrent-resolve-one-winner and provider-failure-never-reopens, 3 stale/expired/tampered cases, 3 HTTP transport cases) + full `npm run verify` green (325 files / 4951 tests). **Known gap flagged for the T14-T16 review gate, not owned by any T13-T19 slice:** `src/assistant-v2/read-execution.ts`'s clarify-outcome branch never calls `store.createPendingClarification` — nothing yet creates a clarification row at runtime; T14-D only builds the resolve side. Live: `live_not_run_missing_credentials`. Default engine: `v1`. Next: `T14-E`.
- **T14-E CLOSED:** `chatBodySchema` gained optional `continuationRunId`; `ChatPreconditions`/`ChatPipeline.executeChatTurn` widened with a trailing `continuationRunId` param that v1's implementation (unmodified) structurally ignores — TypeScript accepts a 7-param function where an 8-param type is expected, so v1 stays byte-identical with zero changes to its own function. `v2-chat-pipeline.ts`'s `executeChatTurn` branches: an explicit `continuationRunId` looks up that exact scoped run's `pending` clarification (never an implicit "latest"), then one new transaction — `Store.continueClarificationWithFreeTextAndLink` (mirrors T14-D's `resolveClarificationOption` pattern) — scrubs the clarification to `continued`, inserts the `assistant_run_request_links(kind='free_text_continuation')` row, persists the admin's free text as a normal chat message, and clears the run's suspension, all before `runAssistantV2` resumes with `continuationMessage` set. Absent a `continuationRunId`, an ordinary new message first checks `getActiveRunForSession` (the same unique-active-run guarantee `idx_assistant_runs_one_active_per_session` already enforces): if that run awaits clarification, a second new store method `Store.supersedeClarificationForNewRun` cancels it (`reason:"superseded"`) and fails the run (`code:"clarification_superseded"`) in one transaction before the new run starts; if it awaits confirmation, the turn is refused (`run_awaiting_confirmation`) rather than inventing a confirmation-cancellation path — `RunContinuation`'s `awaiting_operations` arm has no `confirmationIds`, so that plumbing belongs to T16-C/E and isn't authorized here. `runner.ts`: `RunAssistantInput.continuationMessage` (replacing the dead, never-consumed `resumeResultId` field) surfaces admin follow-up text via `buildResumeUserMessage`'s new `adminFollowUp` field, on the first model call of a resumed invocation only. **Two pre-existing bugs found and fixed** by the first-ever real HTTP exercise of the v2 pipeline (no earlier test drove a fresh v2 run through `chatPreconditions` + a native-tool model end to end): `model.completed`'s strict-integer `latencyMs` was fed a fractional `performance.now()` reading (fixed by rounding at the source in `buildV2RunnerDependencies`'s `clock.monotonicMs`); and a fresh v2 run reused the HTTP request's own `requestId` as its `runId`, colliding with `chatPreconditions`'s own `turn_runs` claim on that same id and throwing a raw SQLite UNIQUE-constraint error on every real ordinary v2 chat turn (fixed by always minting an independent `runId` for a fresh run). Gate: 8 new HTTP-level tests (via `createApp`+supertest: continuation success, non-pending rejection, cross-session rejection, duplicate/mismatched replay, both supersession branches) + full `npm run verify` green (325 files / 4958 tests). Live: `live_not_run_missing_credentials`. Default engine: `v1`. Next: `T14-F`.
- **T14-F CLOSED / Task 14 green:** `ClarifyResult` (`src/ui/shared.ts`) gained optional `clarificationId`/`status`, threaded through `attachmentToResults`'s `pending_clarification` branch. `renderClarify` (`src/ui/render.ts`) branches on `clarificationId`: set → chip click calls `deps.resolveOption?.(clarificationId, option.id)`, label never submitted; absent → unchanged v1 `deps.sendText(option.label)`. `actionable = clarificationId === undefined || status === "pending"` gates `disabled` on every chip up front; the click handler still disables the whole row via `querySelectorAll("button")` before dispatching. New `src/ui/api-client.ts` `resolveClarificationOption` (POST `/api/clarifications/:id/resolve`, streamed NDJSON) and `src/ui/composer-flow.ts` `submitClarificationResolve` (mirrors `submitStreaming`'s responsiveness/truthful-preview-buffering contract, never sends a chat message). `main.ts` gained `activeClarificationRunId` state in `renderChat()`'s closure: hydrated from `HistoryResponse.activeRun` on restore (only when `phase === "awaiting_clarification"`), forwarded as `continuationRunId` on the next free-text `sendText`, cleared on new chat, on `resolveOption` settlement, and after a continuation send settles either way (deliberate fail-closed tradeoff: a transient network failure loses the free-text-continuation affordance until the next history refresh, not silently retried). `streamMessage`/`submitStreaming` widened with an optional trailing `continuationRunId`. New `tests/integration/v2-clarification-ui.test.ts` (15 tests: id-vs-label dispatch both directions, resolving-renders-disabled, click-disables-row, hostile-label-with-id-still-dispatches-id-not-label, `applyRunEventAttachment` clarificationId/status mapping, `submitClarificationResolve` responsiveness/error contract) plus extended `ui-render-xss.test.ts` coverage. **NOT covered — three items flagged for the T14-T16 review gate, all traced to the same missing producer:** (1) E2E disconnect/gap-restoration, free-text continuation, page reload, and second-tab coverage — `tests/e2e/v2-clarification.spec.ts` exists (rule 21) but is `test.describe.skip` with a header comment naming the exact reason and un-skip condition; (2) unit coverage of `activeClarificationRunId`'s own lifecycle — it lives inside `renderChat()`'s DOM-bootstrap closure, which that file's own header comment says is "not exercised by unit tests" (`createController`, the tested surface, doesn't expose it); (3) — the root cause of both — `executeV2Read`'s clarify branch (`src/assistant-v2/read-execution.ts`) still never calls `store.createPendingClarification` (flagged since T14-D), so no live path ever produces a real `pending_clarification` to restore, reload, or race against. Gate: 155/155 in the plan's listed vitest files + `test:e2e --grep` 9 passed/9 skipped (Chromium/Firefox/WebKit) + full `npm run verify` green, confirmed via the log's own exit-code line rather than a piped `tail` after an initial run showed 4 unrelated failures (`agentic-chat.test.ts`/`intent-declaration-chat.test.ts`, `expected 400 to be 200`) that passed both in isolation (129/129) and on a full-suite rerun (326 files/4969 tests) — the pre-existing `f1-verify-flake-diagnosis` pattern, not a regression from this slice. Live: `live_not_run_missing_credentials`. Default engine: `v1`. Next: `T15-A`.
- **T15-A through T15-D CLOSED:** the one authoritative v2 result envelope, built as a relocation/
  strictening rather than a new design — `PresentedResult`/`DiagnosticView`/`PresentedResultEnvelope`
  already existed as plain TS interfaces in `src/assistant-v2/events.ts` (a T09 bridge used only by
  `run-event-hydration.ts`'s crude `chatResultToPresentation`, which always emitted empty
  facts/references); T15-A relocates them to `src/assistant-v2/presentation/presented-result.ts` as the
  canonical home with strict `.strict()` Zod schemas at every level (all six statuses, unknown-key
  rejection, the recovery discriminated union, a `.refine()` proving `diagnostic.byteLength` is the
  EXACT UTF-8 length of `value`, canonical bounds reusing Task 11's `PUBLIC_FACT_LIMIT`/
  `TOOL_RESULT_MAX_BYTES` rather than new numbers); `events.ts` now only `import type`s + re-exports so
  every existing import path is unchanged. **Major finding that reframed T15-B onward:** Task 11 already
  registers a mechanical `metadataDrivenPresentPreparedWrite` presenter for EVERY one of the 127
  `MODEL_API_ACTION_CATALOG` actions (both reads and writes) at catalog module-load time, keyed by each
  action's unique `presentation.presenterId` (== `action.name`) — the "exactly one presenter per action"
  requirement was already satisfied by shipped code; `presenter-registry.ts`
  (`requireCompletePresenterCoverage`/`findPresenterCoverageErrors`) adds only the one real gap (Task
  11's own validator silently skips an action with NO `presentation` at all, appropriate for the full
  internal catalog but wrong for the model-facing surface) plus the mechanical
  `PreparedWriteFact[] -> PresentedResult["facts"]` adapter via `toPublicPresentationFacts` (no new
  formatting policy). `result-presentation-service.ts` is the seam: `presentPendingWriteConfirmation`
  renders a real preview via the real registered presenter; `presentReadResult`/
  `sanitizeProviderSummary` give reads a `succeeded`-only status with provider text confined to a
  4,096-byte UTF-8-boundary-safe `summary` (deterministic `summary_truncated` marker on truncation, no
  effect on status/facts/warnings/references — proven by a 6-variant empty/contradictory/hostile/
  oversized/Unicode/absent table test); `assertPreviewTerminalFactParity` proves a confirmed material
  fact can never be dropped or altered at terminal render (response-only additions are fine), verified
  end to end against one real action per domain family (structure=`clockify_clients_create_base`,
  time=`clockify_entries_create`, reporting=`clockify_webhooks_create`,
  invoices=`clockify_invoices_create_base`, expenses=`clockify_custom_fields_create`,
  users=`clockify_projects_memberships_replace`, leave=`clockify_approvals_submit`). **Two scope notes
  flagged for the T14-T16 review gate, same shape as prior flagged gaps:** (1) per-domain read FACT
  population (turning the 43 real reads' actual Clockify response shapes into real `facts` arrays) is
  not built — nothing in `src/` calls `presentReadResult` with real per-domain facts yet; (2) the
  terminal side of write parity is proven mechanically correct given ANY terminal fact list, but wiring
  it to the REAL stored `operation_runs`/`targets`/`provenance` rows is deferred — no route/service
  calls it with real terminal data yet. Read presenter family list frozen live from
  `evidence/api-action-inventory.json`: 43 reads across 13 domains (work_structure 10,
  time_off_approvals 6, scheduling 4, invoices 4, expenses 3, reports 3, audit_log 3, webhooks 3,
  time_tracking 2, users_groups 2, approvals 1, custom_fields 1, workspace_settings 1). Gate: 46 (T15-B)
  + 67 (T15-C) + 19 (T15-D, folded into `presenter-registry.test.ts`) tests green, `check:api-action-
  inventory` exit 0, full `npm run verify` green (329 files / 5036 tests). Live: `live_not_run_missing_
  credentials`. Default engine: `v1`. Next: `T15-E`.
- **T15-E CLOSED / Task 15 green:** structured v2 result rendering, UI-only (no server `src/` file
  touched). `src/ui/protocol.ts` strictly decodes the full `PresentedResultEnvelope` (status/title/
  summary/facts/warnings/references/recovery/diagnostic) instead of the prior stub that hardcoded
  `facts: []`/`warnings: []`/`references: []`; rejects unknown status/recovery-kind/`diagnostic.kind`
  shapes. `src/ui/shared.ts` extends `PreviewResult`/`ReceiptResult` with optional presenter-sourced
  fields (`facts`, `references`, `recovery`, `diagnostic`, `presentedStatus`) rather than a new
  `ChatResult` kind — `attachmentToResults` now forwards them, but keeps emitting `kind: "preview"`/
  `"receipt"` so the existing confirm/cancel mechanics, buffering, and `main.ts` dispatcher are
  byte-identical; a legacy v1 result (no `presentedStatus`) keeps its exact prior ok-boolean-derived
  rendering. `src/ui/render.ts` adds `renderFacts`/`renderReferences`/`renderRecovery` (all
  `textContent`-only) and a `STATUS_VIEW` table giving succeeded/failed/partial/cancelled/
  outcome_unknown their own header label+icon (`pending_confirmation` renders via the existing preview
  card); the technical-details disclosure prefers `diagnostic.value` over the flattened receipt when
  present, and its toggle stays the static "Details" label (never derived from title/action, so it
  can't leak a raw `clockify_*` id into an accessible name). Recovery renders as plain informational
  text only — no new route wired in this slice (matches "render-only"; a `view_operation`/
  `start_new_chat` button was drafted then dropped for the gzip budget, see below). Production's
  `chatResultToPresentation` (`run-event-hydration.ts`) still never populates `facts`/`references`/
  `recovery` for any real domain and still sets `title` to the raw action id/name, not a human label
  — flagged for the T14-T16 review gate, same shape as T15-C/D's scope notes. Also flagged for that
  gate: `envelopeFromActionResult` (`run-event-hydration.ts`) computes `diagnostic.byteLength` as
  `JSON.stringify(result ?? null).length` (UTF-16 code units), while `diagnosticViewSchema`'s own
  `.refine` requires `Buffer.byteLength(..., "utf8")` — for any non-ASCII receipt the two disagree; the
  UI decoder no longer bound-checks `byteLength` at all (dropped with the other redundant client-side
  length bounds), so nothing currently depends on this number being correct, but it should be fixed at
  the source before anything does. T15-E proves the
  decode/render MECHANISM against fixture data (unit tests + a new, real, non-skipped
  `tests/e2e/v2-structured-results.spec.ts` whose fixture server (`tests/e2e/fixtures/server.mjs`)
  fabricates real `run_event`/`presented_result`/`pending_confirmation` NDJSON frames covering all six
  `PresentedResult` statuses), not against live production data. **Budget note:** the required render
  surface pushed the built UI past the existing 20 KiB gzip ceiling even after dropping all
  server-duplicated per-field length bounds (kept only shape/type/enum rejection, which is the actual
  protocol-boundary concern for stale-deploy same-origin JSON); user approved raising
  `LOCAL_UI_THRESHOLDS.uiGzipBytes` in `scripts/performance/local-ui-contract.ts` from 20 KiB to 21 KiB
  (baseline was already ~19.75 KiB gzip, one-line rationale left in the source). Also fixed one
  unrelated pre-existing bug found while chasing a `npm run verify` failure: `tests/integration/
  v2-clarification-route.test.ts`'s `T14-E` describe block signed its test session cookie with
  `session.expiresAt` computed from that suite's fixed `now: () => NOW` (`2026-07-26T00:00:00.000Z`,
  an 8h TTL) while `verifySessionCookie` (`src/auth/sessions.ts`) checks expiry against the REAL wall
  clock — a time bomb that expired partway through this same calendar day, independent of any T15-E
  change (reproduced identically on a clean worktree of the pre-T15-E commit). Fixed by signing the
  cookie with a fixed far-future expiry instead of the stale computed one; the store's own
  `session.expiresAt` (unrelated to auth) is untouched. Gate: `presenter-registry` + `presented-result-
  snapshots` + `v2-authoritative-results` + `ui-presentation` + `ui-preview-card` + `ui-render-pure` +
  `ui-render-xss` + `chat-results` + `history-sanitizer` + `chat-history` (173 tests) +
  `test:e2e --grep "preview|receipt|operation|unknown|partial"` (15 passed) +
  `v2-structured-results.spec.ts` (21 passed across Chromium/Firefox/WebKit) + `perf:local-ui` PASSED
  (20,741 / 21,504 bytes gzip) + full `npm run verify` green (329 files / 5046 tests, confirmed via the
  log's own exit-code line after two unrelated flakes — `api-rate-limit`/`chat-history` — reproduced the
  documented `f1-verify-flake-diagnosis` pattern: failed only under full-verify CPU load, passed clean
  in isolation, full verify went green on rerun). Live: `live_not_run_missing_credentials`. Default
  engine: `v1`. Next: `T16-A`.
- **Task 16 CLOSED (T16-A through T16-G):** narrow services + transport-only routes.
  T16-A/B froze the service contracts (`runScopeSchema` strict/required security fields,
  `StartRunInput`/`ResumeRunInput`, `uuidIdSchema`, type-only cross-boundary view DTOs in
  `src/shared/contracts.ts` — pinned type-only by asserting an EMPTY runtime module namespace so the
  UI gzip budget can never regress from it; dead `RunnerDependencies.eventStore` removed) and pinned
  `RunEventService` as named-composite-transitions-only with payload validation before any store write
  plus the provider-attempt-2 same-logical-call budget rule (`tests/unit/v2-service-contracts.test.ts`).
  T16-C extracted the runner (**634 → 202 lines**, well under the 500 gate): model-call machinery/
  budget charging/lifecycle outcomes → `services/run-service.ts`; exact-scope cache seed + bounded
  discovery refinement → `services/api-discovery-service.ts`; tool-call validation/partitioning,
  governor-pooled reads, write preparation, denial journaling → `services/action-execution-service.ts`
  (verbatim ports; T16-C parity gate + injection/clarification/preview-first suites green unchanged).
  T16-D/E added `history-service` (rotated-nonce restore view), `session-context-service` (/me,
  session list/new/open claims — cookie signing stays transport), `permission-service`,
  `metrics-service`, `artifact-service`, `undo-service`. **Permission confirm is now token-only
  (T16-E):** preview mints a 5-minute HMAC token bound to workspace+admin+session, the canonical
  hash of the CURRENT policy, and the exact patch; confirm accepts ONLY `{previewToken}` (a groups
  object 400s), authority recheck still runs BEFORE body decode (role-recheck pins hold verbatim),
  and applying a patch changes the base-policy hash so replay of an effective change fails closed as
  `stale_preview`. UI `savePermissions` does preview→confirm internally (ChatApi surface unchanged;
  +61 bytes gzip, 20,802/21,504), e2e fixture + `live-chat-tour`/`live-confirm-flow` updated to the
  two-step. T16-F/G split `routes/api.ts` (1049 → 309 lines, composition root only: engine selection,
  service wiring, rate-limit + CSRF middleware, router mounting) into transport-only route files —
  `me` 18 · `metrics` 19 · `undo` 27 · `artifacts` 29 · `runs` 53 · `operations` 55 · `permissions`
  68 · `clarifications` 81 · `confirmation-batches` 118 · `confirmations` 163 · `chat` 193 — every
  file under the 250 gate, each decode→authorize→one-service-call→encode/stream, store access only
  via injected scoped ports (never `AppDeps`/`deps.store`), shared `request-abort.ts`/`route-ports.ts`
  helpers; per-request clarification assembly moved behind `createClarificationResolutionPort`
  (v2-chat-pipeline). New gates: `tests/unit/v2-layer-boundaries.test.ts` (runtime imports from
  model/store/harness/presenter/audit/workflow layers rejected per route file; `import type` allowed;
  api.ts/pipelines documented as the composition exception), `tests/integration/v2-route-parity.test.ts`
  (literal body fixtures for deterministic paths incl. every not-found/invalid-decode branch),
  `tests/integration/me-route.test.ts` (sanitized context, no token/session leakage). Also fixed the
  T15-E-flagged `diagnostic.byteLength` UTF-16-vs-UTF-8 mismatch at its source
  (`run-event-hydration.ts` now uses `Buffer.byteLength(..., "utf8")`). Gate: T16-G vitest list (117)
  + cycles 0 + lint 0 + full `npm run verify` green (333 files / 5096 tests, VERIFY_EXIT=0 from the
  log's own exit line; first run showed 3 load-flake failures — `api-headers` + `run-events-route` —
  which passed in isolation and on the green rerun, the documented `f1-verify-flake-diagnosis`
  pattern) + `perf:local-ui` PASSED + `onboarding-keyboard.spec.ts` 9/9 (Chromium/Firefox/WebKit).
  Counts: `ACTION_CATALOG`/`MODEL_API` unchanged. Live: `live_not_run_missing_credentials`. Default
  engine: `v1`. Next: T14-T16 independent review gate, then `T17-A`.
- **T14-T16 independent review gate CLOSED:** one independent read-only review of the frozen
  `b56ad80..2971645` diff (13 commits, 108 files — all of T14-A..T16-G) covering reference/
  clarification IDOR, structured truth, service boundaries, the new permission preview token, XSS,
  accessibility, import cycles/layering, and the previously flagged gaps. Clean confirmations on
  IDOR (every id-bearing lookup resolves through the full scope tuple with indistinguishable 404s),
  the permission-token design (domain-separated HMAC, timing-safe compare, scope + base-policy-hash +
  TTL binding; confirm can never apply an un-previewed patch), XSS (textContent-only throughout),
  accessibility, and the byteLength fix. **Two HIGH + one MEDIUM accepted and remediated in
  `102ced4`:** (HIGH-1) a run durably suspended `awaiting_clarification` with NO live
  `pending_clarifications` row (reachable via the read-execution producer gap) permanently bricked
  its session — the supersession branch silently no-opped and every later turn tripped
  `idx_assistant_runs_one_active_per_session` into a 500; fixed with an `else` arm in
  `v2-chat-pipeline.ts` that fails the orphaned run (`clarification_missing`) before a new run is
  minted, pinned by an HTTP regression test seeding the exact orphaned state. (HIGH-2) a `denied`
  write preparation (policy/validation/auth-class/clarification_required/budget) fell through
  `prepareWrites` with no event at all — now journaled as one `tool.denied` per call with the
  denial code (the validation layer's existing vocabulary; deliberately NOT `completeTool`, which
  would have surfaced the dormant clarify→"succeeded" hydration mapping as a false success card);
  that mapping itself was fixed at the source (`run-event-hydration.ts` clarify → `failed` +
  `clarification_required` warning). (MEDIUM) the layer-boundary gate now also rejects re-exports
  and dynamic `import("...")` of forbidden layers. Re-review verdicts: ADDRESSED / ADDRESSED /
  ADDRESSED; "no unrecovered HIGH remains at HEAD." One residual non-blocking observation recorded:
  in the generation-mismatch corner of the new recovery arm, a real dangling clarification row is
  left to its 5-minute TTL instead of an explicit cancel (audit hygiene only). **Recorded v2-cutover
  blocker — CLOSED by slice CP (`7a0e745` CP-A, `f168023` CP-B, `cb815ba` CP-C):**
  `read-execution.ts`'s clarify branch never called `store.createPendingClarification`, so no runtime
  producer of clarification rows existed and live v2 read clarifications could not be resolved end to
  end (`tests/e2e/v2-clarification.spec.ts` stayed skipped for exactly that reason). The deadlock
  consequence was recovered here; the producer itself, its hydration, and the un-skipped E2E all
  landed in slice CP below, so this is no longer a `ASSISTANT_ENGINE=v2` blocker.
  Gate: remediation vitest files green + full `npm run verify` green
  (333 files / 5099 tests, VERIFY_EXIT=0; one `chat-new` load-timeout flake passed in isolation and
  on the green rerun, per `f1-verify-flake-diagnosis`). Live: `live_not_run_missing_credentials`.
  Default engine: `v1`. Next: `T17-A`.
- **CP-A CLOSED:** `src/assistant-v2/read-execution.ts` is now the ONE runtime producer of
  `pending_clarifications` rows — the recorded v2-cutover blocker. The clarify branch persists the
  question as a canonical `action_results` row, creates the durable row, and returns
  `{kind:"clarification", clarificationId, actionResultId}`; `action-execution-service.ts` journals a
  new named transition `clarification.required` (store `requireClarificationWithEvent` +
  `RunEventService.requireClarification`, `NAMED_TRANSITIONS` now 13) **after** setting
  `state.continuation` and before `suspendRun`, which still solely owns the phase change. The reads
  port scope is now `RunScope & {runId}` at every call site. **Three plan-vs-code contradictions found
  by reading the real code and fixed with owner-authorized scope widening (see the STOP record):**
  (1) the plan's literal `missingField: "selection"` can never resolve, because
  `clarification-service.ts` rebuilds arguments as `{...partialArguments, [missingField]: externalId}`
  and `"selection"` is no action's argument key — the clarify `ActionResult` gained an optional
  `field?: string` (plus an optional 2nd param on `clarifyResult`) that 12 single-slot read call sites
  now pass (`id` for clients/projects/tags/templates/time-off-policy get; `userId` for
  entries_list/scheduling assignments+user_totals/time-off requests+balance; `assignedTo` for
  holidays_in_period; `projectId` for scheduling project_totals_one). `"selection"` survives as the
  correct INERT fallback for the 13 clarify sites with no single owning argument (11 date/window
  clarifies, which carry no options at all, plus `entries_list`'s project/task pair and `tasks_get`'s
  project-or-task ambiguity) — those resolve by T14-E free-text continuation only, never by guessing
  an argument. (2) `idx_pending_clarifications_one_active_per_run` makes a second create throw
  `clarification_already_active` on two reachable paths (two ambiguous reads in ONE provider batch —
  the read pool resolves every call before any outcome suspends the run — and a re-clarify inside
  `resolveOption`, which holds its row in `resolving`); the producer catches exactly that code and
  returns the run's existing open question, so the run suspends on / resets a row that really exists
  instead of crashing. (3) the `clarification.required` payload gained `actionResultId` so the
  admin-visible question stays in `action_results` and the event keeps only a bounded link (CP-B
  hydrates from it). Gate: `npx vitest run tests/unit/v2-service-contracts.test.ts
  tests/unit/v2-runner.test.ts tests/unit/run-events-store.test.ts
  tests/integration/v2-runner-persistence.test.ts tests/integration/v2-clarification-route.test.ts`
  (51 passed) + `npm run type-check` + `npm run lint` + `npm run check:api-action-inventory` all exit
  0. Environment note: `node_modules/better-sqlite3` was compiled for Node 26 and had to be
  `npm rebuild`-ed for the mandated Node 22 before any DB-backed test could run. Counts: unchanged
  (`ACTION_CATALOG` 171 / `MODEL_API` 127, catalog hash
  `fb3c3b5c4787767e6cde921f735f8d5eab55aadde7e5a166aefe0db2a1c75bce` — no metadata field changed).
  Runtime proof of the produced row/event/attachment/resolve round trip lands in CP-B. Live:
  `live_not_run_missing_credentials`. Default engine: `v1`. Next: `CP-B`.
- **CP-B CLOSED:** `hydrateAttachment`'s `clarification.required` arm now returns the real
  `pending_clarification` attachment (it previously returned `undefined`): it loads the row through
  the FULL scope tuple, drops the attachment unless the status is `pending`/`resolving` (a settled
  clarification never re-renders as live — same rule `operation.prepared` uses for confirmations),
  and reads the admin-visible question from the canonical clarify `action_results` row the event
  links to. The attachment carries `question` + `missingField` + `{optionId,label,referenceId?}`
  candidates and `expiresAt` — **never `externalId`, never `partialArguments`**. Fixed the T14-F
  placeholder this exposed: `attachmentToResults` rendered the clarify bubble as
  `attachment.missingField`, so an admin would have seen `userId` instead of the real question; it
  now renders `attachment.question` (decoded strictly in `ui/protocol.ts`). New
  `tests/integration/v2-clarification-producer.test.ts` (6 cases, all through REAL HTTP against
  `createApp` with `assistantEngine: "v2"`, a scripted discovery-then-read model, and a fake
  workspace seeded with TWO members named exactly "Alice"): one durable row with `missingField:
  "userId"`/two 24-hex candidates and the run suspended on it; exactly one `clarification.required`
  event whose hydrated attachment carries the real question, leaks no `externalId`, and precedes
  `run.suspended`; resolve-by-exact-`optionId` over the real route settles the row `resolved`,
  scrubs it, and stores a `clockify_entries_list` receipt whose `data.userId` is the CHOSEN id;
  a settled clarification's event loses its attachment; a no-owning-argument date clarify
  (`start: "not-a-real-date"`) produces `candidates: []` + `missingField: "selection"`, rejects
  resolve-by-option `400 unknown_option` while staying answerable, and still resumes through T14-E
  free-text continuation; and two ambiguous reads in ONE provider batch suspend on the run's single
  open question (the CP-A `clarification_already_active` path) with exactly one event. Plan
  deviation recorded: CP-B case 5 as printed cannot produce a no-options clarify — `suggestOptions`
  falls back to the whole candidate pool when nothing contains the query, so a zero-match NAME
  yields non-empty did-you-mean options; the date-range clarify above is the real no-options path.
  Gate: `npx vitest run tests/integration/v2-clarification-producer.test.ts
  tests/integration/v2-clarification-route.test.ts tests/integration/v2-clarification-ui.test.ts
  tests/unit/v2-service-contracts.test.ts tests/integration/run-events-route.test.ts` (55 passed) +
  `npm run type-check` exit 0 + UI decode/render suites (71 passed) + `npm run perf:local-ui` PASSED
  (UI gzip 20,812 / 21,504). Counts: unchanged. Live: `live_not_run_missing_credentials`. Default
  engine: `v1`. Next: `CP-C`.
- **CP-C CLOSED:** `tests/e2e/v2-clarification.spec.ts` is un-skipped and implemented (its header now
  records why it was skipped from T14-F to CP-B and what changed). `tests/e2e/fixtures/server.mjs`
  gained two scenarios — `clarification` (a `pending` question) and `clarification-resolving` (a
  claimed one) — serving history `activeRun{phase:"awaiting_clarification"}`, a
  `/api/runs/:runId/events` page whose `clarification.required` frame carries the EXACT
  `pending_clarification` attachment shape CP-B hydrates (copied from the passing producer test, not
  invented), a `POST /api/clarifications/:id/resolve` that **rejects any value that is not a stored
  candidate id** (mirroring the real route, which is what makes "the chip submits the id, never the
  label" a real assertion) and streams a `presented_result` echoing the id the SERVER received, plus a
  fixture-only read-back for exact assertions. Six cases × three browsers: question + grounded chips
  restored (and the bubble is the question, not `userId`); chip click resolves by exact id with the
  server-echoed id rendered; chips disable after one click; page reload restores the pending chips
  from history+events exactly once; a second tab restores and resolves them; a `resolving`
  clarification renders every chip disabled with zero resolves recorded. The file sets
  `test.describe.configure({ timeout: 60_000 })` — a time budget only, no assertion or polling change
  — because each case drives a page load plus durable restoration (two pages in the second-tab case)
  and the config's 20s default is sized for lighter specs. Gate: `npm run build` exit 0 +
  `npx playwright test tests/e2e/v2-clarification.spec.ts` **18/18 passed** (Chromium + Firefox +
  WebKit). **`npm run test:e2e` is NOT green on this machine and is deliberately not recorded as
  green:** three runs (3-worker ×2, then 1-worker) failed 21 → 16 → 7 tests, every one of them a
  Firefox timeout in a spec file this slice never touched (`action-journeys`, `onboarding-keyboard`,
  `product-protocol`, `responsive-accessibility`, `run-restoration`, `v2-structured-results`), with
  ZERO `v2-clarification` failures in any run. Attribution is definitive rather than assumed: the
  untouched `action-journeys.spec.ts` passes 6/6 in isolation at 1 worker both before and after those
  runs, yet failed 5/6 inside the same 1-worker full-suite pass, while this host's load average ran
  7.7 → 24.7 on 8 cores from external processes (46-day uptime, 6 users). That is the documented
  `f1-verify-flake-diagnosis` pattern on the Playwright side — full-suite e2e must be re-attempted on
  a quiet machine before any release claim. Counts: unchanged. Live:
  `live_not_run_missing_credentials`. Default engine: `v1`. Next: `CP-D`.
- **CP-D CLOSED / slice CP green — the recorded v2-cutover blocker is fixed:** a v2 read that resolves
  to a clarification now creates a durable `pending_clarifications` row, journals
  `clarification.required` referencing the canonical clarify `action_results` row, hydrates a
  display-only `pending_clarification` attachment for the UI, and can be resolved by exact `optionId`
  or answered with free text — proven by real-HTTP integration coverage and by browser coverage on
  three engines. Gate: **`npm run verify` VERIFY_EXIT=0 (334 files / 5,105 tests, zero flakes on the
  first run)** + `npm run perf:local-ui` PASSED (UI gzip 20,812 / 21,504; status max 15.5ms, warm p95
  168.2ms, cold fast-4G p95 1,137.6ms, history p95 240.2ms). Docs sync: `AGENTS.md`'s checkpoint list
  was three entries behind and now carries T15-E, Task 16, and the T14-T16 review gate (condensed to
  that file's established one-entry-per-slice voice rather than copied verbatim, since its own header
  forbids duplicating `CLAUDE.md` wholesale — the plan's "verbatim" wording was read as "do not lose
  the content"); the review-gate entry's blocker paragraph now records the blocker as CLOSED by
  `7a0e745` / `f168023` / `cb815ba`. **Known environment condition, NOT closed:** `npm run test:e2e`
  did not pass on this host in four attempts (3-worker ×2, 1-worker, and one more after load dipped):
  21 / 16 / 7 / 20 failures, every one a timeout in a spec file slice CP never touched, and zero
  `v2-clarification` failures in any of the four runs. Attribution is measured, not assumed — the
  untouched `action-journeys.spec.ts` passes 6/6 in isolation immediately before and after failing 5/6
  inside a full run, while this host's load average moved between 7.6 and 24.7 on 8 cores from
  external processes. Full-suite e2e must be re-run on a quiet machine before any release claim; the
  clarification spec itself is green 18/18 across Chromium, Firefox, and WebKit. Counts: unchanged
  (`ACTION_CATALOG` 171 / `MODEL_API` 127, catalog hash
  `fb3c3b5c4787767e6cde921f735f8d5eab55aadde7e5a166aefe0db2a1c75bce`). Live:
  `live_not_run_missing_credentials`. Default engine: `v1`. Next: `T17-A`.
- **T17-A CLOSED:** `scripts/eval-v2/` derives the v2 evaluation case set from
  `MODEL_API_ACTION_CATALOG` — **exactly 127 cases (43 reads + 84 writes), zero hand-written
  per-operation tables and no hard-coded count anywhere.** Key finding that shaped the slice: the
  request arguments and fake seeds needed per operation already ship as `READ_PARITY_FIXTURES` (43)
  and `WRITE_PREVIEW_FIXTURES` (84), and `tsconfig.scripts.json` already includes
  `tests/helpers/**/*.ts` — so the cases are DERIVED from fixtures the parity suites already prove
  against the real actions, not authored a second time. `case-model.ts` is the one derivation
  (canonical/paraphrase/one-character-typo phrasings, seed, expected arguments, terminal state,
  cohort membership); `api-discovery-cases.ts`, `assistant-terminal-cases.ts` and
  `write-safety-cases.ts` are thin projections; `report.ts` is the one report builder. Terminal
  cohorts: `single_read` 43 · `multi_read` 40 · `single_write` 84 · `independent_writes` 84 ·
  `dependent_writes` 10 · `clarification` 16 · `references` 7 · `denial` 127 ·
  `unavailable_auth_class` 7 · `truncation` 23 · `unicode` 6 · `hostile_data` 43 · plus four
  runtime-scenario cohorts (cancellation / budget exhaustion / partial / unknown outcome) with one
  deterministically chosen representative each. Write safety: 84 cases × 9 invariants = 756 checks.
  **Three deliberate deviations from the printed plan, all to avoid fabricated evidence (rule
  19/20):** (1) a sixth file `case-model.ts` was added inside `scripts/eval-v2/` because three
  projections deriving the same way is exactly what `npm run dup` flags — the shared derivation lives
  once; (2) `liveCase` stays absent on every case until T17-F defines a real guarded one, and the four
  runtime cohorts are declared as SCENARIOS rather than per-operation properties, because neither is
  derivable from shipped facts; (3) `expectedTerminalState` for a write is `pending_confirmation`
  (or `denied` where the parity fixture proves preparation legitimately stops short) — never
  "executed", since a v2 assistant write can only ever reach an unconfirmed preview from a model turn.
  Also fixed a real defect found while wiring: `case-model.ts` initially imported
  `discoveryQueriesForAction`/`isAddonUnavailableWrite` from `v2-read-parity.ts`/`v2-write-parity.ts`,
  which `import { expect } from "vitest"` — so any `npm run eval:*` script would have crashed on
  import. Both pure functions moved down into the pure `v2-read-parity-fixtures.ts` /
  `v2-write-preview-fixtures.ts` modules and are re-exported from the vitest-importing helpers, which
  also collapsed the pre-existing byte-identical `discoveryQueriesForWrite` duplicate into the one
  shared implementation; the case model now runs standalone under plain `tsx`. The coverage test
  computes BOTH sides of every assertion from the live catalog and fails on a missing fixture
  (synthesized invented action), a duplicate, a stale/extra entry, a journey step that is not a
  catalog write, an attempt scoring a case outside the derived set, an empty attempt set treated as a
  pass, and a hard-coded numerator or denominator (a 5-case report must report 5). Gate:
  `npx vitest run tests/unit/v2-eval-coverage.test.ts tests/unit/eval-consistency.test.ts
  tests/unit/ordered-eval-cohorts.test.ts` (30 passed) + the structure/leave read+write parity suites
  as a refactor regression check (521 passed total) + `npm run type-check` + `type-check:scripts` +
  `lint` + `dup` all exit 0. Counts: unchanged. Live: `live_not_run_missing_credentials`. Default
  engine: `v1`. Next: `T17-B`.
- **T17-B CLOSED:** `scripts/eval-api-discovery.ts` scores API discovery through the **real** runner.
  A shared `scripts/eval-v2/runner-harness.ts` (second deliberate extra file, same dup-gate reason as
  `case-model.ts`; T17-C/D reuse it) assembles the identical dependency set
  `buildV2RunnerDependencies` builds for a live HTTP turn — real `runAssistantV2`, real
  `buildApiOperationIndex` + `runDiscoverySearch`, real `createReadExecutionPort`, real
  `OperationPreparationService` — against a fresh `createFakeWorkspace` and a throwaway SQLite file,
  then scores ONLY what the run durably journaled (`api.operations_loaded` /
  `tool.requested` / the `assistant_runs` terminal phase). Discovery is never called directly, the
  provider is never scripted in the shipped path, and the run starts with the discovery meta-tool
  alone. Per case: 3/3 canonical, ≥2/3 paraphrase, ≥2/3 typo, ≤12 API tools ever offered in one
  completion, and 0/3 loads of a DELETE operation from an unrelated feature group. Smoke-verified the
  harness really drives a run (scripted-client override, local only, not committed as a shipped path):
  outcome `completed`, terminal phase `completed`, 12 operations loaded — the exact cap — target
  included, and the read executed. Credential-free behavior verified by running the script:
  `status: "not_evaluated_missing_credentials"`, `modelConfiguration` the same sentinel,
  `numerator`/`denominator` 0, real `caseCount` 127, real candidate SHA and catalog hash, **exit 2** —
  a sentinel can never be mistaken for a pass by exit code. No `.env.server` is sourced and no key was
  used. Hash note for reviewers: the identity's `catalogHash` is
  `MODEL_API_ACTION_CATALOG.hash()` = `3872950503ac629de4629009b7548fbbc1cd509893d0ad2d7c7b34359246cbd7`
  (the 127-action model-facing registry), which is legitimately NOT the inventory evidence hash
  `fb3c3b5c4787767e6cde921f735f8d5eab55aadde7e5a166aefe0db2a1c75bce` nor
  `INTERNAL_ACTION_CATALOG.hash()` `d899cc15482e6085afa29d96fce7cba7aa951f480be008b88cf50e9178b14f56`;
  `check:api-action-inventory` stays green, so nothing drifted. Gate: `npm run type-check:scripts` +
  `npx vitest run tests/unit/v2-eval-coverage.test.ts` (21 passed) + `type-check` + `lint` + `dup`,
  all exit 0. Eval status: `not_evaluated_missing_credentials`. Live:
  `live_not_run_missing_credentials`. Default engine: `v1`. Next: `T17-C`.
- **T17-C CLOSED:** `scripts/eval-assistant-terminal.ts` scores the run's FINAL terminal state, never
  the first tool selection, across 14 real cohorts driven through the T17-B harness. The scoring rule
  that matters: **a write attempt whose run reaches `completed` with the write actually requested is a
  FAILURE (`write_executed_without_confirmation`)** — the only passing terminal state for a write is
  `awaiting_confirmation` with zero mutations; reads must reach `completed` with the operation truly
  executed; denial / unavailable-auth / budget cohorts must reach a terminal `failed` with the
  operation never executed; cancellation drives a pre-aborted signal and budget exhaustion drives
  `maxHostCalls: 0`. Strict cohorts (every safety/denial/ambiguity/hostile one) must be 3/3, and the
  aggregate must be ≥ 95%. **`partial_outcome` and `unknown_outcome` are explicitly DELEGATED, not
  faked:** neither is reachable from a model turn at all, because a v2 assistant write stops at an
  unconfirmed preview and a partial/ambiguous host settlement can only arise after a button
  confirmation — so the report carries a machine-readable `delegatedCohorts` map naming the shipped
  suites that do prove them (`mutation-workflow.test.ts`, `v2-compound-api-requests.test.ts`,
  `v2-confirmation-authority.test.ts`) instead of inventing a model-turn scenario. Verified
  credential-free: `status: "not_evaluated_missing_credentials"`, 127 cases, 0/0, 14 cohorts, both
  delegations reported, threshold 0.95, **exit 2**. Gate: `npm run type-check:scripts` +
  `npx vitest run tests/unit/eval-consistency.test.ts tests/unit/ordered-eval-cohorts.test.ts`
  (9 passed) + `lint`, all exit 0. Eval status: `not_evaluated_missing_credentials`. Live:
  `live_not_run_missing_credentials`. Default engine: `v1`. Next: `T17-D`.
- **T17-D CLOSED:** `scripts/eval-write-safety.ts` + `tests/integration/v2-write-safety-matrix.test.ts`
  are the write-safety **accountant**, deliberately not a re-implementation of the proofs: the nine
  invariants per write are already proven by the seven shipped `v2-write-parity-*` domain matrices plus
  `v2-preview-first-matrix`, `v2-confirmation-authority`, `v2-typed-consent`,
  `v2-prompt-injection-write`, `v2-confirmation-batch` and `mutation-workflow`. The matrix derives 84
  cases × 9 invariants = **756 checks** from the catalog and proves the three things those suites
  cannot prove about themselves: every atomic model write carries every invariant; the seven domain
  matrices between them account for all 84 writes (so no write is safety-covered by nothing); and a
  write's expected terminal state is never an executed mutation. Aggregation into the T13
  `V2AuthorityEvidence` is fail-closed and each rejection is a real test: a **partial** report
  (an unobserved invariant scores `invariant_not_observed`, never a skip), a report with **any**
  violation, a **sentinel/blocked** report, a **zero-case** report, a **wrong candidate SHA**, and a
  **wrong catalog hash** all yield `not_evaluated_until_pr15` instead of an artifact; only a complete
  100% report produces `status: "complete"` with all four conclusions `passed`, `assistantWriteCases`
  84, and every mutation/dispatch/capability counter 0. Every observation is counted exactly once (no
  invariant double-credited). Running the script alone reports the matrix shape with an explicit
  blocked status and **exit 2** (`caseCount` 84, `expectedChecks` 756, `authority`
  `not_evaluated_until_pr15`) — the proofs live in vitest, so a bare script run can never be a pass.
  Gate: `npx vitest run tests/integration/v2-write-safety-matrix.test.ts
  tests/unit/v2-authority-evidence.test.ts tests/unit/release-evidence.test.ts` (49 passed) +
  `type-check` + `type-check:scripts` + `lint` + `dup`, all exit 0. Counts: unchanged. Live:
  `live_not_run_missing_credentials`. Default engine: `v1`. Next: `T17-E`.
- **T17-E CLOSED:** `src/metrics/run-metrics.ts` owns **every** v2 run-metrics formula; the store gained
  one bounded scoped primitive (`listRunEventsForMetrics`, `LIMIT` 10,000, workspace+admin+since,
  rows only) and computes nothing, and `MetricsService` calls the one module so
  `src/routes/metrics.ts` stays transport-only (`v2-layer-boundaries` still green). The block is
  ADDITIVE on `GET /api/metrics` (`metrics.runs`); every v1 field is untouched. Accounting: the
  denominator is unique `(sessionId, runId, modelCall)` **attempt-1** groups — a provider attempt 2 is
  the SAME logical call (matching the store's own skipped budget increment) but a separate
  `providerAttempts` count; incomplete calls are reported separately, never dropped. Covered:
  searches · per-run refinements · loaded tools + per-completion maximum · cache hits · validation
  failures by code · repeated argument hashes (per run, never across runs) · abandonment ·
  latency p50/p95/max from completed calls only · attempts · calls · clarifications · all four
  operation lifecycle stages · tokens · completion ratio. **Corrupt groups are reported, never
  normalized away:** six anomaly codes (`model_call_without_start`,
  `duplicate_attempt_for_model_call`, `attempt_two_without_attempt_one`, `model_call_never_completed`,
  `run_terminal_event_missing`, `multiple_terminal_events`), each with a real failing-input test.
  Privacy: absent token usage stays ABSENT rather than becoming zero (a provider reporting nothing
  must not drag a total down); two tests assert the serialized block contains no request text, no
  action names outside the denial-code map, and no session/run identifier at all; a second admin's
  runs in the same workspace are invisible to the caller. Gate: `npx vitest run
  tests/unit/run-metrics.test.ts tests/integration/v2-metrics-route.test.ts
  tests/unit/v2-layer-boundaries.test.ts tests/integration/metrics-route.test.ts` (51 passed) +
  `type-check` + `type-check:scripts` + `lint` + `cycles` (0) + `dup`, all exit 0. Live:
  `live_not_run_missing_credentials`. Default engine: `v1`. Next: `T17-F`.
- **T17-F CLOSED (built, NOT executed):** `scripts/live-v2-full.ts` refuses to act unless ALL FOUR
  preconditions hold — `LIVE_CLOCKIFY=1`, the literal sacrificial marker
  (`clockify-live-smoke-sacrificial`; a workspace id is explicitly NOT accepted as proof a workspace is
  disposable), credentials + workspace id, and an explicit cleanup-registry path — and reports EVERY
  missing one, not just the first. Verified by running it: `status: "refused"` listing all five
  failures, **exit 2**, zero Clockify calls. `LiveCleanupRegistry` rejects any resource whose name
  lacks the `AIASSIST_V2_` prefix (`live_resource_not_fixture_owned`), so the harness can only ever
  delete its own fixtures, and `cleanupOrder()` returns reverse dependency order (task before project
  before client, newest-first within a kind). `buildLiveV2Report` passes ONLY a run with zero
  leftovers, zero preparation mutations, **zero `trustedBypassCalls`** (the trusted immediate-write
  bypass may never stand in for a confirmed assistant write) and at least one prepared AND confirmed
  write — an empty run is a failure, and the report carries a 4-character workspace suffix rather than
  the raw id or any key (asserted). `scripts/live-sweep.ts` now sweeps **both** prefixes through one
  shared `isSweepableName` predicate (every per-entity `startsWith` call site routed through it) plus
  exported `sweepIsClean`/`sweepLeftovers`; a SCAN failure can never prove absence. `package.json`
  gained the five exact scripts (`eval:api-discovery`, `eval:assistant-terminal`, `eval:write-safety`,
  `live:v2-full`, `live:sweep`); none pre-existed. `live-smoke.yml`'s fail-closed cleanup evidence now
  claims both prefixes. **Reverted an unnecessary change of my own:** I first rewrote the workflow's
  sweep step to `npm run live:sweep`, which broke `workflow-contracts.test.ts`'s deliberate pin — the
  step must stay a direct `npx tsx` invocation so `timeout --signal=TERM` signals the sweep process
  itself instead of an npm wrapper. Restored the pinned command with a comment recording why. Gate:
  `npx vitest run tests/unit/live-v2-full.test.ts tests/unit/live-sweep.test.ts` (31 passed, plus
  `workflow-contracts` 36 total) + `type-check:scripts` + `lint` + `dup`, all exit 0. **No Clockify
  write ran.** Live: `live_not_run_missing_credentials`. Default engine: `v1`. Next: `T17-G`.
- **T17-G CLOSED / Task 17 deterministic work CLOSED:** the five exact npm scripts exist
  (`eval:api-discovery`, `eval:assistant-terminal`, `eval:write-safety`, `live:v2-full`, `live:sweep`
  — none pre-existed; `live:sweep` landed one slice early in T17-F because the harness needed it, and
  the other four here). `scripts/evidence/release-evidence.ts` gained `classifyV2Evaluation` plus
  `ReleaseEvidenceV2.evaluations` / `v2EvaluationComplete`: a v2 release conclusion is fail-closed and
  requires complete authority evidence AND all three evaluations `passed`, where `passed` means
  complete + fully scored + non-empty + bound to the exact candidate SHA. Six new tests prove a
  MISSING evaluation is `rejected`, a SENTINEL stays `not_evaluated_missing_credentials` (non-passing
  without being mislabelled as rejected), a partial score / zero denominator / zero case count is
  `rejected`, a stale candidate SHA is `rejected`, and sentinel authority evidence keeps
  `v2EvaluationComplete: false` even with three passing evaluations. **Credential-dependent status,
  recorded verbatim as the plan requires:** all three `eval:*` commands emit
  `not_evaluated_missing_credentials` and **exit 2** with real case counts (discovery 127, terminal
  127, write-safety 84) and `0/0` scores — that is the correct result and does NOT invalidate
  deterministic local closure. No key was used and no dotenv file was sourced. Gate: the printed
  8-file vitest list (**99 passed**) + the three `eval:*` commands + **`npm run verify` VERIFY_EXIT=0
  (340 files / 5,201 tests, first run, zero flakes)**. **Exact remaining blockers for Task 17:**
  (1) the three eval reports need model credentials to become complete exact-SHA artifacts;
  (2) `live:v2-full` is built and refuses without its four preconditions — executing it needs T18-H;
  (3) `npm run test:e2e` still needs a quiet machine (see CP-D: four attempts, every failure in an
  untouched spec, zero clarification failures). Counts: `ACTION_CATALOG` 171 / `MODEL_API` 127;
  inventory evidence hash `fb3c3b5c4787767e6cde921f735f8d5eab55aadde7e5a166aefe0db2a1c75bce`,
  model-API registry hash `3872950503ac629de4629009b7548fbbc1cd509893d0ad2d7c7b34359246cbd7`.
  Live: `live_not_run_missing_credentials`. Default engine: `v1`. Next: **`T18-A` — operator-blocked;
  T18 requires new, explicit, per-step authority and was NOT started.**
- **Pre-T18 review gate CLOSED (with remediation):** two independent read-only reviews of the frozen
  `34ea91c..8862d73` range (11 commits, 61 files, +4,982/-183): one on complete API/eval parity, one on
  backup/deploy/rollback readiness for T18. Review 1 explicitly cleared: all 12 original `field` values
  are real Zod argument keys, injection round-trips cleanly (a 24-hex id is trusted without a list call,
  so a leftover ambiguous `name` cannot re-clarify), no `externalId`/`partialArguments` leak, a settled
  clarification cannot re-render as live, no IDOR (all four scope fields asserted; the resolve route
  derives `runId` server-side), and `buildEvalReport` can neither vacuously pass nor grade foreign work.
  **Findings accepted and remediated at HEAD:** (HIGH) five structurally identical single-slot READ
  clarify sites were missed by CP-A and stored `missingField: "selection"` while still carrying option
  chips — for `clockify_invoices_get`/`payments_list`/`export` (live MODEL_API reads, all through the
  shared `defineInvoiceRead`) those chips were a DEAD BUTTON: click -> `selection` stripped by the
  non-strict Zod object -> re-clarify -> 409 forever, burning host calls on each click. Fixed by passing
  the exact key at all five sites (`invoices.ts` `id`, `custom-fields.ts` `id`, `holidays.ts` `id`,
  `users.ts` `id`, `scheduling.ts` `projectId`; the latter four are composite/generic and off MODEL_API
  today, fixed for correctness and future promotion). (MEDIUM) the `clarification_already_active`
  fallback ADOPTED the winning row's id while returning THIS read's prose, so two ambiguous reads in one
  batch could render one read's question above the other read's chips and resolve the wrong action; it
  now returns `undefined` and the read reports a truthful `failed: clarification_already_active`,
  leaving the run to suspend on the row's real owner (the earlier adopt-the-row design, chosen to avoid
  a half-journaled tool, was simply wrong). (MEDIUM) `isReleasableReport` never compared `denominator`
  to `caseCount`, so a 5-of-127 report passed — reports now carry `scoredCaseIds` and releasability
  requires one scored attempt per case, with a regression test. (MEDIUM) `classifyV2Evaluation`'s
  catalog-hash check was dead at its only call site — now threaded from the authority evidence.
  (MEDIUM) the terminal evaluator graded `denial`/`hostile_data`/`clarification`/
  `unavailable_auth_class` against terminal states they could never reach with no scenario driver,
  making `passed` unreachable and the docstring untrue — those four are now reported as
  `unscoredCohorts` with the exact missing scenario instead of being graded. (MEDIUM) the coverage gate
  could not see an ORPHAN fixture (both sides derived from the catalog) — added an explicit
  fixture-to-catalog check. (LOW) the discovery evaluator's threshold function was arithmetically dead
  and its "attempt is omitted" comment was false while the code returned `passed: true` — both fixed.
  **Accepted and deliberately NOT fixed here, recorded as T18 entry requirements:** Review 2's twelve
  items are T18-A/T18-B scope by design, plus one PRE-EXISTING branch blocker that must be fixed before
  any deploy verification can run — `/version.modelConfiguration` emits 9 keys (`assistantEngine` was
  added by `9652309`) while `scripts/evidence/deepseek-release-evidence.ts` and `DEPLOYMENT.md` enforce
  exactly 8, so the documented deploy identity assertion exits 1 on a CORRECT deployment. Also:
  `ASSISTANT_ENGINE` and `DATABASE_PATH` sit outside the deploy transaction's snapshot and
  `ROLLBACK_KEYS`; no backup records which database it came from; the runbook still pins schema v8
  against `LATEST_SCHEMA_VERSION` 12; nothing proves the v2 target path is unused; and the token
  denylist/lifecycle watermark/generation are per-database, so the v1 and v2 files share no authority
  history. Review 2 confirmed the backup/restore machinery is the strongest part of the repo (40 tests
  across recovery/restore/readiness/gate) and that the engine switch itself is sound with no silent
  fallback. Gate: clarification suites (48) + eval/evidence suites (78) + `check:api-action-inventory` +
  `type-check` + `type-check:scripts` + `lint` + `cycles` (0) + `dup` + **`npm run verify`
  VERIFY_EXIT=0 (340 files / 5,203 tests)** on the rerun; the first run showed two `run-events-route`
  `invalid_query` failures that passed in isolation and on the green rerun — the documented
  `f1-verify-flake-diagnosis` pattern. Live: `live_not_run_missing_credentials`. Default engine: `v1`.
  Next: **`T18-A` — STOPPED for operator authorization; T18 requires new, explicit, per-step authority
  and was NOT started.**
- **A0 CLOSED (three accepted pre-T18 review findings fixed, local only):** three focused commits.
  (A0-1 `565cc88` `fix: make the deployed version contract exact`) `/version.modelConfiguration`
  emits nine keys — `assistantEngine` was added by `9652309` — while the deployed-payload validator
  in `scripts/evidence/deepseek-release-evidence.ts`, `DEPLOYMENT.md`, and
  `docs/marketplace/03-operations-evidence-rollback-package.md` all enforced exactly eight; CI stayed
  green only because the deployed fixture was hand-written with eight. The documented deploy identity
  assertion therefore exited 1 on a CORRECT deployment, blocking ALL deploy verification. The frozen
  `deepseek-release-binding.json` artifact and the live `/version` payload are two different schemas,
  so the shared validator was SPLIT, never widened: `modelConfiguration()` keeps the eight-key binding
  check byte-identical for v1 rollback and a new `deployedModelConfiguration()` requires the nine-key
  deployed schema — no recorded hash or binding value changed. It now also asserts that the deployed
  `assistantEngine` equals the INTENDED engine (nothing checked this before; it is the single value
  the v2 cutover most needs proven at the deploy boundary), derived from the evidence classification
  in the validator and from `EXPECTED_ASSISTANT_ENGINE` (defaulted from `SELECTED_ASSISTANT_ENGINE`,
  so T18-F's v2 deploy asserts `v2` instead of re-creating this blocker) in both runbooks, with its
  own error rather than a DeepSeek-setting mismatch; a new `release-operations-contract` case pins
  both runbook assertions. (A0-2 `ef465ba` `fix: never hydrate an expired clarification as live`)
  `hydrateAttachment`'s `clarification.required` arm filtered on status ALONE while expiry is enforced
  at claim time and only lazily by the retention sweep, so an expired-but-unswept row rendered live
  chips that 410 on click; the guard mirrors `claimClarificationResolving`'s comparison exactly
  (expired when `expiresAt <= now`) so a dropped row could not have been claimed anyway — the
  regression test asserts the row is still `pending`, the attachment is gone, AND the claim really
  throws `clarification_expired`. That guard exposed a fixture skew: `makeV2App` pinned the STORE
  clock but never passed `AppDeps.now`, so route/hydration code ran on the real wall clock and every
  row was born "expired" (the T15-E session-cookie skew class); store and app now share one
  injectable clock, as in production. (A0-3 `<this commit>` `fix: journal every executed read in a
  suspended batch`) `executeReads` returned at the FIRST clarification outcome, so later reads in the
  same batch — which the read pool had already fully executed, with real host calls and persisted
  results — vanished from the journal entirely; the whole batch is now journaled in provider order
  and the clarification/suspension events are emitted after it, preserving the
  continuation-set-before-the-event invariant. Verified by removing the fix: the new case fails with
  `expected [] to deeply equal ['tool.requested','tool.started','tool.completed']`. Observed and
  deliberately NOT fixed (pre-existing, outside A0-3's stated scope): a `failed` read outcome still
  journals `tool.requested` + `tool.started` with no terminal event. **A0-4 (drive the four
  `unscoredCohorts` terminal scenarios) DEFERRED, not done:** it is explicitly optional, is by far the
  largest A0 item, and nothing in T18 consumes a terminal report — and without `LLM_*` credentials
  `eval:assistant-terminal` emits `not_evaluated_missing_credentials` regardless, so building the
  drivers now could not produce a passing report anyway. Gate: `npx vitest run
  tests/unit/deepseek-release-evidence.test.ts tests/integration/v2-clarification-producer.test.ts
  tests/unit/release-operations-contract.test.ts tests/integration/run-events-route.test.ts
  tests/unit/v2-service-contracts.test.ts tests/unit/v2-runner.test.ts
  tests/integration/v2-runner-persistence.test.ts` (83 passed) + `type-check` + `type-check:scripts` +
  `lint` + `cycles` (0), all exit 0. Counts: unchanged. Live: `live_not_run_missing_credentials`.
  Default engine: `v1`. Next: full `npm run verify`, then **`A1` — push/merge, owner-authorized but
  BLOCKED on host load for `test:e2e`.**
- **A0 gate CLOSED / A1 PARTIAL (pushed, PR open, NOT merged):** `npm run verify` VERIFY_EXIT=0 on
  `2b26e28` (340 files / 5,208 tests, zero flakes on the first run); `npm run test:e2e` exit 0
  (120 passed across Chromium/Firefox/WebKit) once host load fell from 11.75 to ~3 on 8 cores —
  confirming CP-D's four red full-suite attempts were the external-load artifact, not a product bug;
  `audit:prod` and `license:prod` exit 0 with the worktree still clean. Branch pushed and **PR #19**
  opened against `main`. **NOT merged — two red checks, neither a code defect.** (1) `secret-scan`
  failed on 25 gitleaks findings, all false positives, remediated in `627f874`
  (`ci: allowlist two proven secret-scan false positives`): `API_ACTION_CATALOG_HASH` (a published
  content digest, 24 hits = one per commit that changed it) and
  `"password: abcdefghijklmnop123"` (a NEGATIVE test input the supervisor's own detector is asserted
  to FIRE on). Both exceptions are AND-scoped to one exact path + line shape like the three already
  in `.gitleaks.toml`, `useDefault` stays true, and the scoping was verified ADVERSARIALLY —
  planting a real credential into each of those two files is still reported at the planted line.
  `workflow-contracts` pins the exception count, moved 3 -> 5 in the same commit. Git-mode scans of
  the PR range (145 commits) and full history (754 commits) now both report no leaks.
  (2) **The required `verify` check fails at step 11, "Bind reviewed Marketplace media to the exact
  source candidate" — and fails IDENTICALLY on `main`, which has been red since 21 July.** CI step 7
  `npm run verify` itself PASSES, as do `audit:prod`, `license:prod`, the perf gate, workflow
  validation, `browser-e2e`, `dependency-review`, and CodeQL analyze. The step's gate
  (`marketplace-media-binding.ts:181`) requires every change between the frozen v1 release candidate
  `0b1c6794` and HEAD to touch only allowlisted `evidence/` paths; this branch has 391 non-evidence
  files changed, as any v2 rewrite must. It is therefore structurally unpassable on any commit that
  is not the frozen v1 candidate or an evidence-only descendant, and it also blocks T18-C's
  expectation of re-running candidate gates on a commit on `main`. Left for the owner: it needs a CI
  decision (make step 11 conditional, drop it from the required check, or accept an explicit
  bypass), which rule 5 forbids me from taking unilaterally. Live: `live_not_run_missing_credentials`.
  Default engine: `v1`. Next: `T18-A`.
- **T18-A CLOSED:** the deploy transaction now proves candidate, rollback, and database-instance
  identity before any Railway mutation. (1) `ASSISTANT_ENGINE` and `DATABASE_PATH` joined
  `ROLLBACK_KEYS`, the read-only snapshot, and the desired set — restoring only `RELEASE_*`/`LLM_*`
  after a failed upload would have left the PRIOR code serving with the NEW engine and database, i.e.
  v1 code on an empty v2 database with engine v2. (2) The staged bytes are bound to the candidate:
  `verifyReleaseSourceBinding` rehashes the real staged tree against `RELEASE_SHA` +
  `RELEASE_BUILD_HASH` before the first variable mutation, replacing a bare
  `statSync(staging).isDirectory()` whose real binding lived only in procedural runbook shell; a
  `ROLLBACK_SOURCE_DIR` must exist and must not be the staging directory. The verifier is injectable
  ONLY so the ordering tests need not materialize an archive — the default is the real one and a
  rejecting verifier is proven to stop the transaction with zero uploads. (3) Unused-path proof:
  `SELECTED_DATABASE_PATH` must be an exact absolute path under `/data`, and
  `SELECTED_DATABASE_PATH_DISPOSITION` (`new_unused` | `existing_expected`) is checked against
  Railway's own pre-mutation snapshot in BOTH directions, so a cutover cannot claim a fresh database
  while pointing at the live one, nor claim an existing one while introducing a new path. Paired with
  a fail-closed `StoreOptions.mustExist` (`new Database(path, {fileMustExist: true})`), because plain
  `new Database(path)` creates a missing file that then migrates and presents as a perfectly healthy
  EMPTY install. (4) `validatePredeployBackupGate` now requires `metadata.source` and matches it to
  the deploy's `expectedSourceDatabasePath` — `backupDatabase` always recorded the source but no gate
  read it, so with two databases on the volume a backup of the WRONG one passed every other check
  (correct checksum, bytes, integrity, schema, freshness). (5) New `verifyFreshDatabase` verifies a
  database the cutover just CREATED, which the restore verifier structurally cannot: it needs
  checksum/metadata sidecars a fresh file never had and hard-fails on `no_active_installation`, since
  the reinstall happens AFTER the deploy. It opens `fileMustExist` (creating the file would make it
  pass on the very typo it catches), requires integrity, `LATEST_SCHEMA_VERSION`, and genuine
  emptiness — emptiness being the assertion that distinguishes a correctly provisioned database from
  one that silently adopted live data. (6) `syntheticProbeEnvironment` gained `assistantEngine`
  (default `v1`, preserving existing behavior), so the release path can finally prove a v2 deployment
  boots against a real database file. (7) Both runbooks' schema assertions corrected from a hardcoded
  8 to `LATEST_SCHEMA_VERSION` 12 with a 7..12 source range, and DEPLOYMENT.md's stale "current v7
  build" prose rewritten. Gate: `npx vitest run` over deploy-private-production · predeploy-backup-gate
  · restore-verification · restored-app-readiness · db-migration · release-operations-contract ·
  workflow-contracts · private-production-release-evidence · db-recovery (109 passed) +
  `type-check` + `type-check:scripts` + `lint`, all exit 0. **No Railway call and no Clockify call.**
  Counts: unchanged. Live: `live_not_run_missing_credentials`. Default engine: `v1`. Next: `T18-B`.
- **T18-B CLOSED:** `scripts/cutover-transaction.ts` plans each of the five cutover branches as a
  PURE function — no filesystem, no network, no `railway` — so an incident-time rollback is decidable
  without executing it. `planPreseed` refuses a key that already has a serving value, an engine other
  than `v1` (the preseed lands while v1 still serves), and any drift from the recorded v1 identity,
  checked in that order so a key collision is reported before the operator is sent to chase identity
  drift. `planAutomaticRollback` requires a prior value for **all eight** rollback keys and names
  every absent one, because Railway deletes cannot skip a deploy and the branch is allowed exactly one
  no-deploy set. `planSignedQuarantine` and `planSignedFullV1Rollback` both require a recorded
  signature; the latter also refuses to restore v1 code against the v2 database path and returns the
  full eight-variable set, the v1 restore source/artifact, `restoreDatabasePath`, and
  `clearsStaleInstallation: true`. `planPostReinstallFailure` permits only `full_v1_rollback` —
  after the reinstall, authority has already moved to the v2 database and there is no partial way
  back. `ROLLBACK_KEYS` is now exported from `scripts/deploy-private-production.ts` so the planner
  and the deploy transaction cover the same eight keys instead of two copies that could drift.
  **The stale-active-row attestation case is fixed WITHOUT touching `installations.ts` semantics**
  (its strictness is deliberate): `saveInstallation` deletes the prior attestation unconditionally
  and writes a new one only when the installation row was genuinely absent, so a reinstall over a
  database restored from before the outage yields an ACTIVE installation with NO attestation. The new
  `clearStaleInstallationSql(workspaceId)` returns the exact two statements — attestations first,
  then the installation row — and rejects an empty/whitespace id or one containing `'`. Both
  statements are returned even though `installation_attestations` declares
  `FOREIGN KEY (workspace_id) REFERENCES installations(workspace_id) ON DELETE CASCADE` (verified in
  `src/db/schema.ts:52`, and it is the only FK into `installations`, so the second statement cannot
  be blocked by a restricting constraint): the cascade fires only under `PRAGMA foreign_keys = ON`,
  which the store sets but the `sqlite3` CLI an operator reaches for during an incident defaults
  OFF — so the explicit attestation delete is load-bearing, not redundant. New
  `docs/adr/003-cross-database-authority.md` (Accepted) records that the token denylist
  (`retired_installation_tokens`), the lifecycle `iat` watermark
  (`lifecycle_authority_watermarks`), and the installation generation all live in the application
  database; that a fresh v2 database therefore starts with no authority history and cannot detect
  replay of a v1-retired token; that a full-v1 rollback discards every v2-era retirement; and that
  the reinstall-for-a-fresh-generation mitigation is a **known, accepted limitation, not a fix** —
  a replayed token fails on generation rather than the denylist, and only once the reinstall has
  recorded the new generation, leaving an explicit window between restore and reinstall. 19 new tests
  (12 `it` blocks, the eight-key rollback rejection expanding to one case per key) use literal
  expected values — the eight key names are written out in the test, not imported from the module
  under test — and pin check ORDER as well as each rejection: key-collision beats engine beats
  identity, and an unsigned full-v1 rollback is refused before the database paths are compared.
  Gate: focused `npx vitest run` over cutover-transaction · deploy-private-production ·
  predeploy-backup-gate · restore-verification · db-migration (84 passed) + `type-check` +
  `type-check:scripts` + `lint` + **`npm run verify` VERIFY_EXIT=0 (341 files / 5,235 tests, zero
  flakes on the first run)**, all exit 0 — 5,235 is exactly the 5,216 baseline plus this slice's 19. **No Railway call and no Clockify call.** Counts: unchanged
  (`ACTION_CATALOG` 171 / `MODEL_API` 127, catalog hash
  `fb3c3b5c4787767e6cde921f735f8d5eab55aadde7e5a166aefe0db2a1c75bce`). Live:
  `live_not_run_missing_credentials`. Default engine: `v1`. Next: `B2` — the CI step-11 / merge
  decision, which is the owner's to make.
- **B2 CLOSED (owner decision taken, implemented as scoped option A):** the owner chose "B or C,
  whatever you think best". **B as printed was insufficient and was NOT shipped:** the required
  `verify` job carries **two** v1-candidate-frozen evidence gates, not one — step 11 "Bind reviewed
  Marketplace media to the exact source candidate" and step 12 "Validate machine-bound DeepSeek
  benchmark evidence". Both bind to the frozen v1 candidate `0b1c6794` and require every change since
  it to be evidence-only, so both are structurally unpassable on a v2 branch; CI only ever reported
  step 11 because the job died there first. Reproduced locally at `053bf34` on a clean checkout: step
  11 EXIT=1, step 12 EXIT=1, and for step 12 the cause was proven rather than inferred against
  `assertEvidenceCommit` (`scripts/evidence/deepseek-release-evidence.ts:1769`) — its first three
  guards PASS (HEAD equals the evidence sha, checkout clean, candidate IS an ancestor) and only the
  evidence-only-diff guard fails, at **401** non-evidence paths (not the 391 the plan recorded, which
  predated A0/T18-A/T18-B). Removing step 11 alone would have moved the failure down one line, so it
  was reported and the owner authorized gating both. New `scripts/evidence/v1-candidate-build.ts`
  decides **applicability only** and weakens neither gate: when it reports `true` both run completely
  unchanged and enforce their own full checks. It imports `isReleaseEvidencePath` from the gate itself
  rather than restating the path rule, so the two cannot drift. Fail-closed by construction — it
  prints only `true`/`false` and exits **nonzero** on any error instead of reporting `false` (proven:
  a binding naming a nonexistent commit and a malformed binding both give EXIT=1 with empty stdout),
  and `git merge-base --is-ancestor` is read by exit status so only the literal `1` means "not an
  ancestor" while a real git failure rethrows (the upstream gate conflates these; the probe
  deliberately does not). The CI step validates the value against the two literals **before** writing
  `$GITHUB_OUTPUT`, which also stops a multi-line value from injecting extra step outputs; no
  untrusted event input is interpolated anywhere. **Empirically proven, not assumed** — probe `false`
  on this branch (401 non-evidence) and `false` on `origin/main` `d0f29bc` (22 non-evidence), so both
  skip and **`main`'s `verify` job goes green**; probe `true` at `bbd4c29`, the real v1 evidence
  commit, where **step 12 passes (EXIT=0)** — the gate is genuinely preserved where it applies.
  **Two findings recorded, NOT fixed and NOT hidden:** (1) step 11 still fails at `bbd4c29` for a
  reason unrelated to the evidence-commit gate; it is pre-existing, manifests only on a v1-candidate
  build (which neither `main` nor this branch is), and is out of scope here. (2) The frozen candidate
  commit `0b1c6794` is not itself a "candidate build" by the gates' own rule: the binding checked in
  **at** `0b1c6794` names the *previous* candidate `590c0e1d`, so the probe correctly reports `false`
  there — only the later evidence commit that recorded `0b1c6794` qualifies. The
  `workflow-contracts` contract pins that BOTH gates carry the condition, that the probe precedes
  them, and that the value allowlist exists; its non-vacuity was proven by deleting one `if:` and
  observing the exact failure, then restoring the file byte-for-byte from a copy (never
  `git checkout --`). Gate: `npx vitest run tests/unit/v1-candidate-build.test.ts
  tests/unit/workflow-contracts.test.ts` (12 passed) + `actionlint` 1.7.12 exit 0 on `ci.yml` and on
  all workflows + `type-check` + `type-check:scripts` + `lint` + **`npm run verify` VERIFY_EXIT=0
  (342 files / 5,242 tests, zero flakes)**, all exit 0. **No CI run was triggered, nothing was
  pushed, PR #19 was not merged, and no Railway or Clockify call was made.** Counts: unchanged. Live:
  `live_not_run_missing_credentials`. Default engine: `v1`. Next: push authority for this branch is
  the owner's to grant; then `B3` (T18-C, per-step authority required).
- **GATE 0 CLOSED (cutover credential/authority inventory):** node `v22.23.1`, Railway CLI exactly
  `5.27.0`, HEAD as expected, worktree clean. `railway whoami` (owner-granted read) returned exit 0 —
  the stored `accessToken` had nominally expired `2026-07-21T05:39:50` but the CLI refreshed it
  silently, and the project is linked (`ai-assistant-clockify`, production). **Three findings that
  change later phases, recorded here so they are not rediscovered at the boundary:** (1) `D6` cannot
  run as printed — `scripts/live-v2-full.ts` reads FIVE variables and `.env` supplies three; both
  `LIVE_SACRIFICIAL_WORKSPACE_MARKER` (the owner attestation that the workspace is disposable; the
  script explicitly refuses a workspace id as proof) and `LIVE_V2_CLEANUP_REGISTRY_PATH` are absent,
  so the harness returns `status: "refused"` / exit 2. `LIVE_WORKSPACE_ID` does match the recorded
  sacrificial workspace `65b3…b60e`. (2) `npm run eval:*` and `npm run live:*` are bare
  `tsx scripts/…` with **no `--env-file`**, so they read only the ambient shell — with `LLM_*` unset
  in the shell they emit `not_evaluated_missing_credentials` regardless of what is on disk. X-I
  therefore requires an explicit export, not merely a populated dotenv. (3) `.env` and `.env.server`
  name **different models** (`deepseek-chat` vs `deepseek-v4-pro`) on the same base URL and key; the
  recorded history is that this key exposes only the V4 models, so `deepseek-chat` is stale. Which
  file is sourced binds the X-I evidence and must be decided before X-I.
- **P1 + P2 CLOSED — the v2 candidate is on `main`:** all five P1 gates exit 0 — `verify`
  (342 files / 5,242 tests), `test:e2e` (**120 passed**, Chromium+Firefox+WebKit), `audit:prod`,
  `license:prod`, clean worktree before and after. The first `verify` run exited **1** on a 30s
  timeout in `tests/integration/intent-declaration-chat.test.ts` (a file on the documented flake
  list, untouched by this work); the flake protocol was followed exactly — isolation 54/54 exit 0,
  then one full rerun green — and it is recorded as one load-flake, not waved away. e2e was
  deliberately **refused** on its first 45-minute window (`E2E_NOT_RUN=load_never_below_3.0`) rather
  than run under a competing build, and passed on the next window once load reached 2.98. Branch
  pushed `2db1458..95f53a9`; **PR #19 MERGED** 2026-07-27T02:13:50Z as squash commit
  `a369e06da895be3d161a0c6f29b3ce54115c0084` (`origin/main` `d0f29bc..a369e06`). **B2 is proven in
  CI, not merely locally:** the required `verify` check passed in 3m34s and the job's own step
  conclusions show step 11 (the applicability probe) `success` with steps 12 and 13 (Marketplace
  media binding, DeepSeek benchmark evidence) **`skipped`**, and steps 14/15 continuing to success —
  so the green is the probe working, not the job dying early. `secret-scan` also passed for the
  first time (the `627f874` allowlist), as did `browser-e2e`, `analyze`, and `dependency-review`.
  Because a squash merge mints a NEW sha, tree identity was proven rather than assumed: merged
  `main` and the CI-validated tip `95f53a9` share tree `1e47056c9fbe4417a5b927773a01c13a35a06df9`
  with an empty diff, which is what lets `D4` deploy from `main` without re-validating.
- **D1 CLOSED — private v2 candidate frozen:** `CANDIDATE_SHA`
  `a369e06da895be3d161a0c6f29b3ce54115c0084`; `CANDIDATE_SOURCE_DIR` a detached worktree at that
  exact commit (recorded in the commit body; it is fully reproducible from git, so a temp path is
  safe here — unlike a database backup, which must never live in temp). Gates re-run on the merged
  candidate, zero flakes: `npm run verify` **EXIT=0 (342 files / 5,242 tests)**,
  `npm run check:api-action-inventory` **EXIT=0**, `npm run perf:local-ui` **PASSED** (status max
  8.8ms; warm p95 110.7ms; cold fast-4G p95 479.6ms; history p95 30ms; UI gzip 20,812 / 21,504).
  Counts unchanged and matching the pre-merge record exactly: `ACTION_CATALOG` **171** ·
  exposures `api` **127** · `composite` **24** · `generic` **16** · `local` **4**; catalog hash
  `fb3c3b5c4787767e6cde921f735f8d5eab55aadde7e5a166aefe0db2a1c75bce`. No Railway call, no Clockify
  call, no live write. Live: `live_not_run_missing_credentials`. Default engine: `v1`. Next: `D2`
  (verified v1 rollback preparation), then `D3` (§3.1 — the runbook still derives `RELEASE_SHA` from
  the frozen **v1** binding `0b1c6794`, which would upload v1 source under `ASSISTANT_ENGINE=v2`).

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
  one preview → one Confirm → atomic `runComposition`, mirroring `onboard_user`).
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
  `writeAuthorityFor()` before returning an immutable definition. Every metadata
  field participates in action fingerprints and registry/catalog hashes; no
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
  contract. V2 coexists under `src/assistant-v2/`; the sole rewrite switch will be
  `ASSISTANT_ENGINE=v1|v2`, defaulting to v1 until the authorized cutover.
  During coexistence, v1 accepts only critical safety, production, and verified Clockify-contract fixes.

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
npm run generate:api-action-inventory # regenerate TS, JSON, and Markdown from one evidence model
npm run check:api-action-inventory # fail if inventory artifacts or classifications drift
npm run test:e2e       # Chromium + Firefox + WebKit product/browser matrix
npm run perf:local-ui  # local UI, history, status, and 20 KiB gzip gates
npm run media:marketplace # deterministic icon/banner/screenshots/demo package
npm run audit:prod     # fail-closed production advisory gate
npm run license:prod   # production license gate + deterministic JSON report
npm run eval:smoke     # offline scripted safety corpus; no network/credentials
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

Manual `release-evidence.yml` records the exact commit SHA, API-validated reviewed
PR/head/CI/CodeQL identities, and three hashed zero-retry Vitest count reports
(minimum 2,366 passed with zero skipped/todo) plus machine conclusions for verify,
production audit/license, CodeQL, gitleaks,
`eval:smoke`, SBOM, live smoke, backup/restore, deterministic DeepSeek safety, and
production AUDIT-host clearance. Only the three admin packages named above are
human `not_evaluated` gates. Workflow presence is not sign-off, deployment
evidence, or Marketplace approval; no workflow deploys or submits the add-on.

All artifacts accepted by the current DeepSeek, private-production, live-browser,
and aggregate release validators are historical v1 evidence. Their derived
conclusions carry `assistantEngine: "v1"`, `evidenceStatus: "historical"`, and
`validForV2: false`; requesting a v2 conclusion is rejected before artifact
parsing. Legacy input schemas and recorded hashes remain unchanged for v1 rollback.

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
