# V2 release-candidate evidence record - version 2.0.0

Status: **IN PROGRESS - NO ROW IMPLIES A PASS UNLESS ITS STATUS CELL SAYS `PASSED`**

This is the v2 sibling of [`release-candidate.md`](./release-candidate.md) and uses the same
row/table shape so the two are recognisable side by side. It is **not** a copy of it and
inherits none of its rows: that document is a historical v1 template, marked
`NOT VALID FOR V2`, whose artifacts and hashes are immutable rollback history. Nothing there
can support a v2 conclusion, and nothing here restates a v1 result.

Two kinds of row appear below and they must never be confused:

- **`PASSED`** - a real result that was measured. The measurement and how to reproduce it are
  in the row, and the row also says what it does *not* prove.
- **`PENDING <gate>`** - the gate has not run, or has run and did not conclude. A pending row
  is never a soft pass, an "expected pass", or a pass awaiting paperwork. Every unmet gate
  below is explicitly pending and names the gate by what it does.

Gates are stated **by content**. The out-of-repo executor plan labels some of them; those
labels exist only in that plan, are not checkable from this repository, and are therefore not
used as identifiers here.

Do not paste secrets, prompts, customer data, raw responses, contact details, or contract
text. The Marketplace **Submit for Review** action must remain unperformed.

## Candidate identity

| Item | Record |
|---|---|
| Engine | `v2` - `ASSISTANT_ENGINE` defaults to `v2` in `src/config.ts`; `v1` remains the tested rollback |
| Package version | `2.0.0` in `package.json`, reported by `/version` |
| Database schema | `LATEST_SCHEMA_VERSION` is `13` in `src/db/schema.ts` |
| Tested source-candidate SHA | PENDING CANDIDATE FREEZE - the local results below were measured on the Phase D working tree of `main`, not on a frozen candidate, and must be re-measured on it |
| Source-candidate archive hash | PENDING CANDIDATE FREEZE |
| Reviewed pull request number/URL, exact head/evidence-commit SHA, CI run id/URL, and CodeQL run id/URL | PENDING PULL-REQUEST RUN |
| Candidate-to-evidence diff validation | PENDING PULL-REQUEST RUN - same SHA or allowlisted evidence-only descendant |
| Railway deployment id, `/version` SHA, and build hash | PENDING DEPLOYED-IDENTITY PROOF |
| Production base URL | PENDING DEPLOYED-IDENTITY PROOF |
| Currently deployed release | Production still serves the earlier cutover candidate. That flips at deploy time, never by editing this record |
| Evidence finalized at UTC | PENDING CANDIDATE-BOUND RELEASE RUN |

## Deterministic local gates

Measured with Node 22 at Phase D task D13. These are current local results on the working
tree, **not** a candidate-bound attestation: the release run re-measures each one on the
frozen candidate and binds the retained Vitest JSON report's SHA-256 and its exact
passed/total/failed/pending/todo counts.

| Gate | Required result | Status | Evidence reference |
|---|---|---|---|
| `npm run verify` | Exit 0 across both TypeScript projects, the full test/build suite, the zero-warning typed ESLint gate, madge, and jscpd | PASSED | Exit 0; 386 test files, 5,614 tests, 0 skipped. One local pass, on the working tree |
| Deterministic suite floor | At least 5,351 passed tests, passed equals total, and failed/pending/todo all zero | PASSED | 5,614 is at or above the floor of 5,351, which is `floor(RECORDED_SUITE_BASELINE 5,461 x (100 - ALLOWED_SUITE_SHRINK_PERCENT 2) / 100)` in `scripts/evidence/cold-verify-evidence.ts` |
| Three consecutive cold `npm run verify` passes | Three new processes, no retry after failure, one retained JSON report each | PENDING COLD-VERIFY RELEASE RUN | PENDING COLD-VERIFY RELEASE RUN - one local pass is not three cold passes |
| `npm run test:e2e:real` | Local real Express and SQLite path across three browsers | PASSED | Exit 0; 45 passed, 15 journeys across 3 browsers |
| `npm run audit:prod` | No unallowlisted high or critical production advisory | PENDING CANDIDATE-BOUND RELEASE RUN | PENDING CANDIDATE-BOUND RELEASE RUN |
| `npm run license:prod` | Pass plus deterministic production-license JSON | PENDING CANDIDATE-BOUND RELEASE RUN | PENDING CANDIDATE-BOUND RELEASE RUN |
| `npm run eval:smoke` | Offline scripted safety corpus passes without credentials | PENDING CANDIDATE-BOUND RELEASE RUN | PENDING CANDIDATE-BOUND RELEASE RUN |
| CycloneDX SBOM | Generated for the exact commit; artifact hash recorded | PENDING CANDIDATE-BOUND RELEASE RUN | PENDING CANDIDATE-BOUND RELEASE RUN |
| Pull-request CI, dependency review, gitleaks, and CodeQL | First-attempt successful runs for the exact reviewed head | PENDING PULL-REQUEST RUN | PENDING PULL-REQUEST RUN |
| Engineering review | Non-draft PR targeting `main`, aggregate decision `APPROVED`, zero unresolved threads, head equal to the candidate or a validated evidence-only descendant | PENDING PULL-REQUEST RUN | PENDING PULL-REQUEST RUN |

## Runtime and interface facts pinned by the suite

Properties of the candidate rather than gate runs. Each is asserted by the suite above, so a
change to any of them fails `npm run verify` rather than silently aging here.

| Fact | Value | Status | Evidence reference |
|---|---|---|---|
| Default assistant engine | `v2`; `ASSISTANT_ENGINE=v1` is the tested rollback | PASSED | `src/config.ts` |
| Database schema version | `13` | PASSED | `LATEST_SCHEMA_VERSION` in `src/db/schema.ts` |
| Product version | `2.0.0` | PASSED | `package.json`, the `/version` literal, and the listing package, pinned together by `tests/unit/marketplace-package.test.ts` |
| Presented result statuses | 7 | PASSED | `PRESENTED_RESULT_STATUSES` in `src/assistant-v2/presentation/presented-result.ts`, asserted at length 7 by `tests/unit/presented-result-snapshots.test.ts`; `src/ui/protocol.ts` carries a hand-maintained twin set with the same seven members |

## Model evaluation

The v2 evaluation lane is **structurally blocked**, not merely unrun, and this record does
not present it as nearly done.

| Gate | Required result | Status |
|---|---|---|
| API discovery corpus | `npm run eval:api-discovery` - 120 operations x 3 cohorts x 3 repeats = 1,080 real agent turns; canonical 3/3 per case, paraphrase at least 2/3, typo at least 2/3 | PENDING CREDENTIALED MODEL EVALUATION - credentialed and paid; not run for this candidate |
| Assistant terminal corpus | `npm run eval:assistant-terminal` - 897 attempts | PENDING CREDENTIALED MODEL EVALUATION - credentialed and paid; not run for this candidate |
| Write-safety observation | Zero unrelated destructive selections and no more than 12 loaded API tools, judged from real model calls | PENDING WRITE-SAFETY OBSERVER REPAIR - `npm run eval:write-safety` emits `not_evaluated_missing_credentials` and exits 2; the real observer exists only in the integration test |
| Aggregate v2 evidence handoff | One all-gates, exact-SHA conclusion consuming all three v2 evaluation artifacts | PENDING POST-M EVIDENCE HANDOFF REPAIR - `release-evidence.yml` does not join the three v2 evaluations into one conclusion |
| Historical 239 of 1,143 discovery run | Not usable for model selection | NOT APPLICABLE - diagnostic evidence only and void for selection; it predates the current scorer and corpus contract |

## Live v2 write and cleanup

| Gate | Required result | Status |
|---|---|---|
| Guarded v2 chain, offline | `npm run live:v2-full -- --dry-run` completes the preview, stored nonce, confirm, and cleanup contract against the fake host with zero external writes | PENDING LIVE V2 WRITE AND CLEANUP - not recorded for this candidate |
| Guarded v2 chain, live | `npm run live:v2-full` performs a real Clockify write through the v2 preview and confirm chain on a sacrificial workspace with per-step authorization | PENDING LIVE V2 WRITE AND CLEANUP - credentialed; the sole v2 live-write evidence path |
| Live cleanup | `npm run live:sweep` finishes at zero leftovers | PENDING LIVE V2 WRITE AND CLEANUP |
| `scripts/live-full.ts` write columns | Not usable as v2 write evidence | NOT APPLICABLE - read, preview, and sweep diagnostic only; its bare `ActionContext` correctly fails `mutation_scope_required` |

## Backup, restore, deploy, and deployed identity

Every step below is the v2 runbook's, against `/data/ai-assistant-v2.sqlite`. See
[`../03-operations-v2-runbook.md`](../03-operations-v2-runbook.md).

| Gate | Required result | Status |
|---|---|---|
| Pre-deploy online backup | Integrity pass; database, SHA-256, and metadata copied to encrypted off-volume storage, with the backup's own recorded source equal to the v2 database | PENDING CANDIDATE-BOUND BACKUP AND RESTORE DRILL |
| Isolated restore drill | Checksum, integrity, and schema pass; token-backed read passes; a real one-off production startup completes initialization and reconciliation, answers `GET /health` 200, and stops cleanly | PENDING CANDIDATE-BOUND BACKUP AND RESTORE DRILL |
| Measured RTO and RPO | Restore start to first successful `/health`; incident instant minus the format-2 sidecar's pre-snapshot boundary | PENDING CANDIDATE-BOUND BACKUP AND RESTORE DRILL |
| Checked private deployment | `npm run deploy:private-production` with `SELECTED_ASSISTANT_ENGINE=v2` and an explicitly exported v2 `RELEASE_SHA`, never a bare `railway up` | PENDING DEPLOYED-IDENTITY PROOF |
| Deployed identity | `verifyDeployedV2Engine` satisfied on the exact candidate - `releaseSha` equal to the candidate, `modelConfiguration.assistantEngine` equal to `"v2"`, well-formed `buildHash` and `serverArtifactSha256` - plus `/live`, `/health`, and `/manifest` each answering 200 | PENDING DEPLOYED-IDENTITY PROOF - `scripts/evidence/v2-deployed-engine.ts` |
| Owner and admin live browser flow | First run, read, safe write, risky preview, confirm, cancel, undo, history, reload, and PDF against the deployed exact candidate | PENDING DEPLOYED-IDENTITY PROOF |
| Member denial | A real active member rejected before session creation, with no session cookie | PENDING DEPLOYED-IDENTITY PROOF |
| Production observation window | The full window defined by [`docs/V2_SOAK_SPEC.md`](../../V2_SOAK_SPEC.md), served on one candidate, with its entry gate satisfied and its declaration artifact filled | PENDING PRODUCTION OBSERVATION WINDOW - not started |

## Listing assets and documents

| Material | Required result | Status | Evidence reference |
|---|---|---|---|
| Marketplace media binding | `asset-evidence.json` and the hash-bound engineering visual review both bind this exact capture source and asset set, and the review reports `passed` | PENDING ENGINEERING VISUAL REVIEW | `media-engineering-review.json` reports pending with a null reviewer and all five checks pending, so `buildMarketplaceMediaReleaseBinding` refuses; a human must inspect every generated asset at original size and record the promotion |
| Listing copy and What's New | Claims match the actual UI, safety semantics, scopes, and provider disclosure for this version | PENDING CANDIDATE-BOUND RELEASE RUN | The listing package and the 2.0.0 What's New entry are written; their claims are not yet re-checked against a deployed candidate |
| Public documents | Privacy, Terms, Security, Support, reviewer, and operations pages final; public routes and links verified against the deployment | PENDING DEPLOYED-IDENTITY PROOF | PENDING DEPLOYED-IDENTITY PROOF |

## Independent sign-off and administrative packages

| Package | Required result | Status | Sanitized decision reference |
|---|---|---|---|
| Independent security and recovery sign-off | A named reviewer independently approves the security and recovery boundaries and the restore proof for this candidate | PENDING INDEPENDENT SECURITY AND RECOVERY SIGN-OFF - not requested for this candidate | NOT YET RECORDED |
| Provider credentials and governance | Key rotation, processing region, retention, training posture, and final disclosure recorded | NOT YET RECORDED - ADMIN PACKAGE | NOT YET RECORDED |
| Marketplace administration | Review and upload the listing, assets, and URLs, then click Submit for Review | NOT STARTED - ADMIN PACKAGE | Submit action intentionally unperformed |

## Known non-passes

Two things are known not to pass right now. They are stated here so this record is not read
as clean:

1. **The Marketplace media binding cannot pass.** The media was regenerated for the v2
   candidate, which reset `docs/marketplace/assets/media-engineering-review.json` to pending
   with a null reviewer and all five checks pending.
   `buildMarketplaceMediaReleaseBinding` requires `passed` on the top-level status, a
   nonempty reviewer, a parseable `reviewedAt`, and all five checks `passed` for that exact
   capture source and asset set. Until a human performs and records that inspection the
   binding refuses, and re-running the generator cannot change it - regeneration writes the
   pending document. The agreement between that artifact and the documents that state its
   status is pinned by `tests/unit/marketplace-package.test.ts`.
2. **The production observation window's entry gate was unmet for a reason that is now
   closed.** [`docs/V2_SOAK_SPEC.md`](../../V2_SOAK_SPEC.md) makes a written, executable v1
   rollback procedure a blocking entry-gate item, and recorded that no such document existed.
   [`../03-operations-v2-runbook.md`](../03-operations-v2-runbook.md) now supplies it in
   "Application rollback: the signed full v1 return", walking `planSignedFullV1Rollback` and
   ADR 003's stale-installation-row clearance. That closes the *reason* the item was unmet.
   It does not tick the item, which still requires confirming the plan inputs can actually be
   supplied, and it neither starts nor shortens the window.

## Engineering conclusion

| Decision | Record |
|---|---|
| Engineering status | **NOT COMPLETE.** This record may say `ENGINEERING COMPLETE` only when every gate row above reads `PASSED`. It does not |
| Known P1/P2 correctness, safety, accessibility, performance, or release defects | PENDING CANDIDATE-BOUND RELEASE RUN |
| Deployed release equals the tested source candidate | PENDING DEPLOYED-IDENTITY PROOF |
| Marketplace submission | NOT PERFORMED - required stop point |
