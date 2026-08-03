# Schema migration data boundaries

Two `migrate()` steps deliberately DROP rows rather than carry them forward.
Both are fail-closed choices, both are pinned by
`tests/unit/db-migration.test.ts`, and neither may be "fixed" by widening the
migration. This document exists so an operator reading a row-count difference
after an upgrade can tell an intended boundary from a bug.

## 1. v3 → v4 idempotency ledger: legacy rows are dropped

**What happens.** `idempotency_keys` is rebuilt with primary key
`(key, workspace_id, admin_user_id)`. Rows from the v3 table are not copied, so
the ledger is empty immediately after the upgrade.

**Why not migrate them.** A v3 row has no tenant columns at all. There is no
value to migrate them *with* — any `workspace_id`/`admin_user_id` written during
migration would be invented. For a dedupe ledger specifically, an invented owner
is worse than an absent row in both directions:

- attributed to the wrong admin, it suppresses that admin's next legitimate
  write as a "duplicate";
- attributed to nobody real, it never matches and does nothing anyway.

Both failures are silent, which is what rules the guess out.

**Blast radius, bounded.** The ledger only suppresses repeat commits inside a
10-minute window (`IDEMPOTENCY_WINDOW_MS`). An emptied ledger therefore costs at
most the loss of dedupe for work in flight at the moment of upgrade. It cannot
lose or corrupt a committed result: those live in `action_results`, which the
migration preserves.

**Operator check after upgrade.** `SELECT COUNT(*) FROM idempotency_keys` is
expected to be 0 (or to contain only post-upgrade rows). A non-zero count of
rows with a placeholder tenant would indicate exactly the bug this boundary
prevents.

**If these rows are ever genuinely needed**, that requires a separately
authorized data-recovery design that establishes ownership from evidence — audit
rows, operation journals — and not a widened migration. Do not add a back-fill
to `schema.ts`.

## 2. v3 → v4 artifacts: rows over 1 MiB are excluded

**What happens.** The v4 `artifacts` table declares
`CHECK (length(bytes) <= 1000000)`, and the copy is
`INSERT INTO artifacts SELECT * FROM artifacts_v3 WHERE length(bytes) <= 1000000`.
An artifact larger than the limit is not carried forward.

**Why not truncate.** Two options were available and both are worse:

- copying the oversized row unchanged aborts the whole migration on the CHECK
  constraint and wedges the upgrade;
- copying a truncated prefix produces a file whose bytes no longer match its
  stored `checksum` — a corrupt artifact presented to the admin as a valid one.

**Blast radius, bounded.** Artifacts are short-lived derived exports carrying an
`expires_at`; they are never a system of record. Dropping one loses a
regenerable download.

**Operator check after upgrade.** Compare
`SELECT COUNT(*) FROM artifacts_v3 WHERE length(bytes) > 1000000` (before the
scratch tables are dropped) against the expectation that those ids are absent
from `artifacts`. Any such artifact can simply be re-exported.

## Backup and restore verification

Neither boundary is recoverable from the migrated database, so the pre-migration
backup is the only source. The release procedure already requires one:

1. `npm run db:capture-backup-boundary -- <file>` records the conservative RPO
   boundary BEFORE the snapshot begins.
2. The online backup is taken in the production service's Console
   (`npm run db:backup -- <source> <dest>`), producing the database plus
   `.sha256` and `.json` sidecars.
3. `npm run db:verify-restore -- <restored> <sha256> <metadata>` proves the
   backup actually restores: it verifies the checksum and format-2 metadata,
   runs `PRAGMA integrity_check`, validates the installation columns, performs
   one token-backed read, then starts the exact built production entrypoint
   against a private clone and requires `GET /health` 200.
4. `npm run gate:predeploy-backup` binds that evidence to the release candidate
   and requires both the backup and the restore readiness to be under one hour
   old.

`metadata.source` must name the database actually being protected. With two
databases on the volume (`/data/ai-assistant.sqlite` and
`/data/ai-assistant-v2.sqlite`), a backup of the wrong one passes every other
check — checksum, bytes, integrity, schema, freshness — so that field is the
only thing tying the evidence to the right file.

See `DEPLOYMENT.md` for the full transaction.
