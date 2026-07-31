# V2 closure — release acceptance matrix, locally provable rows (2026-07-29)

Status record for the 2026-07-28 adversarial review's release acceptance
matrix, run against the real production composition on `main` at the closure
series head (`c9a04f1` + the F24 tooling/docs commit). "Local PASS" means the
row's proof ran on this machine through `npm run verify` (full gate, exit 0,
5,372+ tests at this writing) and/or the browser matrices; rows that require
credentials, live Clockify, production, or an owner decision are listed as the
OPEN GATES they are — nothing here claims them.

Composition ground rules for every local row: real `createApp`, real SQLite
with real migrations/transactions, production catalog and routers, session
auth; only the model client (scripted) and the Clockify port (fake workspace)
are substituted, at their production injection seams
(`tests/helpers/v2-production-composition.ts`); the browser rows additionally
run the tsc-built server over HTTPS with real signed-JWT component auth and the
built UI bundle (`npm run test:e2e:real`), with no hand-authored frames.

| Journey row | Verdict | Local proof |
|---|---|---|
| Identity/transcript | **local PASS** | `tests/integration/v2-request-run-message-identity.test.ts` (one linked request/run/user/assistant chain; retry + 409 conflict), `v2-turn-delivery.test.ts` |
| Read | **local PASS** | `v2-production-composition.test.ts`, `v2-turn-delivery.test.ts`; browser: read journey + reload + replay (no second provider/Clockify call) |
| Read failure | **local PASS** | `v2-read-failure-settlement.test.ts` (typed failure, drained workers, terminal run, next message); browser: read-failure journey |
| Clarification/resume | **local PASS** | `v2-clarification-producer/route.test.ts`, `v2-write-clarification-lifecycle.test.ts`; browser: chip resolve + free-text continuation; write choice transitions directly to preview (PR 4) |
| Single write | **local PASS** | `v2-confirmation-run-lifecycle.test.ts`; browser: preview with zero pre-confirm mutation → one-button confirm → terminal receipt (mutation count 0 → 1) |
| Cancel/expiry | **local PASS** | `v2-confirmation-run-lifecycle.test.ts` (cancel/expiry create canonical terminal results, run terminal); browser: cancel + clock-advanced expiry journeys, zero mutations |
| Batch | **local PASS** | `v2-confirmation-run-lifecycle.test.ts` batch describe (aggregate settle, member statuses); browser: exact batch Confirm-all (2 mutations), Cancel-all (0), ambiguity stop (0) |
| Deterministic guards/FIFO | **local PASS** | `v2-deterministic-chat-guards.test.ts` (whitespace/typed consent: zero provider calls), `v2-session-fifo.test.ts` (one ordered session lock across chat/confirm/clarify) |
| Duplicate request/write | **local PASS** | request replay (identity suite + browser replay journey: providerCalls unchanged); `v2-runtime-limits.test.ts` (run-wide toolCallId uniqueness, canonical duplicate-write rejection pre-persistence) |
| Logical budgets | **local PASS** | `v2-runtime-limits.test.ts` (13th of 13 reads denied against remaining allowance; writes counted; active-wall boundary enforcement) |
| Host budget | **local PASS** | `v2-host-call-budget-runtime.test.ts` (61st physical call denied pre-dispatch; reservation convert/release; restart reloads the persisted ledger) |
| Provider budget | **local PASS** | run-service suites (attempt-1 failure charged at attempt-2 start; both-fail charges both; usage accepted only as finite nonnegative safe integers) |
| Discovery | **local PASS** | `api-discovery-service` coverage via `v2-runtime-limits.test.ts` (strict parse; invalid input never invokes search; access/groups/limit forwarded + journaled) |
| Lifecycle race | **local PASS** | `v2-installation-generation-race.test.ts` (post-boundary generation change produces no result/audit/message row; `installation_changed` surfaced) |
| Presentation | **local PASS** | `unit/result-view-service.test.ts` (human title/facts; fail-closed `unrecognized_result_shape`); browser cards render titles/facts live AND on history restore |
| History/control | **local PASS** | `v2-restore-control-source.test.ts` (one v2 control source, rotate-once-per-page); browser: stale-nonce re-arm via the run-event page; history switcher restores without live controls |
| Audit/metrics | **local PASS** | `v2-audit-telemetry.test.ts` (one bounded audit row per settled action; one invocation-telemetry record from the persisted budget) |
| Browser | **local PASS** | `npm run test:e2e:real`: 15 journeys × Chromium/Firefox/WebKit = 45/45 against the tsc-built real Express/SQLite path; fixture suite relabeled renderer/contract (120/120 × 3) |
| Release | **OPEN GATES** | exact protected remote SHA + branch protection, fresh v2 credentialed model evidence (`LLM_*`), live sacrificial gates (`live:v2-full`), ADR-compliant database boundary (owner F24 decision; planner+boot enforcement is in place), backup/restore on the candidate, Operation 11B, the [7-day soak](./V2_SOAK_SPEC.md), sign-off |

Scanner note closure: `gitleaks git` over full history reports no leaks with
the narrowly scoped policy in `.gitleaks.toml`; adversarial proof — planting a
`sk_live_…` stripe key and a hex `clockify_api_key` into the two newly
allowlisted files is still detected at the planted lines with exit 1.
