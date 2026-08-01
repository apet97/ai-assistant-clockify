# Marketplace readiness - historical v1 version 1.0.0

## V2 status: NOT READY — closure plan code-complete, evidence gates open

The 2026-07-28 adversarial-review closure plan (findings F01–F24, PRs 1–12) is
code-complete on `main`, including the real-server Chromium/Firefox/WebKit
journey matrix (`npm run test:e2e:real`). On 2026-07-30 the candidate
`ad06c08` was deployed through the checked transaction onto the ADR-compliant
fresh database, with a candidate-bound backup/restore drill, branch protection,
and all remote checks green — recorded in
[`docs/V2_CUTOVER_RECORD.md`](./docs/V2_CUTOVER_RECORD.md).

The v2 candidate is still **not releasable**: the owner reinstall that creates
the fresh installation/attestation, fresh credentialed model evidence,
`live:v2-full`, the [7-day soak](./docs/V2_SOAK_SPEC.md), and independent human
security/recovery sign-off all remain open. No historical artifact below
establishes a v2 conclusion. The locally provable rows of the review's release
acceptance matrix, with per-row evidence, are recorded in
[`docs/V2_CLOSURE_ACCEPTANCE.md`](./docs/V2_CLOSURE_ACCEPTANCE.md).

## Historical v1 record

This document preserves the v1 private-production release-candidate criteria and
the stop immediately before the Marketplace **Submit for Review** action. Every
artifact and conclusion referenced here is historical v1 evidence and is invalid
for v2; no v2 release evidence or readiness conclusion exists. A checked box or
workflow definition is not evidence by itself. The historical v1 release is
pre-Marketplace complete only when every engineering row in
[`docs/marketplace/evidence/release-candidate.md`](./docs/marketplace/evidence/release-candidate.md)
is backed by evidence for the exact tested and deployed source candidate. A pull-request
head may be a descendant only when the checked-in validator proves every intervening
change is allowlisted non-executable evidence and the source archive is unchanged.

Marketplace submission is not authorized by this document. Do not click **Submit for
Review** during engineering execution.

## Release materials

- [Listing copy, asset inventory, and portal field map](./docs/marketplace/01-listing-package.md)
- [Independent reviewer instructions](./docs/marketplace/02-reviewer-package.md)
- [Deployment, incident, reconciliation, and rollback runbook](./docs/marketplace/03-operations-evidence-rollback-package.md)
- [Paste-ready 2.0.0 What's New entry](./docs/marketplace/04-whats-new-2.0.0.md) - the
  current v2 entry
- [Paste-ready 1.0.0 What's New entry](./docs/marketplace/04-whats-new-1.0.0.md) -
  retained v1 history; not for submission
- [Public Terms source](./TERMS.md)
- [Release-candidate evidence record](./docs/marketplace/evidence/release-candidate.md)
- [Endpoint-to-scope contract](./docs/ENDPOINT_SCOPE_CONTRACT.md)

The three Markdown packages above are release materials; they are not three extra
approval queues. The only work allowed to remain after the engineering evidence record
is green is the three admin-only packages below.

## Engineering exit criteria

The evidence record is the single status source. It covers:

- three consecutive cold Node 22 `npm run verify` passes without retries, each with a
  hashed Vitest JSON report proving at least 5,351 passed tests and zero failed,
  pending/skipped, or todo tests;
- `audit:prod`, `license:prod`, `eval:smoke`, configured DeepSeek evaluation,
  actionlint, dependency review, secret scan, CodeQL, SBOM, and license artifacts;
- Chromium, Firefox, and WebKit coverage for the release viewport, theme, keyboard,
  policy, action, confirmation, partial-result, history, and PDF flows;
- English interface; Unicode workspace data; timezone-aware Intl formatting;
- deterministic lifecycle, cancellation, demotion, provider-outage, throttle,
  malformed-response, artifact-isolation, and crash-recovery coverage;
- the DeepSeek safety and latency benchmark, including cache-hit tokens and comparison
  with the pre-change baseline;
- a measured backup/checksum/restore drill with RTO and RPO;
- the server-attested fresh-install aggregate scope probe and explicit production
  AUDIT-host POST when the production installation token is available;
- backup, deployment of the exact candidate, private Clockify iframe exercise, member
  denial, cleanup, performance measurements, and a green reviewed pull request whose
  exact number/head plus first-attempt CI and CodeQL run ids are API-validated. The PR
  requires approval, zero unresolved review threads, and green verify/browser,
  dependency-review, gitleaks, and CodeQL jobs.

No item in this section may be moved into an admin package. A missing run, result,
artifact, or link means engineering is still in progress.

## Exactly three admin-only packages

When all engineering exit criteria are green, only these packages may remain. Keep
their evidence outside source control when it contains account, contract, or personal
contact information; record only a sanitized decision reference in the release record.

### 1. DeepSeek and credentials

- Rotate the production DeepSeek API key and record a nonsecret fingerprint or key id.
- Approve and record the DeepSeek DPA/subprocessor terms, processing country or region,
  retention or zero-retention setting, context-cache retention, training posture, and
  final first-run disclosure wording.

### 2. Ownership and sign-off

- Supply the monitored support, privacy, and security contact or routing destination.
- Enable private vulnerability reporting.
- Record independent human security and recovery approval for the exact tested/deployed
  source candidate and any validated evidence-only PR descendant.

### 3. Marketplace administration

- Review the prepared listing copy, supplied assets, version, scopes, free-add-on pricing,
  What's New entry, Terms, and public URLs.
- Upload or confirm those materials in the Marketplace portal.
- Click **Submit for Review**. This final click is explicitly outside this engineering
  task.

Do not create a fourth package for AUDIT-host clearance, live smoke, backup/restore,
model evaluation, deployment, browser testing, cleanup, performance, or CI. Those are
engineering evidence and must be complete before this handoff.

## Product claims approved for public use

- Only Clockify workspace admins and owners can open or use the assistant.
- The model proposes typed actions; deterministic server-side controls authorize and
  execute them.
- Reads return directly. Only actions explicitly classified as safe writes may execute
  immediately; edits and risky writes require a preview and button-only confirmation.
- A confirmed multi-step operation can finish with a partial or unknown outcome. The UI
  preserves that state and stops unsafe follow-on dispatch instead of claiming success.
- Undo is available only for eligible recent creations. Compensation is best-effort and
  is not a global rollback guarantee.
- Exact request replay returns the durable result. Semantic duplicate suppression exists
  only for explicitly documented setup actions; there is no blanket exactly-once claim.
- Clockify and model credentials stay on the backend and are never sent to the model.

## Evidence boundaries

- Push/PR CI runs the production dependency policies and `verify`, and retains the
  CycloneDX SBOM plus production-license report. Dependency review, gitleaks, and
  CodeQL are separate required checks.
- The scheduled/manual live-smoke workflow uses the protected sacrificial environment,
  serializes the smoke and cleanup sequence, and uploads sanitized count/status
  artifacts. A workflow file does not prove a run.
- The manual release-evidence workflow validates the reviewed PR number, exact head,
  first-attempt CI and CodeQL runs, approval, resolved review threads, and required job
  conclusions through GitHub's API. Its immutable record also embeds the three cold-pass
  test counts and report hashes. It intentionally leaves the three administrative
  decisions unevaluated; it does not deploy, approve, or submit the add-on.
- The current evidence validators classify every derived conclusion as historical
  v1 and reject a v2 target before parsing. Existing report bytes and hashes were
  not regenerated; fresh v2 evidence must be produced by later authorized work.
- Tokens, prompts, headers, customer data, raw model responses, and contractual or
  personal contact material must not be pasted into this checklist or committed.
