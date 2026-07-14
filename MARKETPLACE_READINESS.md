# Marketplace readiness checklist

Marketplace submission is **blocked** until every row below has an owner, date, and
evidence link. A green local test run is necessary but is not a production-readiness
claim. Do not tag, deploy, or submit from this checklist while any required row is open.

## Required gates (must be signed off)

| # | Gate | Status | Owner | Date | Evidence |
|---|------|--------|-------|------|----------|
| 1 | **Rotate prod LLM credentials** (plan T60). The prod `LLM_API_KEY` (Railway env) must be a fresh key, never a dev/test key. Confirm `.env.server` / `.env.gemini` keys (used for evals) are NOT the prod keys. | ☐ OPEN — requires human + credentials | | | |
| 2 | **Security review before real users** (plan T62). A reviewer walks `SECURITY.md` + the harness trust boundary, the token-isolation tripwires, and the auth/rate-limit posture; records findings + sign-off. | ☐ OPEN — requires human reviewer | | | |
| 3 | **AUDIT-host clearance** (plan T61). Confirm the prod add-on token clears the Clockify AUDIT host: run `scripts/host-auth-spike.ts` with a captured prod `LIVE_ADDON_TOKEN` (dev cleanly reports "audit log not available"). Record the result here. | ☐ pending | | | |
| 4 | **Model-provider privacy posture.** Record provider/subprocessor, DPA, processing region, retention/zero-retention setting, and evidence that customer content is not used for training. | ☐ OPEN — operator/provider evidence required | | | |
| 5 | **Production backup + restore drill.** Run `db:backup`/`db:restore` against an encrypted production-like volume, verify checksum/integrity and a token-backed read, and record RTO/RPO. | ☐ OPEN — local drill only | | | |
| 6 | **Deterministic planner/agentic safety evaluation.** Run the pinned safety corpus for the release model/config and attach the zero-regression report. | ☐ OPEN — requires configured provider | | | |
| 7 | **Sacrificial-workspace smoke.** Run the full preview/confirm/commit/cleanup workflow and attach the cleanup proof. | ☐ OPEN — requires sacrificial credentials | | | |
| 8 | **Repository security gates.** Required CI, blocking high/critical runtime audit, CodeQL, dependency/license review, secret scan, and SBOM artifact are green on the release commit. | ☐ OPEN — workflows added; remote run required | | | |
| 9 | **Ambiguous-write recovery review.** Fault-injection/restart evidence demonstrates that unknown outcomes do not retry and that every supported write class reconciles or stays blocked. | ☐ OPEN — review evidence required | | | |

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

As of 2026-07-14 on Node 22, `npm run verify` completed with zero ESLint warnings,
zero circular dependencies, the full fake-only test suite passing, and production
server/UI builds succeeding. A local SQLite backup/checksum/restore/data-read drill
also passed. This is local evidence only; rows 1–9 remain the release authority.

## Notes

- Env vars + the SQLite volume live in Railway; never commit tokens (see `DEPLOYMENT.md`).
- Re-run this checklist whenever the prod credentials or the Clockify host topology change.
- High/critical audit exceptions, if ever unavoidable, require an advisory-specific
  allowlist entry with owner, justification, and an expiry date; no blanket
  `continue-on-error` is permitted.
