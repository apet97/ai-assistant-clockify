# Historical v1 release-candidate evidence - version 1.0.0

Status: **HISTORICAL V1 TEMPLATE - NO ROW IMPLIES A PASS; NOT VALID FOR V2**

This checked-in document preserves the historical v1 release-evidence schema/index.
In that v1 process, final values belonged in the immutable GitHub Actions
`release-evidence` artifact or PR attachment; committing the final SHA here would
have created a self-reference and changed the SHA. `PENDING CURRENT RUN` was to be
replaced only in that external v1 copy, backed by the exact evidence reference.
Do not paste secrets, prompts, customer data, raw responses, contact details, or contract
text. All referenced artifacts and conclusions are historical v1 evidence; their
bytes/hashes remain untouched for rollback, and none can support a v2 conclusion.
The Marketplace **Submit for Review** action must remain unperformed.

## Candidate identity

| Item | Record |
|---|---|
| Branch | `codex/marketplace-1.0.0` |
| Package version | `1.0.0` |
| Tested/deployed source-candidate SHA | PENDING CURRENT RUN - external immutable attestation only |
| Source-candidate archive hash | PENDING CURRENT RUN |
| Reviewed pull request number/URL, exact head/evidence-commit SHA, CI run id/URL, and CodeQL run id/URL | PENDING CURRENT RUN |
| Candidate-to-evidence diff validation | PENDING CURRENT RUN - same SHA or allowlisted evidence-only descendant |
| Release-evidence workflow run/artifact | PENDING CURRENT RUN |
| Private Railway project/environment/service | PENDING CURRENT RUN - sanitized ids only |
| Railway deployment id, `/version` SHA, and build hash | PENDING CURRENT RUN |
| Production base URL | PENDING CURRENT RUN |
| Evidence finalized at UTC | PENDING CURRENT RUN |

## Deterministic local and supply-chain gates

All local commands run with Node 22. Each cold verify is a new process and receives no
retry after failure. Every pass produces a retained Vitest JSON artifact; the immutable
release record binds its SHA-256 and exact passed/total/failed/pending/todo counts.

| Gate | Required result | Status | Evidence reference |
|---|---|---|---|
| `npm run verify` - cold pass 1 | Pass | PENDING CURRENT RUN | PENDING CURRENT RUN |
| `npm run verify` - cold pass 2 | Pass | PENDING CURRENT RUN | PENDING CURRENT RUN |
| `npm run verify` - cold pass 3 | Pass | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Full deterministic suite | Every cold pass records at least 2,366 passed tests, passed equals total, and failed/pending/todo are all zero under the checked-in four-worker, zero-retry ceiling | PENDING CURRENT RUN | PENDING CURRENT RUN |
| `npm run audit:prod` | Pass, no unallowlisted high/critical production advisory | PENDING CURRENT RUN | PENDING CURRENT RUN |
| `npm run license:prod` | Pass and deterministic production-license JSON | PENDING CURRENT RUN | PENDING CURRENT RUN |
| `npm run eval:smoke` | Pass | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Configured DeepSeek safety corpus | Five consecutive passes, zero write-safety regression | PENDING CURRENT RUN | PENDING CURRENT RUN |
| DeepSeek reasoning-setting selection | Fastest supported setting that meets the five-pass safety rule | PENDING CURRENT RUN | PENDING CURRENT RUN |
| `actionlint` | Pass for every workflow | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Local secret scan | Pass | PENDING CURRENT RUN | PENDING CURRENT RUN |
| CycloneDX SBOM | Generated for exact commit; artifact hash recorded | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Pull-request CI | First-attempt run id/URL is successful for the exact reviewed head; `verify` and `browser-e2e` jobs green | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Pull-request dependency review | Exact CI run contains one green `dependency-review` job | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Pull-request gitleaks | Exact CI run contains one green `secret-scan` job | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Pull-request CodeQL | First-attempt CodeQL run id/URL and `analyze` job green for the exact reviewed head | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Engineering review | PR targets `main`, is not draft, aggregate decision is `APPROVED`, zero review threads remain unresolved, and its head equals the source candidate or a validator-approved evidence-only descendant | PENDING CURRENT RUN | PENDING CURRENT RUN |

## Safety, lifecycle, and failure coverage

| Evidence area | Required proof | Status | Evidence reference |
|---|---|---|---|
| Structured intent literals | Shared bounds across declaration, storage, schemas, authority, and catalog; maximum boundary tests | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Batch and host-call budget | Group add limit 14; every advertised batch derived from estimator; complete `maxHostCalls` hashed and reserved before first mutation | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Budget and cancellation errors | Pre-dispatch failures typed and never classified as ambiguous | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Installation generation | Token replacement increments generation; stale, inactive, and deleted installations reject new/queued writes | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Mutation settlement barrier | Token wiped at uninstall, queued work blocked, dispatched work settles truthfully, erasure follows drain, restart completes tombstone | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Cancellation propagation | Chat, REST, and governor interleavings prove queued definitive cancellation and post-dispatch settlement | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Journal timestamps | `queued_at` and immediate-before-fetch `dispatched_at` proven independently | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Role demotion | Every authenticated API surface fails closed; positive-only 60-second cache; mutation fresh-check; demotion invalidates sessions | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Provider outage | Visible error, no invented write authority, no silent protocol loss | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Clockify throttle | `429` cooldown honored, no write auto-retry after dispatch | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Malformed model/Clockify/API/NDJSON response | Typed visible failure, no dropped event or unsafe fallback | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Artifact isolation | Foreign/expired artifact id denied; authenticated owner download passes | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Crash recovery | Prepared work not resumed; unknown dispatched effect not retried; authoritative reconciliation only | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Maintainability | Discriminated action types, shadow mutation removed with parity, chat coordination extracted, script lint, one Zod-shape adapter | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Endpoint-to-scope contract | Generated contract passes; every scope has endpoint/probe; `REPORTS_WRITE` absent | PENDING CURRENT RUN | PENDING CURRENT RUN |

## Browser, accessibility, interface, and product flow

| Gate | Required result | Status | Evidence reference |
|---|---|---|---|
| Cross-browser suite | Chromium, Firefox, and WebKit pass | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Responsive suite | 280, 320, and 375 px plus desktop; no horizontal overflow; controls at least 44 x 44 px | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Theme and contrast | Light and dark; all small text meets the configured contrast checks | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Interface, data, and formatting | English interface; Unicode workspace data; timezone-aware Intl formatting | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Keyboard operation | First run, composer, history, preview, confirm/cancel, artifact action, and policy controls usable without pointer | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Permission-aware first run | DeepSeek disclosure and saved policy shown; restricted-policy welcome/prompts are truthful | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Action journeys | Read, safe write, risky preview/confirm/cancel, confirm-all partial, undo, history, and reload pass | PENDING CURRENT RUN | PENDING CURRENT RUN |
| PDF journey | Prominent authenticated Download PDF action shows filename and expiry; owner success and foreign-id denial pass | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Static asset budget | Combined production JavaScript/CSS no more than 20 KiB gzip | PENDING CURRENT RUN | PENDING CURRENT RUN |

## Performance and DeepSeek

| Metric | Acceptance | Result | Status | Evidence reference |
|---|---|---|---|---|
| Immediate local status | Below 100 ms | PENDING CURRENT RUN | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Warm iframe interactive | Below 1 s | PENDING CURRENT RUN | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Cold fast-4G iframe interactive | Below 2 s | PENDING CURRENT RUN | PENDING CURRENT RUN | PENDING CURRENT RUN |
| History API at supported limit | p95 below 250 ms; one operation-runs query and one steps query | PENDING CURRENT RUN | PENDING CURRENT RUN | PENDING CURRENT RUN |
| DeepSeek scripted read turn | p95 below 12 s | PENDING CURRENT RUN | PENDING CURRENT RUN | PENDING CURRENT RUN |
| DeepSeek write preview | p95 below 18 s | PENDING CURRENT RUN | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Confirmation receipt without Clockify throttle | p95 below 8 s | PENDING CURRENT RUN | PENDING CURRENT RUN | PENDING CURRENT RUN |
| DeepSeek context cache | Stable prompt prefix retained; cache-hit tokens recorded | PENDING CURRENT RUN | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Baseline comparison | Median and p95 regressions no greater than 10 percent | PENDING CURRENT RUN | PENDING CURRENT RUN | PENDING CURRENT RUN |

Record the selected DeepSeek model, reasoning setting, `LLM_PROVIDER=http`,
`LLM_MODE=tool`, `LLM_AGENTIC=1`, and `LLM_TOOL_SELECT=1` without recording an API key or
raw provider response.

## Backup, restore, deploy, and live private flow

| Gate | Required result | Status | Evidence reference |
|---|---|---|---|
| Pre-deploy online backup | Integrity pass; database, SHA-256, and metadata copied to encrypted off-volume storage | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Production-like restore | Checksum, integrity, and schema pass; token-backed read passes; real one-off production startup completes initialization/reconciliation, returns `GET /health` 200, and stops cleanly | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Measured RTO | Record duration from restore start to the one-off instance's first successful `/health` timestamp; static verification alone is not ready | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Measured RPO | Record backup age and supported point-in-time boundary | PENDING CURRENT RUN | PENDING CURRENT RUN |
| AUDIT-host probe | Production installation token tested without printing/committing token; verdict recorded | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Private Railway deployment | Exact tested source candidate deployed after backup; one instance; volume and health verified | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Owner/admin live flow | First run, read, safe write, risky confirm/cancel, undo, history, reload, and PDF pass | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Member denial | Member rejected before session creation | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Live cleanup | Synthetic resource sweep ends with zero leftovers | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Release/deployment identity | Browser flow and deployment resolve to the tested source candidate; any different PR/evidence head is an allowlisted evidence-only descendant | PENDING CURRENT RUN | PENDING CURRENT RUN |

## Listing assets and documents

| Material | Required result | Status | Evidence reference |
|---|---|---|---|
| Icon and banner | Delivery PNGs match reviewed SVGs; dimensions, hashes, and hash-bound visual review recorded | PENDING FINAL REGENERATION AND INSPECTION | [`asset-evidence.json`](../assets/asset-evidence.json); [`media-engineering-review.json`](../assets/media-engineering-review.json) is intentionally pending; post-commit binding artifact required |
| Five gallery screenshots | Deterministic synthetic fixture; all 13 permission groups; no secrets; hashes and paths match listing inventory | PENDING FINAL REGENERATION AND INSPECTION | Generated hashes, passed visual-review artifact, and immutable source-candidate binding artifact required |
| Demo video | Deterministic synthetic fixture; seven-step script complete, readable, hash/duration recorded | PENDING FINAL REGENERATION AND INSPECTION | Generated hashes, passed visual-review artifact, and immutable source-candidate binding artifact required |
| Listing copy | Claims match actual UI, safety semantics, scopes, and DeepSeek disclosure | PENDING CURRENT RUN | PENDING CURRENT RUN |
| Privacy, Terms, security, support, What's New, reviewer, and rollback documents | Final engineering text; public routes and links verified | PENDING CURRENT RUN | PENDING CURRENT RUN |

## Engineering conclusion

| Decision | Record |
|---|---|
| Known P1/P2 correctness, safety, accessibility, performance, or release defects | PENDING CURRENT RUN |
| Worktree contains only intentional release changes; `FINDINGS.md` untouched | PENDING CURRENT RUN |
| Tested source-candidate SHA and archive hash exposed by `/version` and deployed; any different reviewed head is validated evidence-only | PENDING CURRENT RUN |
| Engineering status | HISTORICAL V1 ONLY - the external v1 record may say `ENGINEERING COMPLETE` only when every engineering row above is `PASSED`; never valid for v2 |
| Marketplace submission | NOT PERFORMED - required stop point |

## Three-package admin handoff

These are the only allowed post-engineering packages. Their private details are not
stored here.

| Package | Administrative decision | Status | Sanitized decision reference |
|---|---|---|---|
| 1. DeepSeek and credentials | Key rotation; DPA; processing country/region; provider and cache retention; training posture; final disclosure | NOT YET RECORDED - ADMIN PACKAGE 1 | NOT YET RECORDED |
| 2. Ownership and sign-off | Monitored support/privacy/security routes; private vulnerability reporting; independent security/recovery approval | NOT YET RECORDED - ADMIN PACKAGE 2 | NOT YET RECORDED |
| 3. Marketplace administration | Review and upload listing/assets/URLs, confirm free pricing and Terms/What's New, then click Submit for Review | NOT STARTED - ADMIN PACKAGE 3 | Submit action intentionally unperformed |
