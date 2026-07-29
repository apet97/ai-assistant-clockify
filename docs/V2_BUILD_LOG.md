# v2 build log

Chronological record of the API-agent v2 rewrite (T00 through the production
cutover and the post-cutover repairs). Moved out of `CLAUDE.md` and `AGENTS.md`
on 2026-07-28 so those files state the CURRENT contract rather than the whole
history — nothing here was edited, only relocated.

Read this when you need to know *why* something was built the way it is, or to
avoid re-deriving a decision. For what is true right now, read `CLAUDE.md`.

---

## From CLAUDE.md

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
  the supervisor detector's fake `password:` negative-test input (the exact literal lives only in
  `tests/scripts/test_codex_v2_supervisor.py`, where the detector is asserted to FIRE on it).
  Both exceptions are AND-scoped to one exact path + line shape like the three already
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
- **D3 CLOSED — the v2 cutover deploy is bound to the v2 candidate (§3.1 resolved as option (i)):**
  the owner delegated the (i)/(ii) choice ("You do everything go"); **(i)** was selected and the
  reasoning is recorded rather than the choice merely asserted — option (ii) would mean authoring a
  v2 `deepseek-release-binding.json`, but that artifact carries `rawAggregateSha256` and
  `thinkingMode` from a **measured** benchmark run, and with no `LLM_*` in the shell the eval
  reports are `not_evaluated_missing_credentials`, so writing one now would be inventing benchmark
  evidence (rule 10). Both runbooks (`DEPLOYMENT.md` and
  `docs/marketplace/03-operations-evidence-rollback-package.md` — the contract test loops over both,
  so correcting only one would have failed) now capture `BINDING_CANDIDATE_SHA` separately, allow
  the implicit binding-derived `RELEASE_SHA` **only** when `EXPECTED_ASSISTANT_ENGINE` is `v1`, and
  hard-refuse a non-v1 deploy whose `RELEASE_SHA` still equals the binding's candidate. This is a
  guard, not a comment: the v1-source-under-v2-engine upload is now impossible rather than merely
  documented. `evidence/performance/deepseek-release-binding.json` is **provably unchanged**
  (`git diff` empty), and the pre-existing pins still hold — `binding.candidate.testedSha` remains
  present and no `RELEASE_SHA="$(git rev-parse HEAD)"` line was introduced (the contract test
  forbids exactly that string). One new `release-operations-contract` case pins the guard in both
  files **and its ordering** (the engine check must precede the staging `git archive`); its
  non-vacuity was proven by mutation — deleting the guard line failed exactly 1 test, and the file
  was restored from a copy, never `git checkout --`.
- **Three findings from D3 that govern D2/D4 — read before starting either:**
  (1) **`PREDEPLOY_EVIDENCE_MAX_AGE_MS = 60 * 60 * 1_000`** (`scripts/evidence/predeploy-backup-gate.ts`),
  applied to **both** `backupCreatedAt` and `readinessConfirmedAt` against the gate's clock. D2 and
  D4 are therefore **not separate tasks** — they are one atomic **≤60-minute** transaction, and if
  the window lapses the backup must be retaken. D3 was deliberately executed BEFORE that window
  (a recorded deviation from the printed order): it changes `DEPLOYMENT.md`, needs a full
  `npm run verify`, and produces a commit, none of which depend on the backup, so running it inside
  the window would burn a large fraction of the hour on unrelated work. Order was changed; no step
  was skipped.
  (2) `validateRestoreEvidence` binds `releaseSha`/`buildHash`/`serverArtifactSha256`, and
  `db:verify-restore` is `npm run build && tsx scripts/verify-restored-db.ts` — the verifier reads
  the identity from **env** but builds from the **current checkout**, while `DEPLOYMENT.md`'s
  evidence block asserts `test "$RELEASE_SHA" = "$(git rev-parse HEAD)"`. So the deploy candidate is
  **HEAD at deploy time (the D3 commit)**, superseding D1's frozen `a369e06` as the value of
  `RELEASE_SHA`. D3 changed only two runbooks and one test — nothing compiled — so the built
  artifact is unchanged; only the source-tree hash moves. The existing 21 July evidence is unusable
  twice over: 6 days stale, and bound to `releaseSha d0f29bc…`.
  (3) A **v8 → v12 migration is supported and expected**, not a failure: restore verification
  reports `migration: "candidate_private_clone"` whenever the source version differs from
  `LATEST_SCHEMA_VERSION`, then re-checks integrity and schema post-migration. Production v1 is
  `sourceUserVersion: 8` with **4 active installations**.
- **D2's flagged `token_backed_read` question, answered from evidence and recorded early:** the
  review asked whether a restored pre-cutover v1 backup returns **401**. It does **not** — the
  21 July drill's `restore-verification.json` records `tokenBackedRead: passed, GET /user,
  httpStatus 200, redirects blocked`. **But the procedure the plan asked for still applies, for a
  different reason:** D5's reinstall retires the v1 installation token and increments the
  generation, so **every pre-reinstall v1 backup will fail `token_backed_read` from that moment
  on**. Consequence, to be applied at Phase F and at any post-cutover deploy: `gate:predeploy-backup`
  can only be satisfied by a **post-reinstall** backup. Capture one immediately after D5 succeeds;
  do not plan to rely on a backup taken before the reinstall.
- **2026-07-27 — production outage repaired, then v2 cutover executed WITHOUT the predeploy backup
  gate (owner-directed).** Found production **down**: `404 Application not found`, service `Failed`,
  20 deployments (18 `REMOVED` / 2 `FAILED`, zero successful), so Railway had no image to roll back
  to. Root cause was **not** the variables — `RELEASE_SHA`/`RELEASE_BUILD_HASH`/
  `RELEASE_SOURCE_BINDING_SHA256` already matched `d0f29bc` exactly; the previously uploaded *tree*
  did not match its binding, so `prebuild` failed `Release source binding verification failed`.
  Unsetting the binding cannot fix it: with `NODE_ENV=production` the third branch of
  `release-source-binding.ts` throws `source_binding_required`. Fixed by uploading the exact
  `git archive d0f29bc` staging tree plus its `--write` binding — verified in-container as
  `release source binding: verified bce29b95…` on the first attempt. **The deploy deadlock is real
  and has no in-repo escape:** `deploy-private-production.ts:228` runs `gate:predeploy-backup`
  unconditionally before any Railway mutation, the gate needs a ≤60-min-fresh backup, and the backup
  needs a running service. **Railway SSH does not reach the container on this account** — `railway
  ssh`, `railway volume files`, and direct OpenSSH to the exact `user@host` from Railway's own
  `ssh config` block all return the account-level management API, never a shell; a release-only key
  was registered, proven useless, and fully revoked (key deleted, `known_hosts` restored byte-exact).
  So the online backup is **dashboard-Console-only**. v1 `d0f29bc` was restored first as the
  runbook's "exactly one current-source bootstrap deployment" (DEPLOYMENT.md:533) — safe because
  v1 and the production database are **both schema 8**, so no migration ran. The owner then directed
  the v2 cutover three times without a fresh backup; it was executed by hand-rolling the variable set
  + `railway up` past the gate, with the 8 rollback keys snapshotted to
  `…/20260727T091547Z/pre-v2-rollback-snapshot.json` on the encrypted volume first. Result: **v2 is
  live** — `/version` `releaseSha 29b2e5bcd6f3a92685b6ffcab5069aa2a7d0a4fc`, `buildHash d565c5c9…`,
  `sourceBindingSha256 501818c2…`, `modelConfiguration.assistantEngine "v2"` (nine-key deployed
  schema), `/live` + `/manifest` 200, `/health` `{"ok":true}` (the bounded committed-write probe, so
  the 8→12 migration committed and the database is writable), clean startup with no migration error.
  `DATABASE_PATH` unchanged at `/data/ai-assistant.sqlite` (`existing_expected`), so installations
  were migrated in place rather than reset. **Outstanding and NOT done:** no backup of the schema-12
  database exists anywhere — the newest artifact is the 21 July schema-8 set, which remains a valid
  but 6-day-stale fallback (restoring it yields v8, which v2 re-migrates on boot); no post-cutover
  backup/restore drill, no `gate:predeploy-backup` evidence, and no functional Clockify verification
  (sidebar chat, a read receipt, a risky-write preview) has been performed against v2.
- **2026-07-28 — v2 service restored after a second outage, and v2 RISKY WRITES ARE CONFIRMED
  NON-FUNCTIONAL.** The cutover container ran cleanly `09:36:28Z -> 10:23:10Z` then took an
  external `SIGTERM` with **zero** restart attempts despite `ON_FAILURE`/5 retries (cause
  unexplained; no billing banner). Railway then had no active deployment and every one of the 20
  was `REMOVED`/`FAILED`. **Five redeploy attempts failed, and the mechanism is the durable
  lesson: Railway's "Redeploy" performs a full Nixpacks REBUILD from that row's stored source
  snapshot — it does NOT relaunch the stored image.** So only the v2 cutover row can succeed;
  every other row rebuilds a tree that fails `prebuild` with `Release source binding
  verification failed` (the guard correctly refusing to start v1 code against a v12 database).
  `railway deployment redeploy` also takes no deployment-ID and aimed at a months-old `FAILED`
  v1 row. Four redeploys created inside one second also proved Railway marks earlier ones
  `REMOVED` even when the later ones fail, with no fallback to the older successful deployment.
  Service was restored by owner-authorized upload of a verified staging tree — `git archive
  29b2e5b` + `scripts/release-source-binding.ts --write` reproduced `RELEASE_BUILD_HASH
  d565c5c9…` and `RELEASE_SOURCE_BINDING_SHA256 501818c2…` exactly before any upload — via
  `railway up --ci` (bypassing only the structurally-unsatisfiable `gate:predeploy-backup`;
  zero variable mutation). Deployment `af965b6e` `SUCCESS`; `/version` confirms `releaseSha
  29b2e5b…`, `assistantEngine "v2"`, and `serverArtifactSha256 e9fdd6de…65d2d` — byte-identical
  to a local Node 22 build, so the drill environment provably matches production.
  **Functional verification then FAILED:** the sidebar loads and session/auth work (OWNER), but
  `Create a project named asdasdsa` terminates as `Assistant run failed: budget_exhausted` after
  ~12s. Root-caused to a **deterministic livelock, not a budget problem**: token preflight is
  ruled out empirically (1,420-byte first request vs a 32,000 allowance) and discovery is ruled
  out empirically (`clockify_projects_create` ranks first and loads correctly; its only required
  argument is `name`). `budget_exhausted` comes from `runner.ts:201` — the loop exhausting
  `maxModelCalls` 6 — because `buildFreshMessages` sends only the system prompt plus the original
  request, never prior tool calls or their denial reasons, and the 586-byte system prompt never
  mentions denials. **So a denied write makes iterations 2-6 byte-identical and the run provably
  cannot progress.** The true code is persisted (`OperationPreparationService.prepare` records an
  `errorReceipt`) but only an allowlist surfaces as `denied`; everything else is flattened to
  `write_port_not_ready`, and `action-execution-service.ts:290-294` is a bare `catch {}` that
  discards the exception. The admin also never sees the denial receipt the v1 product contract
  guarantees. **Why it shipped green: `budget_exhausted` appears in exactly one test file as a
  metrics fixture string — no test drives `runAssistantV2` to a denied write and asserts the run's
  terminal outcome; all seven write parity matrices assert only `prepare -> prepared -> confirm`.**
  Also confirmed unwired at file:line — `run-event-hydration.ts` hardcodes `facts: []` /
  `references: []` on every branch and uses the raw action name as `title`, so Task 15's
  presenters for all 127 model-API actions are dead code in production. Handoff with the full
  actionable list, ranked hypotheses, and three staged drill scripts:
  `~/Downloads/ai-assistant-v2-SESSION-PROMPT.md` + `~/Downloads/ai-assistant-v2-drill/`.
  Still outstanding: no schema-12 backup exists; no `gate:predeploy-backup` evidence.
- **2026-07-28 — the v2 livelock is fixed at its real root: v2 had NO tool-result feedback channel.**
  The prior entry's diagnosis was correct but narrower than the defect. `buildFreshMessages`
  (`services/run-service.ts:116`) rebuilds every provider request from the system prompt plus the
  original request, and `state.completedResults` — the only durable record of what ran — was
  consumed at `runner.ts:144` ONLY when `resumingExistingRun`, and even then as
  `"<action> completed (result <opaque-id>)"` carrying no payload. So the model never received tool
  results in EITHER path. It is therefore not only a denied write that livelocks: **a successful
  read livelocks identically**, because the model is never shown what it returned, cannot answer
  the admin from it, and has no reason to stop asking. Every run that is not a write-preview
  suspension burns `maxModelCalls` 6 and reports `budget_exhausted`.
  Reproduced locally with no credentials in `tests/unit/v2-runner-feedback.test.ts`: **exactly 6
  model calls, byte-identical messages across iterations, terminal `budget_exhausted`** — matching
  production. Two things hid it: the unit fakes return `undefined` from `getRun`, so
  `completedResults` stays permanently empty, and scripted clients stop calling tools on cue where
  a real provider does not. Fixed in `65f3f84` + `50e6103`: new `assistant-v2/observations.ts` owns
  the bounded model-visible channel (reusing v1's `capToolResultForModel` cap, so both engines
  prune identically); a successful read carries `modelSummary` while the canonical `action_results`
  row keeps the full receipt; the runner accumulates observations across the invocation and
  rebuilds them into every request; a repeat of the same calls yielding the same observations stops
  with the real reason instead of spending the budget; budget exhaustion after a denial reports the
  denial; `prepareWrites`'s bare `catch {}` no longer discards the cause; and a failed read now
  journals a terminal `tool.denied` (it previously emitted `tool.requested` + `tool.started` and
  nothing, so timelines lied about in-flight reads — the Task 4 item 2 gap). `tool.denied` bounds
  `code` at 256 UTF-8 bytes, so a code built from a thrown exception is truncated at the source;
  the first attempt was itself off by the ellipsis width and its own test caught it.
  **Correction to the prior entry:** hypothesis 4 (`policy_denied` from a partial policy row) is
  not needed to explain production — the livelock reproduces with any non-progressing outcome,
  including a fully successful read, so the terminal string discriminates nothing.
  **Ordering correction:** the handoff's "backup, then fix, then deploy" is backwards.
  `predeploy-backup-gate.ts` binds `releaseSha`/`buildHash`/`serverArtifactSha256` to the candidate
  being deployed, so a backup taken before the fix cannot validate the deploy that follows. Correct
  order is fix → commit → clean tree → drill against the new HEAD → deploy.
  Also fixed (`c633943`): four variables required by `deploy-private-production.ts` /
  `predeploy-backup-gate.ts` (`SELECTED_DATABASE_PATH`, `SELECTED_DATABASE_PATH_DISPOSITION`,
  `PREDEPLOY_SOURCE_DATABASE_PATH`, `ROLLBACK_SOURCE_DIR`) appeared in NEITHER runbook — a literal
  read-through of the documented export block threw before any Railway call. The handoff recorded
  only one of the four. `ROLLBACK_SOURCE_DIR` is now derived from `/version.releaseSha` rather than
  hand-supplied. Both new contract cases were mutation-tested and the runbook restored byte-exact
  from a copy. The drill scripts no longer hard-code the candidate identity (a stale pin silently
  produces evidence that cannot validate the deploy it is for).
  Pre-deploy Railway state read (allowlisted keys only, no secret printed):
  `DATABASE_PATH=/data/ai-assistant.sqlite` (so `existing_expected` is correct),
  `ASSISTANT_ENGINE=v2`, `RELEASE_SHA=29b2e5b…`, `LLM_REASONING_EFFORT` ABSENT,
  `LLM_THINKING_MODE` PRESENT, `DATA_ENCRYPTION_KEY_PREVIOUS` ABSENT (not a rotation drill),
  33 variables.
  Gate: `npm run verify` **VERIFY_EXIT=0 (343 files / 5,250 tests)** on the clean rerun; an earlier
  run showed 4 `routes.test.ts` failures that passed 25/25 in isolation — the documented
  `f1-verify-flake-diagnosis` pattern. **NOT verified: the fix is proven against fakes only.**
  `runAssistantV2` has never been driven end to end against a real provider, and the three
  `eval:*` scripts still emit `not_evaluated_missing_credentials`. The first real evidence the
  livelock is gone will be the post-deploy sidebar check. No Railway mutation and no Clockify call
  were made in this session. Still outstanding: no schema-12 backup exists; no
  `gate:predeploy-backup` evidence; Task 3's presentation layer remains dead code.
- **2026-07-28 — the livelock fix is DEPLOYED, and the first schema-12 backup + predeploy gate
  evidence now exist.** Production serves `releaseSha 34b9d05905cbd71c9cfb72236e1f824129ed5f63`,
  `buildHash 5d0c575e…`, `serverArtifactSha256 fdfae8d9…` (byte-identical to a local Node 22 build),
  `sourceBindingSha256 2557f138…`, `assistantEngine "v2"` (nine-key deployed schema); `/live`
  `/health` `/manifest` `/version` all 200 and `/health` is `{"ok":true}`, so the database is
  writable. Deployed through the full unmodified `npm run deploy:private-production` — NOT the
  outage-recovery `railway up` path — with `gate:predeploy-backup` satisfied for the first time
  since the cutover. `DATABASE_PATH` unchanged (`existing_expected`).
  **Correction to the 2026-07-27 entry — Railway SSH DOES reach the container.** That entry records
  `railway ssh` as returning "the account-level management API, never a shell" and says "do not
  retest it". Retested at the owner's direction: the only blocker is a REGISTERED SSH KEY. With one
  registered, `railway ssh -i <key> -- <cmd>` runs in the container (`node v22.14.0`, root in
  `/app`, `/data` writable) and `scp` works against the `ssh.railway.com` host from
  `railway ssh config`. CLI version is irrelevant — 5.30.1 behaves identically to the pinned 5.27.0,
  which the deploy hard-requires and which was left untouched (5.30.1 was fetched side-by-side and
  discarded). **Consequence: the backup and its download are fully scriptable; the dashboard
  Console + Save-As step is not required.** The temporary key was revoked, the local keypair
  deleted, the `~/.ssh/config` block removed, and `known_hosts` restored byte-exact — so
  reproducing this needs a deliberate `railway ssh keys add` first.
  **Two drill-blocking defects found and fixed, both of which would have blocked any future
  operator:** (1) `drill-phase2-finalize.sh` prompted for `DATA_ENCRYPTION_KEY (production, 64 hex
  chars)` — it is NOT hex; `config.ts` accepts any string >= 32 chars and `encryption.ts:14`
  SHA-256s it to derive the AES key. The real key is 64 chars of mixed case including
  non-alphanumerics, so the prompt made a correct key look wrong and cost a drill run
  (`token_decryption_failed`). (2) `readInstallation` selected the token-probe target with
  `ORDER BY workspace_id LIMIT 1` — deterministic but arbitrary. Production has FOUR active
  installations (three migrated v1 dev-console rows from June plus the live workspace), and the
  lexicographically first, `640f2540…`, is dead: the drill reported `token_backed_read 401` and
  blocked the deploy on a backup that was demonstrably good (probing all four: 3x200 including the
  live workspace at generation 3, 1x401). Fixed in `34b9d05`: the primary is the most recently
  updated active installation (workspace_id breaks ties), every other active installation is probed
  and RECORDED in the evidence as `workspaceSha256` (never the raw id — an existing secret-free
  assertion enforces that, and `installation_attestations.workspace_sha256` sets the precedent),
  and a dead PRIMARY still fails the drill (pinned by its own test so this cannot decay into "any
  installation will do").
  **Recorded, not fixed (owner-scoped-out as migrated v1 data):** `640f2540…` is `active` with a
  token Clockify rejects and has NO retirement, tombstone, or attestation — the single
  `retired_installation_tokens` row belongs to the current workspace's 00:38:28Z reinstall, and the
  only attestation is the current workspace's. That is a real lifecycle inconsistency; it is now
  visible in every drill's evidence instead of silently deciding the gate.
  Backup/evidence: `/Volumes/AIASSIST_RECOVERY/ai-assistant/34b9d05…/20260728T023910Z/`, source
  `/data/ai-assistant.sqlite`, sha256 `ee3b78f8…`, format 2, schema 12 (`migration:
  "not_required"`), RTO 8,550ms, RPO 33,166ms, `conclusion: passed`. The earlier
  `20260728T013529Z` directory holds a valid checksum-verified backup but a FAILED verification and
  muddled provenance (finalized, copied back to `.partial`, re-finalized) — it is a spare copy, NOT
  gate evidence.
  Gate: `npm run verify` **VERIFY_EXIT=0 (343 files / 5,254 tests)** on a settled machine
  (load 2.92/3.95). Four earlier full runs failed, each a TIMEOUT in a different untouched file
  (`lifecycle`+`role-recheck`, `agentic-chat`, `undo-route`), each passing in isolation, with load
  averages between 4 and 37 on 8 cores — the documented `f1-verify-flake-diagnosis` pattern. One
  further run failed 1,579 tests purely because it was invoked without the Node 22 PATH export and
  hit `better-sqlite3` `NODE_MODULE_VERSION 127` vs `147`; that was operator error, not a
  regression.
  **STILL NOT VERIFIED — the deploy is not the proof.** The livelock fix is proven against fakes
  only: no test drives `runAssistantV2` against a real provider, and the three `eval:*` scripts
  still emit `not_evaluated_missing_credentials`. The first real evidence is a sidebar check
  (`Create a project named …` must reach a preview, and `list my projects` must return a grounded
  answer instead of `budget_exhausted`). Task 3's presentation layer remains dead code
  (`run-event-hydration.ts` still hardcodes `facts: []`/`references: []` and uses the raw action
  name as `title`). This docs commit lands AFTER the deployed candidate, so local HEAD is one
  docs-only commit ahead of what production serves — the same benign state as `b62cf42` was.


---

## From AGENTS.md

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

