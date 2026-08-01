# Marketplace evidence index

This directory holds sanitized, human-readable indexes for release evidence. Raw CI
artifacts, browser traces, recordings, benchmark output, backup files, provider contracts,
credentials, contact details, and customer data stay in their approved systems.

Every artifact and conclusion indexed under "Historical v1 release" below is
historical v1 evidence. Existing bytes and hashes are preserved for
rollback/history, but none is valid for v2 or can support a v2 readiness
conclusion. The v2 record is a separate sibling and inherits none of them.

## Current v2 release

- [`release-candidate-v2.md`](./release-candidate-v2.md) - the v2 engineering evidence
  record. A row reads `PASSED` only where a result was measured; every unmet gate is
  explicitly `PENDING <gate>`, and no placeholder reads as a pass. This is the status
  source for v2; the historical v1 record below cannot be.

## Historical v1 release

- [`release-candidate.md`](./release-candidate.md) - historical v1 version 1.0.0 engineering evidence
  and the exact three-package admin handoff

## Recording rules

- Bind every executable/runtime result to the full tested and deployed source-candidate
  SHA and archive hash in the immutable GitHub Actions `release-evidence` artifact (or an
  equally immutable PR attachment). Browser, live, benchmark, and backup/restore evidence
  must resolve to that source candidate.
- Record the PR/evidence commit separately. It may differ only when the source candidate
  is its ancestor and the validator proves every intervening file is allowlisted
  non-executable evidence. Never describe that descendant as the deployed source.
- Record the reviewed PR number and URL, its exact head SHA, and the immutable CI and
  CodeQL run ids/URLs. The release validator accepts only a non-draft PR targeting
  `main`, aggregate review decision `APPROVED`, zero unresolved review threads, and
  first-attempt successful runs for the exact head. CI must include green `verify`,
  `browser-e2e`, `dependency-review`, and gitleaks `secret-scan`; CodeQL must include a
  green `analyze` job.
- Retain all three Vitest JSON reports. The consolidated record stores each report's
  SHA-256 and passed/total/failed/pending/todo counts, requires at least 5,351 passed
  tests on every pass, and rejects retries, skipped/pending tests, and todo tests.
- The checked-in Markdown is a schema and index, not the final exact-SHA attestation.
  Filling a committed file with its own commit SHA would change that SHA. Never claim
  that this template and the commit containing it have the same self-recorded hash.
- Record an exact URL, artifact name plus SHA-256, or immutable run id. A workflow file,
  command name, screenshot path, or verbal assertion is not a passing result.
- Mark a row passed only after checking the referenced evidence. Use `FAILED` or
  `BLOCKED - ENGINEERING` when a required run fails or cannot run; never move it into an
  admin package.
- Sanitize workspace and user identifiers. Do not record tokens, keys, prompts, response
  bodies, customer content, confirmation nonces, raw headers, contract text, or personal
  contact details.
- Provider contracts, key rotation records, monitored contacts, and private review
  material belong to the three administrative systems named in the release record. Store
  only a nonsecret decision reference here.

## Historical v1 completion rule

The historical v1 release is ready for the three admin-only packages only when every engineering row
in the immutable external release artifact is `PASSED`, its conclusion says
`ENGINEERING COMPLETE`, and `/version` plus the deployment resolve to the tested
source-candidate SHA/archive while any different reviewed PR head has a passed
evidence-only descendant validation. This rule is v1-only and cannot produce or
support a v2 conclusion.
The Marketplace **Submit for Review** action must remain unperformed.
