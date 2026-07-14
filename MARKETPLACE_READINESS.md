# Marketplace readiness checklist

Marketplace submission is **blocked** until every row below has an owner, date, and
evidence link. A green local test run is necessary but is not a production-readiness
claim. Do not tag, deploy, or submit from this checklist while any required row is open.

## Exact local automated gates

```bash
npm run verify
npm run audit:prod
npm run license:prod
npm run eval:smoke
```

`verify` covers both TypeScript projects, lint, circular dependencies, duplication,
the fake-only test suite, and builds. `audit:prod` and `license:prod` enforce the
checked-in production dependency policies; the license gate rewrites deterministic
`evidence/dependency-gates/production-licenses.json`. `eval:smoke` is the offline
scripted-model safety corpus, not the configured-provider evaluation required by row 6.

## Required gates (must be signed off)

| # | Gate | Status | Owner | Date | Evidence |
|---|------|--------|-------|------|----------|
| 1 | **Rotate prod LLM credentials** (plan T60). The prod `LLM_API_KEY` (Railway env) must be a fresh key, never a dev/test key. Confirm `.env.server` / `.env.gemini` keys (used for evals) are NOT the prod keys. | ☐ OPEN — requires human + credentials | | | |
| 2 | **Security review before real users** (plan T62). A reviewer walks `SECURITY.md` + the harness trust boundary, the token-isolation tripwires, and the auth/rate-limit posture; records findings + sign-off. | ☐ OPEN — requires human reviewer | | | |
| 3 | **AUDIT-host clearance** (plan T61). Confirm the prod add-on token clears the Clockify AUDIT host: run `scripts/host-auth-spike.ts` with a captured prod `LIVE_ADDON_TOKEN` (dev cleanly reports "audit log not available"). Record the result here. | ☐ pending | | | |
| 4 | **Model-provider privacy posture.** Record provider/subprocessor, DPA, processing region, retention/zero-retention setting, and evidence that customer content is not used for training. | ☐ OPEN — operator/provider evidence required | | | |
| 5 | **Production backup + restore drill.** Run `db:backup`/`db:restore` against an encrypted production-like volume, verify checksum/integrity and a token-backed read, and record RTO/RPO. | ☐ OPEN — local drill only | | | |
| 6 | **Deterministic planner/agentic safety evaluation.** Run the pinned safety corpus for the release model/config and attach the zero-regression report. | ☐ OPEN — requires configured provider | | | |
| 7 | **Sacrificial-workspace smoke.** Run the full preview/confirm/commit/cleanup workflow and attach both sanitized smoke and cleanup artifacts. | ☐ OPEN — workflow added; protected environment, credentials, and successful remote run evidence required | | | |
| 8 | **Repository security gates.** Required CI, blocking high/critical runtime audit, production license policy, CodeQL, dependency review, secret scan, and SBOM/license artifacts are green on the release commit. | ☐ OPEN — workflows added; release-commit remote conclusions and links required | | | |
| 9 | **Ambiguous-write recovery review.** Fault-injection/restart evidence demonstrates canonical result ownership, exact-plan/target enforcement, no retry of unknown effects, and authoritative reconciliation or continued blocking for every supported write class. | ☐ OPEN — internal controls complete; independent review evidence required | | | |

## Decisions made (recorded for the reviewer)

- **authz-surface-01 (write posture) — RESOLVED for mutations.** Every write,
  confirmation, and undo performs a fresh role check, fails closed when Clockify cannot
  establish the role, and invalidates that admin's sessions after a negative result.
  `ROLE_RECHECK=1` additionally enables cached rechecks for authenticated read traffic.
- **Policy migration posture — RESOLVED.** A genuinely new admin starts with the
  documented full-access policy. Missing groups in an already stored policy migrate to
  `off`; the admin must explicitly enable a newly introduced capability.
- **External request governor — RESOLVED.** Per-workspace host calls use FIFO rate and
  concurrency limits, adaptive `429` cooldown, single-flight writes, and a per-turn cap.

## How to run gate 3 (AUDIT-host spike)

```bash
# With a captured PROD installation token (never a dev token; never commit it):
LIVE_ADDON_TOKEN=… npx tsx scripts/host-auth-spike.ts
```
A clean prod result confirms the AUDIT host accepts the add-on token; a "not available"
result means audit-log reads stay dev-gated. Either way, record the outcome in the table.

## Status of the human-gated operational items (plan T60/T61/T62)

All three remain **OPEN** at the end of the automated hardening pass — they require a human
with production credentials, a captured prod `X-Addon-Token`, and/or a sacrificial workspace,
none of which the autonomous run had. The *code/docs* they depend on are in place:

- **T60 (rotate prod LLM key)** — OPEN. Operational only; no code change needed. Complete the
  end-state checklist in the plan and record owner/date/fingerprint in row 1 above.
- **T61 (clear AUDIT host)** — OPEN. Run `scripts/host-auth-spike.ts` with a captured prod
  `LIVE_ADDON_TOKEN` (see "How to run gate 3" below) and record the VERDICT in row 3.
- **T62 (pre-launch security review)** — OPEN. The code dependency (authz-surface-01 posture)
  is resolved for writes and signed-off-ready; a human reviewer completes the checklist
  and records findings + sign-off in row 2.

## Automated evidence from the hardening workspace

The completed internal controls include one canonical `action_results` owner for full
outcomes; persisted immutable intent capabilities and operation bindings; normalized
nonsecret operation data; exact mutation plans; authoritative target/parent snapshots;
ordered primary/compensation step journals; and read-only startup reconciliation that
never resumes prepared work, retries an ambiguous host effect, or auto-compensates.
Invoice replay is anchored to its durable operation id, exact step journal, and
reconciliation evidence — not semantic/payload-level idempotency.

As of 2026-07-14, the last pre-Phase-8 Node 22 full `npm run verify` was green at
commit `18cdd0e`. The hardening reports record focused dependency/workflow tests,
TypeScript checks, local `audit:prod`/`license:prod`, actionlint, fail-closed evidence
probes, and a local SQLite backup/checksum/restore/data-read drill. They do not record
a post-integration full verify, a real live-smoke run, or any remote release-evidence
run. Rows 1–9 therefore remain open release authority.

## Workflow evidence boundaries

- Push/PR CI runs `audit:prod`, `license:prod`, and `verify`, and retains the
  CycloneDX SBOM beside the deterministic production-license report. Dependency
  review, gitleaks, and CodeQL remain separate automated checks.
- `live-smoke.yml` is weekly, manual, and reusable. It serializes all runs against
  `clockify-live-smoke-sacrificial`, uses only that environment's API-key/workspace
  secrets, always executes a separately bounded cleanup job, and uploads
  prefix/count/status JSON that excludes secrets and resource identities.
- Manual `release-evidence.yml` records the exact commit SHA and machine conclusions
  for verify, audit, license, CodeQL, secret scan, `eval:smoke`, SBOM, and live smoke.
  Credential rotation, provider governance, backup/restore, configured-model
  evaluation, security review, AUDIT-host clearance, and Marketplace approval are
  always `not_evaluated`; no caller can turn them into machine passes.

These workflow definitions do not prove a remote run, deployment, production drill,
review, submission, or approval. Put the real run URL/artifact, owner, and date in the
table; do not infer them from checked-in YAML or local output.

## Notes

- Env vars + the SQLite volume live in Railway; never commit tokens (see `DEPLOYMENT.md`).
- Re-run this checklist whenever the prod credentials or the Clockify host topology change.
- High/critical audit exceptions, if ever unavoidable, require an advisory-specific
  allowlist entry with owner, justification, and an expiry date; no blanket
  `continue-on-error` is permitted.
