# Marketplace readiness checklist

The code is production-ready (`npm run verify` green, 0 madge cycles, the safety
invariants pinned by tests — see `CLAUDE.md`, `SECURITY.md`, `PRIVACY.md`). What remains
before real marketplace users are **operational gates** that need a human sign-off and an
evidence trail. Fill in owner + date + evidence for each before tagging a prod release.

## Required gates (must be signed off)

| # | Gate | Status | Owner | Date | Evidence |
|---|------|--------|-------|------|----------|
| 1 | **Rotate prod LLM credentials.** The prod `LLM_API_KEY` (Railway env) must be a fresh key, never a dev/test key. Confirm `.env.server` / `.env.gemini` keys (used for evals) are NOT the prod keys. | ☐ pending | | | |
| 2 | **Security review before real users.** A reviewer walks `SECURITY.md` + the harness trust boundary, the token-isolation tripwires, and the auth/rate-limit posture; records findings + sign-off. | ☐ pending | | | |
| 3 | **AUDIT-host clearance.** Confirm the prod add-on token clears the Clockify AUDIT host: run `scripts/host-auth-spike.ts` with a captured prod `LIVE_ADDON_TOKEN` (dev cleanly reports "audit log not available"). Record the result here. | ☐ pending | | | |

## Decisions made (recorded for the reviewer)

- **authz-surface-01 (per-request role posture) — RESOLVED.** Posture B: the session TTL is
  configurable (`SESSION_TTL_HOURS`, default **2h**, down from 8h) and bounds how long a
  demoted admin keeps access. No per-request Clockify role re-check (keeps the hot path
  dependency-free). Rationale + the history-switcher coupling are in `SECURITY.md`.

## How to run gate 3 (AUDIT-host spike)

```bash
# With a captured PROD installation token (never a dev token; never commit it):
LIVE_ADDON_TOKEN=… npx tsx scripts/host-auth-spike.ts
```
A clean prod result confirms the AUDIT host accepts the add-on token; a "not available"
result means audit-log reads stay dev-gated. Either way, record the outcome in the table.

## Notes

- Env vars + the SQLite volume live in Railway; never commit tokens (see `DEPLOYMENT.md`).
- Re-run this checklist whenever the prod credentials or the Clockify host topology change.
