# Independent security and recovery reviewer package - version 1.0.0

This is the prepared procedure for admin package 2. It is not a sign-off and does not
replace the engineering pull-request review. The independent reviewer must evaluate the
exact tested/deployed source candidate and any evidence-only PR descendant after the
engineering evidence record is green.

## Materials under review

- [`../../SECURITY.md`](../../SECURITY.md) - trust, authorization, mutation, and recovery boundaries
- [`../../PRIVACY.md`](../../PRIVACY.md) - model inputs, stored data, retention, and deletion
- [`../../SUPPORT.md`](../../SUPPORT.md) - support intake and prohibited secrets
- [`../../DEPLOYMENT.md`](../../DEPLOYMENT.md) - deployment, backup, restore, and operational constraints
- [`../ENDPOINT_SCOPE_CONTRACT.md`](../ENDPOINT_SCOPE_CONTRACT.md) - generated scope-to-endpoint contract
- [`evidence/release-candidate.md`](./evidence/release-candidate.md) - exact-run engineering evidence
- [`03-operations-v2-runbook.md`](./03-operations-v2-runbook.md) - v2 release, deploy, backup-drill, and signed v1-return procedure for the engine production serves
- [`03-operations-evidence-rollback-package.md`](./03-operations-evidence-rollback-package.md) - retired v1 release history, and the only copy of the engine-neutral incident and recovery procedures

## Review procedure

1. Resolve the source-candidate SHA/archive, evidence-commit SHA, pull request, deployment
   id, and production URL. Confirm `/version` and deployment identify the source candidate.
   If the PR head differs, require ancestor and allowlisted evidence-only-diff proof.
2. Confirm non-admin rejection happens before session creation and that a negative role
   verdict invalidates that administrator's sessions.
3. Confirm every authenticated API surface fails closed on role-check failure, only a
   positive admin verdict is cached, and mutation dispatch performs a fresh role check.
4. Trace one read, one safe write, and one risky preview/confirm/cancel operation from
   admin text through intent capability, policy, schema, call-budget reservation,
   mutation plan, receipt, history, and audit links.
5. Verify that a queued mutation is cancelled definitively, while an already-dispatched
   Clockify mutation settles truthfully before cancellation takes effect.
6. Verify installation generation checks and uninstall behavior: token wipe and write
   barrier first, truthful settlement of already-dispatched work, then workspace erasure;
   restart must complete an interrupted deletion tombstone.
7. Inspect the maximum-boundary and interleaving tests for structured literals, batches,
   host-call budgets, cancellation, demotion, revocation, uninstall, and crash recovery.
8. Inspect the live private iframe evidence for first run, read, safe write, risky
   confirmation, undo, history, PDF, cleanup, owner/admin success, and member denial.
   Require: English interface; Unicode workspace data; timezone-aware Intl formatting.
9. Walk the restore drill and an ambiguous-outcome scenario. Confirm that recovery does
   not retry a dispatched unknown effect, resume prepared work, or promise rollback of a
   known Clockify effect.
10. Compare the listing and first-run DeepSeek disclosure with the admin package 1
    provider decision record. Stop if any wording overstates retention, training,
    caching, regional processing, rollback, idempotency, or success.

## Required conclusions

The reviewer records pass only when all statements below are supported:

- Administrator, workspace, session, policy, intent, and installation-generation
  boundaries fail closed.
- Secrets are absent from model input, logs, persisted agent state, artifacts, screenshots,
  demo media, and committed evidence.
- Supported batches reserve their complete host-call cost before the first mutation.
- Partial and unknown outcomes remain visible and block unsafe continuation.
- Exact replay, semantic duplicate suppression, undo, compensation, and service rollback
  are described as distinct mechanisms with their real limits.
- The tested restore procedure preserves evidence needed to reconcile Clockify effects
  that may be newer than a database backup.
- The endpoint-to-scope contract and production manifest agree; `REPORTS_WRITE` is absent.
- The release evidence is complete, reproducible, and bound to the deployed source
  candidate, with any later evidence commit validated as non-executable evidence only.

Any unresolved severity P1 or P2 finding, credential exposure, unexplained scope,
unreconciled live mutation, failed cleanup, or missing evidence is a fail. A conditional
approval is not a pass.

## Admin package 2 decision record

The following fields intentionally remain administrative and must not contain secrets in
the repository:

| Field | Required record |
|---|---|
| Independent reviewer | Not yet recorded - admin package 2 |
| Review date | Not yet recorded - admin package 2 |
| Tested/deployed source candidate | Must equal `/version`, the deployment, and the green evidence record |
| PR/evidence commit | Must equal the candidate or be its validator-approved evidence-only descendant |
| Deployed candidate | Must equal the private-production evidence record |
| Security decision | Not yet recorded - pass or fail with private evidence reference |
| Recovery decision | Not yet recorded - pass or fail with measured drill reference |
| Unresolved findings | Not yet recorded - must be none for approval |
| Monitored support route | Not yet recorded - admin package 2 |
| Monitored privacy route | Not yet recorded - admin package 2 |
| Private security route | Not yet recorded - admin package 2 |
| Private vulnerability reporting | Not yet recorded - enabled or blocked |

Store personal contact details and private review material in the operator's approved
system. Put only sanitized references in
[`evidence/release-candidate.md`](./evidence/release-candidate.md).
