# ADR 003: Installation authority does not cross a database boundary

- Status: Accepted
- Date: 2026-07-27
- Scope: The private v2 cutover and its full-v1 rollback branch

## Context

The v2 cutover deploys the v2 candidate against a **new, empty** database file on
the Railway volume (`/data/ai-assistant-v2.sqlite`) while the v1 database
(`/data/ai-assistant.sqlite`) is retained untouched for rollback. That is
deliberate: it means a rollback restores real v1 data rather than a v1 build
pointed at a schema the v1 code never wrote.

It also means the two deployments do not share installation authority, because
**all installation authority state lives in the application database**, not in
Railway, not in the Clockify platform, and not in any external service. In
`src/db/store/installations.ts` that state is:

1. The **retired-token denylist** — `retired_installation_tokens`, keyed by a
   separate-domain token fingerprint, which is what makes a delayed signed
   callback carrying an already-replaced token fail as `retired_token_replay`.
2. The **lifecycle `iat` watermark** — `lifecycle_authority_watermarks`, which is
   what makes an older INSTALLED / STATUS_CHANGED / DELETED event lose to a newer
   one (`stale_lifecycle`) even when it is delivered later, and what carries the
   generation across a restart.
3. The **installation generation** — the `installations.generation` column, and
   the `installation_attestations.installation_generation` that must equal it for
   an attestation to be considered current.

## Decision

Accept that installation authority is per-database, and record the two
consequences below as **known limitations of the cutover**, not as solved
problems.

### Consequence 1 — a fresh v2 database starts with no authority history

The v2 database begins with `retired_installation_tokens` and
`lifecycle_authority_watermarks` both empty. It therefore **cannot detect replay
of a token that was retired in the v1 database**: that fingerprint was never
written on the v2 side, so the denylist lookup finds nothing. Nothing about the
v2 deployment restores or imports that history, and this ADR does not propose
that it should — copying a denylist between databases would move the credential
lineage of one deployment into another.

### Consequence 2 — every v2-era token retirement is discarded by a rollback

If a full-v1 rollback restores the v1 database, every fingerprint retired and
every watermark advanced **while v2 was serving is discarded**, because those rows
only ever existed in the v2 file. The restored v1 database's authority history is
exactly as of the moment it was backed up. A token retired during the v2 window is,
after the rollback, a token the restored database has never heard of.

### Accepted mitigation, and precisely what it does not cover

The cutover **reinstalls the add-on for a fresh generation and never reuses or
reactivates an old token** (T18-G, and again after a rollback in T18-JR). A
replayed retired token therefore fails on the **generation** path rather than on
the denylist: `saveInstallation` requires a different-token replacement to be
**strictly newer** than the recorded lifecycle authority, and it advances
`generation` monotonically past the highest value it can see, so a stale callback
loses the `lifecycleIssuedAt <= authority.lifecycleIssuedAt` comparison and any
token from a superseded generation is no longer the installation's token.

This is a mitigation, not a fix, and it has a real gap:

- The generation check only holds **once the reinstall has recorded the new
  generation in the database that is serving**. Between restoring a database and
  completing the reinstall there is a window in which the serving database's
  highest known generation is the **pre-outage** one, and a replayed callback is
  compared against that older watermark rather than against v2-era history that
  no longer exists.
- A rollback additionally leaves a **stale installation row** in the restored
  database. `saveInstallation` deletes the prior attestation unconditionally and
  writes a new one only when the installation row was genuinely absent
  beforehand, so a reinstall over a restored row produces an **active
  installation with no attestation**. The rollback therefore must clear that row
  first; `clearStaleInstallationSql` in `scripts/cutover-transaction.ts` is the
  exact statement pair, and `planSignedFullV1Rollback` returns
  `clearsStaleInstallation: true` so the branch cannot be planned without it.
  This closes the attestation gap. It does not close the window above.

Closing the window would require authority state that outlives a single database
file. That is out of scope for the cutover and is not claimed to exist.

## Consequences

- The rollback runbook must clear the stale installation row **before** the
  reinstall, and must never reactivate an old token to shorten the window.
- Any future decision to reuse a database path, share a volume, or import
  authority rows between the v1 and v2 files reopens Consequence 1 and must
  revisit this ADR.
- Release and cutover evidence may not claim cross-database replay protection.
  The honest claim is: within one database, retirement and watermark checks hold;
  across a database boundary, only the generation check does, and only after the
  reinstall completes.
