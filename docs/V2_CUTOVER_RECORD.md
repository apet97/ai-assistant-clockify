# V2 closure candidate — production cutover record (2026-07-30)

Executed record of the release gates run after the closure plan reached
code-complete. Companion to
[`docs/V2_CLOSURE_ACCEPTANCE.md`](./V2_CLOSURE_ACCEPTANCE.md) (the local
acceptance matrix). Every hash/timestamp below is copied from the machine
output of the run it names.

## Candidate

| Field | Value |
|---|---|
| Release SHA | `ad06c083d3e1fc6194dd2fa7b1c6710cc190736e` |
| Archive build hash | `972ab84cef23bae19bc2da1d605990049620da9b6ad0cf5cde72b20e44bbac36` |
| Server artifact SHA-256 | `b3b05b296d9a6b79969f6e82951d015d319067301c0011a1bd4a1c965ee086d0` |
| Local gate | `npm run verify` exit 0, 5,336 tests |
| Dependency gates | `npm run audit:prod` exit 0 · `npm run license:prod` exit 0 |
| Remote checks on this SHA | `verify` success · `browser-e2e` success · `analyze` (CodeQL) success · `secret-scan` success |
| Branch protection | `main` requires the `verify` status check; force-push and deletion blocked |

## Backup + restore drill (candidate-bound, one window)

Drill id `20260730T021048Z`, encrypted APFS/FileVault volume
`/Volumes/AIASSIST_RECOVERY` (verified `FileVault: Yes` before any file was
created).

| Step | Result |
|---|---|
| Pre-backup RPO boundary | captured `2026-07-30T02:10:49.098Z` |
| Online backup (container, SQLite backup API) | `sha256=944afcbc9af44103c3d842b3e813698832575811a76e8e419daea9a8e5983d37` |
| TLS transfer + checksum verify | `shasum -c` OK; metadata format 2 |
| Isolated restore | clone restored, same sha256 |
| `db:verify-restore` | `conclusion: passed` · token-backed read passed · `GET /health` 200 from the built `dist/server/server.js` · integrity ok source **and** migrated · schema 12 → 13 in the private clone · writer lock available |
| Measured | RTO 10.3 s · RPO 69.3 s |
| `gate:predeploy-backup` | passed, bound to `ad06c08` |

Container access for the backup used a purpose-generated ed25519 key registered
for this drill only, with the host key pinned to a scan-verified
`UserKnownHostsFile` and `StrictHostKeyChecking=yes`. The key was **revoked from
Railway and deleted locally**, and the generated OpenSSH config block removed,
immediately after the drill (`railway ssh keys list` → none registered).

## F24 resolution: ADR-001 fresh cutover (option 1, preferred)

The deploy ran the checked `npm run deploy:private-production` transaction from
a `git archive` staging tree with `SELECTED_ASSISTANT_ENGINE=v2`,
`SELECTED_DATABASE_PATH=/data/ai-assistant-v2.sqlite`,
`SELECTED_DATABASE_PATH_DISPOSITION=new_unused`, and
`PREDEPLOY_SOURCE_DATABASE_PATH=/data/ai-assistant.sqlite`. No ADR supersession
was claimed and none was needed.

Post-deploy verification against the production origin:

- `/version` exact-matches the candidate on every field — releaseSha, buildHash,
  sourceRelationship `source_bound_builder`, sourceBindingSha256, server
  artifact hash, all eight frozen model-configuration values, and
  `assistantEngine: "v2"`.
- `/live` 200 · `/health` 200 · `/manifest` 200.
- Unauthenticated `/api/me` and `/component/assistant` → 401 (no session, no leak).
- The fresh database reports **schema 13, 0 installations, 0 chat sessions, 32
  tables**, and carries the runtime freshness proof
  `/data/ai-assistant-v2.sqlite.fresh-cutover.json`
  (`bornDisposition: "new_unused"`, releaseSha `ad06c08…`, createdAt
  `2026-07-30T02:21:06.525Z`).
- The retained v1 database `/data/ai-assistant.sqlite` is **untouched**
  (`sha256=42d095bb9a0a04b3abf30e5f1a897a5162c0524a8276a2a48aac39c04f599c9a`)
  and remains paired with its rollback artifact.
- Production startup logs contain no raw 24-hex identifier and no token.

### Operation 11B is resolved by the cutover, not by the retirement command

The stale v1 installation (`640f2540…`, `active` with a token Clockify rejects)
existed only in `/data/ai-assistant.sqlite`. The serving database now has zero
installations, so that authority is **no longer reachable by production** — it
survives only inside retained rollback evidence, where it belongs. The audited
`npm run db:retire-stale-installation` command stays available for the retained
database or any future recurrence; running it is no longer required to clear the
finding from the serving system.

## The one action that remains: re-establish the installation

A fresh ADR-compliant database intentionally has no installation authority. Until
Clockify re-POSTs `/lifecycle/installed`, the add-on answers `409 not installed`
for every workspace — the correct fail-closed behavior, and the proof that no v1
authority leaked across the boundary.

Re-establishing it is an owner action in the Clockify console (interactive
sign-in; not automatable from here):

1. Clockify → workspace **Settings → Add-ons → AI Assistant → Uninstall** (type
   `UNINSTALL` to enable the button).
2. **Insert link** → `https://ai-assistant-production-c2e6.up.railway.app/manifest`
   → **INSTALL**.

That POST creates a fresh installation row **and** a fresh install attestation on
the v2 database, completing the review's "fresh authenticated
installation/attestation" requirement. Verify afterwards: `/component/assistant`
with an admin token returns 200 and sets a session cookie, and the aliased
`[lifecycle] event=installed` line appears with `generation=1`.

If an immediate return to the previous state is preferred instead, the
documented rollback restores release `ec09863…` together with
`DATABASE_PATH=/data/ai-assistant.sqlite`; both the tree and the database are
retained for exactly that purpose.

## Still open (unchanged by this run)

- **Credentialed v2 model evidence** — the `eval:*` suites against the live
  provider.
- **A live-Clockify v2 write proof.** `live:v2-full` refuses without its four
  preconditions plus the separate per-step live-write authorization. The broad
  `live-full.ts` matrix ran on the sacrificial workspace — reads PASS=36,
  PREVIEW_OK=9, and `live-sweep` reported 0 leftovers — but its **write columns
  are no longer valid evidence**: it builds a bare `ActionContext` with no
  store-backed journal, so no durable mutation scope opens and `RestCore.mutate`
  correctly refuses each external write (`mutation_scope_required`, sometimes
  classified upward as `commit_outcome_unknown`). That is the fail-closed rule
  working as designed; the script predates full durable-mutation enforcement.
  Confirmed v2 writes are proven against the fake host by
  `npm run test:e2e:real`, not yet against real Clockify.
- **Soak declaration** and **independent human security/recovery sign-off**.
- **Marketplace portal review/upload and Submit for Review.**
