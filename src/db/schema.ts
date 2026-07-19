import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  actionResultJson,
  buildActionResultSummary,
  type ActionResultKind,
} from "./action-results.js";

/**
 * SQLite schema (DATA_MODEL). All tables small and explicit. IDs are strings,
 * timestamps are ISO-8601 UTC strings, and every admin-scoped row carries
 * workspace_id + admin_user_id.
 */
const CREATE_LIFECYCLE_AUTHORITY_WATERMARKS = `CREATE TABLE IF NOT EXISTS lifecycle_authority_watermarks (
  workspace_fingerprint_sha256 TEXT PRIMARY KEY CHECK (length(workspace_fingerprint_sha256) = 64),
  lifecycle_issued_at INTEGER NOT NULL CHECK (lifecycle_issued_at >= 0),
  authority_state TEXT NOT NULL CHECK (authority_state IN ('active', 'inactive', 'deleted')),
  installation_generation INTEGER NOT NULL CHECK (installation_generation >= 0),
  recorded_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
)`;

const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS installations (
    workspace_id TEXT PRIMARY KEY,
    addon_id TEXT NOT NULL,
    addon_user_id TEXT NOT NULL,
    addon_token_ciphertext TEXT NOT NULL,
    api_url TEXT,
    backend_url TEXT,
    reports_url TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'deleted')),
    generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
    lifecycle_issued_at INTEGER CHECK (lifecycle_issued_at IS NULL OR lifecycle_issued_at >= 0),
    deletion_started_at TEXT,
    installed_by_user_id TEXT,
    installed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS installation_attestations (
    workspace_id TEXT PRIMARY KEY,
    workspace_sha256 TEXT NOT NULL CHECK (length(workspace_sha256) = 64),
    installation_generation INTEGER NOT NULL CHECK (installation_generation >= 1),
    token_fingerprint_sha256 TEXT NOT NULL CHECK (length(token_fingerprint_sha256) = 64),
    release_sha TEXT NOT NULL,
    release_build_hash TEXT NOT NULL CHECK (length(release_build_hash) = 64),
    server_artifact_sha256 TEXT NOT NULL CHECK (length(server_artifact_sha256) = 64),
    source_relationship TEXT NOT NULL CHECK (source_relationship IN ('exact_head', 'evidence_descendant', 'source_bound_builder')),
    source_binding_sha256 TEXT,
    manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
    installed_at TEXT NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES installations(workspace_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS retired_installation_tokens (
    token_fingerprint_sha256 TEXT PRIMARY KEY CHECK (length(token_fingerprint_sha256) = 64),
    retired_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS admin_policies (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    admin_user_id TEXT NOT NULL,
    policy_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (workspace_id, admin_user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    admin_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    admin_user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    payload_json TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES chat_sessions(id)
  )`,
  `CREATE TABLE IF NOT EXISTS pending_confirmations (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    admin_user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'executing', 'used', 'cancelled', 'expired', 'failed')),
    risk_json TEXT NOT NULL,
    preview_json TEXT NOT NULL,
    operation_json TEXT NOT NULL,
    operation_hash TEXT NOT NULL,
    nonce_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    used_at TEXT,
    result_json TEXT,
    agent_state_json TEXT,
    FOREIGN KEY (session_id) REFERENCES chat_sessions(id)
  )`,
  `CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    admin_user_id TEXT NOT NULL,
    session_id TEXT,
    action_name TEXT NOT NULL,
    risk_json TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created
    ON chat_messages(session_id, created_at)`,
  // History-switcher seek: list a workspace admin's live (non-expired) sessions
  // (store.listSessions). Without it the WHERE workspace_id+admin_user_id+
  // expires_at filter is a full SCAN of an append-only, unpruned table; the
  // per-row title/count subqueries ride idx_chat_messages_session_created above.
  `CREATE INDEX IF NOT EXISTS idx_chat_sessions_workspace_admin_expires
    ON chat_sessions(workspace_id, admin_user_id, expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_pending_confirmations_lookup
    ON pending_confirmations(workspace_id, admin_user_id, status, expires_at)`,
  // Session-scoped seek for the typed-consent guard's countPendingConfirmations
  // (TYPED_CONSENT safety hot path, run on every "yes"/"confirm"-shaped message).
  // Without it the count is a full SCAN over an append-only, unpruned table.
  `CREATE INDEX IF NOT EXISTS idx_pending_confirmations_session
    ON pending_confirmations(session_id, status, expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_events_workspace_admin_created
    ON audit_events(workspace_id, admin_user_id, created_at)`,
  // Atomic-claim ledger (r1-concurrency-races-01). receipt_json is NULLABLE: a
  // CLAIMED row (claim taken BEFORE the commit await) carries no receipt yet;
  // committed_at fills only on success; claimed_at backs the dead-claim sweep.
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
    key TEXT PRIMARY KEY,
    receipt_json TEXT,
    committed_at INTEGER,
    claimed_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS undo_records (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    admin_user_id TEXT NOT NULL,
    action_name TEXT NOT NULL,
    reversal_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('available', 'undone')),
    created_at TEXT NOT NULL,
    undone_at TEXT
  )`,
  // Per-turn model telemetry (cost + latency). prompt/completion tokens are
  // NULL when the backend reported no usage — honest absence, never zero.
  `CREATE TABLE IF NOT EXISTS turn_telemetry (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    admin_user_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('chat', 'resume')),
    model_calls INTEGER NOT NULL,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    cached_prompt_tokens INTEGER,
    turn_ms INTEGER NOT NULL,
    model_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_turn_telemetry_workspace_admin_created
    ON turn_telemetry(workspace_id, admin_user_id, created_at)`,
];

/**
 * Retention-prune index seeks (r2-new-ops-layer-03). The hourly prune (and the
 * at-startup prune) deletes on the bare retention columns — none of the lookup
 * indexes above lead with them, so each DELETE was a full table SCAN that grows
 * with table size on a long-lived instance. These narrow indexes let each prune
 * DELETE SEARCH its retention predicate (pinned by explainPrunePlan in
 * store-retention.test.ts). The two OR predicates are split by pruneExpired into
 * one single-predicate DELETE per disjunct, each seeking a matching index here
 * (SQLite won't OR-union a low-cardinality `status` index).
 *
 * Created AFTER the additive migration steps below, not in SCHEMA_STATEMENTS: the
 * `claimed_at` column is ADDed (and idempotency_keys is rebuilt to relax
 * receipt_json) by the migrate() steps, so an index referencing claimed_at must
 * run after those — indexing a not-yet-added column throws on an OLD DB.
 */
const PRUNE_INDEX_STATEMENTS: string[] = [
  `CREATE INDEX IF NOT EXISTS idx_pending_confirmations_prune_created
    ON pending_confirmations(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_pending_confirmations_prune_expires
    ON pending_confirmations(status, expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_idempotency_keys_prune_committed
    ON idempotency_keys(committed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_idempotency_keys_prune_claimed
    ON idempotency_keys(claimed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_undo_records_prune
    ON undo_records(status, undone_at)`,
  `CREATE INDEX IF NOT EXISTS idx_undo_records_prune_expires
    ON undo_records(status, expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_turn_telemetry_prune_created
    ON turn_telemetry(created_at)`,
  // Chat/audit retention sweep (marketplace data-minimization). The lookup
  // indexes above lead with session_id / workspace_id, so a bare created_at
  // DELETE would full-SCAN; these created_at-leading indexes let it SEARCH.
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_prune_created
    ON chat_messages(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_events_prune_created
    ON audit_events(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_prune_expires
    ON artifacts(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_operation_runs_prune_updated
    ON operation_runs(updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_intent_capabilities_prune_created
    ON intent_capabilities(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_action_results_prune_created
    ON action_results(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_turn_runs_prune_updated
    ON turn_runs(updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_sessions_prune_expires
    ON chat_sessions(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_undo_records_session
    ON undo_records(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_turn_telemetry_session
    ON turn_telemetry(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_turn_runs_session
    ON turn_runs(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_operation_runs_session
    ON operation_runs(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_action_results_session
    ON action_results(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_session
    ON artifacts(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_retention_runs_recorded
    ON retention_runs(recorded_at)`,
];

export const LATEST_SCHEMA_VERSION = 8;

const VERSIONED_MIGRATIONS: ReadonlyArray<{ version: number; statements: readonly string[] }> = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS turn_runs (
        request_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        admin_user_id TEXT NOT NULL,
        intent_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('prepared', 'executing', 'succeeded', 'failed', 'outcome_unknown')),
        response_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, request_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_turn_runs_workspace_admin_updated
        ON turn_runs(workspace_id, admin_user_id, updated_at)`,
      `CREATE TABLE IF NOT EXISTS action_results (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        admin_user_id TEXT NOT NULL,
        session_id TEXT,
        action_name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('succeeded', 'partial', 'definitive_failed', 'outcome_unknown')),
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS operation_runs (
        id TEXT PRIMARY KEY,
        request_id TEXT,
        confirmation_id TEXT,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        admin_user_id TEXT NOT NULL,
        action_name TEXT NOT NULL,
        action_fingerprint TEXT NOT NULL,
        catalog_hash TEXT NOT NULL,
        operation_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('prepared', 'executing', 'succeeded', 'partial', 'definitive_failed', 'outcome_unknown')),
        action_result_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_operation_runs_scope_updated
        ON operation_runs(workspace_id, admin_user_id, updated_at)`,
      `CREATE TABLE IF NOT EXISTS operation_steps (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('prepared', 'executing', 'succeeded', 'definitive_failed', 'outcome_unknown', 'compensated', 'compensation_failed')),
        external_id TEXT,
        fingerprint TEXT,
        detail_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (operation_id, step_index),
        FOREIGN KEY (operation_id) REFERENCES operation_runs(id)
      )`,
      `CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        admin_user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        content_type TEXT NOT NULL,
        filename TEXT NOT NULL,
        bytes BLOB NOT NULL,
        checksum TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_artifacts_scope_expires
        ON artifacts(workspace_id, admin_user_id, expires_at)`,
      `CREATE TABLE IF NOT EXISTS readiness_probe (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        checked_at TEXT NOT NULL
      )`,
      `INSERT OR IGNORE INTO readiness_probe (id, checked_at) VALUES (1, '1970-01-01T00:00:00.000Z')`,
    ],
  },
  {
    version: 2,
    statements: [
      "DROP TABLE IF EXISTS pending_confirmations_v1",
      "ALTER TABLE pending_confirmations RENAME TO pending_confirmations_v1",
      `CREATE TABLE pending_confirmations (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        admin_user_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'executing', 'succeeded', 'partial', 'definitive_failed', 'outcome_unknown', 'cancelled', 'expired')),
        risk_json TEXT NOT NULL,
        preview_json TEXT NOT NULL,
        operation_json TEXT NOT NULL,
        operation_hash TEXT NOT NULL,
        target_fingerprints_json TEXT NOT NULL,
        action_fingerprint TEXT NOT NULL,
        catalog_hash TEXT NOT NULL,
        nonce_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        used_at TEXT,
        result_json TEXT,
        action_result_id TEXT,
        agent_state_json TEXT,
        FOREIGN KEY (session_id) REFERENCES chat_sessions(id)
      )`,
      `INSERT INTO pending_confirmations (
         id, operation_id, session_id, workspace_id, admin_user_id, status, risk_json,
         preview_json, operation_json, operation_hash, target_fingerprints_json,
         action_fingerprint, catalog_hash, nonce_hash, expires_at, created_at, used_at,
         result_json, action_result_id, agent_state_json
       )
       SELECT id, id, session_id, workspace_id, admin_user_id,
         CASE status
           WHEN 'used' THEN 'succeeded'
           WHEN 'failed' THEN 'definitive_failed'
           WHEN 'executing' THEN 'outcome_unknown'
           ELSE status
         END,
         risk_json, preview_json, operation_json, operation_hash, '[]', 'legacy', 'legacy',
         nonce_hash, expires_at, created_at, used_at, result_json, NULL, agent_state_json
       FROM pending_confirmations_v1`,
      "DROP TABLE pending_confirmations_v1",
      `CREATE INDEX idx_pending_confirmations_lookup
        ON pending_confirmations(workspace_id, admin_user_id, status, expires_at)`,
      `CREATE INDEX idx_pending_confirmations_session
        ON pending_confirmations(session_id, status, expires_at)`,
    ],
  },
  {
    version: 3,
    statements: [
      "DROP TABLE IF EXISTS undo_records_v2",
      "ALTER TABLE undo_records RENAME TO undo_records_v2",
      `CREATE TABLE undo_records (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        admin_user_id TEXT NOT NULL,
        action_name TEXT NOT NULL,
        reversal_json TEXT NOT NULL,
        remaining_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('available', 'executing', 'partially_undone', 'undone', 'failed', 'outcome_unknown', 'expired')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        undone_at TEXT,
        result_json TEXT
      )`,
      `INSERT INTO undo_records (
         id, session_id, workspace_id, admin_user_id, action_name, reversal_json,
         remaining_json, status, created_at, expires_at, undone_at, result_json
       )
       SELECT id, session_id, workspace_id, admin_user_id, action_name, reversal_json,
         CASE WHEN status = 'undone' THEN '[]' ELSE reversal_json END,
         CASE WHEN status = 'undone' THEN 'undone' ELSE 'expired' END,
         created_at, created_at, undone_at, NULL
       FROM undo_records_v2`,
      "DROP TABLE undo_records_v2",
    ],
  },
  { version: 4, statements: [] },
  { version: 5, statements: [] },
  { version: 6, statements: [] },
  { version: 7, statements: [] },
  { version: 8, statements: [CREATE_LIFECYCLE_AUTHORITY_WATERMARKS] },
];

export function migrate(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Make the concurrency-critical busy_timeout EXPLICIT rather than silently
  // relying on better-sqlite3's 5000ms default: two admins writing the /data
  // volume at once should wait-and-retry within the window, never 500 on an
  // immediate SQLITE_BUSY. Pinned by a store test so a library-default change
  // (or a stray `new Database(path, { timeout: 0 })`) can't regress it.
  db.pragma("busy_timeout = 5000");
  for (const statement of SCHEMA_STATEMENTS) {
    db.prepare(statement).run();
  }
  // Additive column for DBs created before reports-host capture. ALTER ADD COLUMN
  // throws if it already exists, so add only when missing.
  addColumnIfMissing(db, "installations", "reports_url", "TEXT");
  // Lifecycle authority is versioned independently from ordinary environment
  // refreshes. Existing installations start at generation 1; uninstall leaves a
  // durable tombstone until already-dispatched mutations truthfully settle.
  addColumnIfMissing(db, "installations", "generation", "INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1)");
  addColumnIfMissing(db, "installations", "lifecycle_issued_at", "INTEGER CHECK (lifecycle_issued_at IS NULL OR lifecycle_issued_at >= 0)");
  addColumnIfMissing(db, "installations", "deletion_started_at", "TEXT");
  // Additive column for DBs created before the durable agentic resume (Phase 3):
  // a NULL agent_state_json row confirms exactly as before.
  addColumnIfMissing(db, "pending_confirmations", "agent_state_json", "TEXT");
  // Additive column for DBs created before prompt-cache observability: a NULL
  // cached_prompt_tokens means the backend reported no cache info for that turn.
  addColumnIfMissing(db, "turn_telemetry", "cached_prompt_tokens", "INTEGER");
  // Atomic-claim ledger (r1-concurrency-races-01): old DBs have idempotency_keys
  // with `receipt_json NOT NULL` and no `claimed_at`. Add the column additively,
  // then relax receipt_json via a guarded, crash-idempotent rebuild.
  addColumnIfMissing(db, "idempotency_keys", "claimed_at", "INTEGER");
  relaxIdempotencyReceiptNullable(db);
  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  // These triggers reference the final v4/v5 canonical-result and operation
  // schemas. Drop any definition left by a prior open before a compatibility
  // migration temporarily renames/rebuilds those tables, then reinstall the
  // invariant against the final tables below.
  dropConfirmationOperationTerminalTriggers(db);
  for (const migration of VERSIONED_MIGRATIONS) {
    if (migration.version <= currentVersion) continue;
    db.transaction(() => {
      if (migration.version === 4) migrateToV4(db);
      else if (migration.version === 5) migrateToV5(db);
      else if (migration.version === 6) migrateToV6(db);
      else if (migration.version === 7) migrateToV7(db);
      else for (const statement of migration.statements) db.prepare(statement).run();
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
  // Add these after versioned migrations because the v1-v3 compatibility
  // rebuilds replace both tables. Legacy rows receive NULL and therefore fail
  // closed instead of silently adopting a replacement installation token.
  addColumnIfMissing(db, "pending_confirmations", "installation_generation", "INTEGER CHECK (installation_generation >= 1)");
  addColumnIfMissing(db, "undo_records", "installation_generation", "INTEGER CHECK (installation_generation >= 1)");
  // Queue admission and actual host dispatch are distinct safety boundaries.
  // Older v5-v7 databases gain the timestamp additively; fresh databases pass
  // through migrateToV5 before this statement runs.
  addColumnIfMissing(db, "operation_steps", "queued_at", "TEXT");
  // Also repairs databases opened by an earlier build that already labelled
  // itself v7 before the INSERT-side invariant was added. IF NOT EXISTS keeps
  // normal migration reruns idempotent.
  ensureExpiredPayloadScrubTriggers(db);
  // Backward-compatible additive columns for databases opened by an earlier
  // build of schema v4 before the operation/idempotency ownership links landed.
  addColumnIfMissing(db, "action_results", "operation_id", "TEXT");
  addColumnIfMissing(db, "pending_confirmations", "idempotency_key", "TEXT");
  db.prepare(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_action_results_operation
       ON action_results(operation_id) WHERE operation_id IS NOT NULL`,
  ).run();
  // Confirmation lifecycle and its prepared operation are one security unit.
  // These triggers make every pending -> cancelled/expired transition atomic
  // even when it originates in a one-statement retention batch, and ensure a
  // settled/reconciled confirmation cannot leave an executable operation plan
  // behind in operation_runs. Install them only after the additive canonical-
  // result ownership column above is guaranteed to exist.
  ensureConfirmationOperationTerminalTriggers(db);
  // Retention-prune indexes run last: claimed_at exists and idempotency_keys is
  // in its final (rebuilt) shape, so indexing those columns can't throw.
  for (const statement of PRUNE_INDEX_STATEMENTS) {
    db.prepare(statement).run();
  }
}

/**
 * Bounded operational evidence for retention passes. The scrub triggers finish
 * the table-level scrub constraints that SQLite cannot add with ALTER TABLE:
 * an expired confirmation cannot retain dispatch state and an expired undo
 * cannot retain its reversal payload.
 */
function migrateToV7(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS retention_runs (
      id TEXT PRIMARY KEY,
      recorded_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
      deleted_count INTEGER NOT NULL CHECK (deleted_count >= 0),
      expired_count INTEGER NOT NULL CHECK (expired_count >= 0),
      batches INTEGER NOT NULL CHECK (batches >= 0),
      backlog INTEGER NOT NULL CHECK (backlog IN (0, 1)),
      wal_busy INTEGER NOT NULL CHECK (wal_busy >= 0),
      wal_log INTEGER NOT NULL CHECK (wal_log >= -1),
      wal_checkpointed INTEGER NOT NULL CHECK (wal_checkpointed >= -1),
      counts_json TEXT NOT NULL CHECK (
        json_valid(counts_json) AND length(CAST(counts_json AS BLOB)) <= 65536
      )
    );
    CREATE INDEX IF NOT EXISTS idx_retention_runs_recorded
      ON retention_runs(recorded_at);

    UPDATE pending_confirmations
       SET risk_json = '[]', preview_json = '{}', operation_json = NULL,
           target_fingerprints_json = '[]', nonce_hash = '', agent_state_json = NULL
     WHERE status = 'expired';
    UPDATE undo_records
       SET reversal_json = '[]', remaining_json = '[]'
     WHERE status = 'expired';
  `);
  ensureExpiredPayloadScrubTriggers(db);
}

function ensureExpiredPayloadScrubTriggers(db: Database.Database): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS pending_confirmations_expired_scrub
      BEFORE UPDATE OF status, risk_json, preview_json, target_fingerprints_json,
                       nonce_hash, operation_json, agent_state_json
      ON pending_confirmations
      WHEN NEW.status = 'expired' AND (
        NEW.risk_json <> '[]' OR NEW.preview_json <> '{}' OR
        NEW.target_fingerprints_json <> '[]' OR NEW.nonce_hash <> '' OR
        NEW.operation_json IS NOT NULL OR NEW.agent_state_json IS NOT NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'expired_confirmation_not_scrubbed');
      END;

    CREATE TRIGGER IF NOT EXISTS pending_confirmations_expired_insert_scrub
      BEFORE INSERT ON pending_confirmations
      WHEN NEW.status = 'expired' AND (
        NEW.risk_json <> '[]' OR NEW.preview_json <> '{}' OR
        NEW.target_fingerprints_json <> '[]' OR NEW.nonce_hash <> '' OR
        NEW.operation_json IS NOT NULL OR NEW.agent_state_json IS NOT NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'expired_confirmation_not_scrubbed');
      END;

    CREATE TRIGGER IF NOT EXISTS undo_records_expired_scrub
      BEFORE UPDATE OF status, reversal_json, remaining_json
      ON undo_records
      WHEN NEW.status = 'expired' AND (
        NEW.reversal_json <> '[]' OR NEW.remaining_json <> '[]'
      )
      BEGIN
        SELECT RAISE(ABORT, 'expired_undo_not_scrubbed');
      END;

    CREATE TRIGGER IF NOT EXISTS undo_records_expired_insert_scrub
      BEFORE INSERT ON undo_records
      WHEN NEW.status = 'expired' AND (
        NEW.reversal_json <> '[]' OR NEW.remaining_json <> '[]'
      )
      BEGIN
        SELECT RAISE(ABORT, 'expired_undo_not_scrubbed');
      END;
  `);
}

/**
 * Cross-table confirmation terminalization invariant.
 *
 * `pruneExpired` intentionally expires up to 500 rows with one UPDATE per
 * transaction. Keeping the operation transition in SQLite therefore matters:
 * a process crash cannot commit an expired/cancelled confirmation while leaving
 * its linked operation prepared and executable. The bounded canonical result is
 * passive evidence only; the executable envelope is replaced with `{}`.
 */
function ensureConfirmationOperationTerminalTriggers(db: Database.Database): void {
  db.transaction(() => db.exec(`
    UPDATE pending_confirmations
       SET nonce_hash = '', operation_json = NULL, agent_state_json = NULL
     WHERE status <> 'pending';

    CREATE TRIGGER IF NOT EXISTS pending_confirmation_nonpending_payload_guard
      BEFORE UPDATE OF status, nonce_hash, operation_json, agent_state_json
      ON pending_confirmations
      WHEN NEW.status NOT IN ('pending', 'expired') AND (
        NEW.nonce_hash <> '' OR NEW.operation_json IS NOT NULL OR
        NEW.agent_state_json IS NOT NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'terminal_confirmation_not_scrubbed');
      END;

    CREATE TRIGGER IF NOT EXISTS pending_confirmation_nonpending_insert_guard
      BEFORE INSERT ON pending_confirmations
      WHEN NEW.status NOT IN ('pending', 'expired') AND (
        NEW.nonce_hash <> '' OR NEW.operation_json IS NOT NULL OR
        NEW.agent_state_json IS NOT NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'terminal_confirmation_not_scrubbed');
      END;

    CREATE TRIGGER IF NOT EXISTS pending_confirmation_pre_dispatch_operation_guard
      BEFORE UPDATE OF status ON pending_confirmations
      WHEN OLD.status = 'pending'
       AND NEW.status IN ('cancelled', 'expired')
       AND EXISTS (
         SELECT 1 FROM operation_runs o
          WHERE o.id = OLD.operation_id
            AND (o.status <> 'prepared' OR o.action_result_id IS NOT NULL)
       )
      BEGIN
        SELECT RAISE(ABORT, 'confirmation_operation_not_prepared');
      END;

    CREATE TRIGGER IF NOT EXISTS pending_confirmation_pre_dispatch_terminal
      AFTER UPDATE OF status ON pending_confirmations
      WHEN OLD.status = 'pending' AND NEW.status IN ('cancelled', 'expired')
      BEGIN
        INSERT INTO action_results (
          id, operation_id, workspace_id, admin_user_id, session_id, action_name,
          kind, result_json, summary_json, created_at
        )
        SELECT
          lower(hex(randomblob(16))), o.id, o.workspace_id, o.admin_user_id,
          o.session_id, o.action_name, 'definitive_failed',
          json_object(
            'kind', 'receipt',
            'receipt', json_object(
              'ok', json('false'),
              'action', o.action_name,
              'code', CASE NEW.status
                WHEN 'cancelled' THEN 'confirmation_cancelled'
                ELSE 'confirmation_expired'
              END,
              'message', CASE NEW.status
                WHEN 'cancelled' THEN 'This preview was cancelled before dispatch. No change was made.'
                ELSE 'This preview expired before dispatch. No change was made.'
              END
            )
          ),
          json_object(
            'kind', 'receipt',
            'receipt', json_object(
              'ok', json('false'),
              'action', o.action_name,
              'code', CASE NEW.status
                WHEN 'cancelled' THEN 'confirmation_cancelled'
                ELSE 'confirmation_expired'
              END,
              'message', CASE NEW.status
                WHEN 'cancelled' THEN 'This preview was cancelled before dispatch. No change was made.'
                ELSE 'This preview expired before dispatch. No change was made.'
              END
            )
          ),
          COALESCE(NEW.used_at, NEW.created_at)
        FROM operation_runs o
        WHERE o.id = NEW.operation_id
          AND o.status = 'prepared'
          AND o.action_result_id IS NULL;

        UPDATE operation_runs
           SET status = 'definitive_failed',
               action_result_id = (
                 SELECT a.id FROM action_results a
                  WHERE a.operation_id = operation_runs.id
               ),
               operation_json = '{}',
               updated_at = COALESCE(NEW.used_at, NEW.created_at)
         WHERE id = NEW.operation_id
           AND status = 'prepared'
           AND action_result_id IS NULL;

        UPDATE pending_confirmations
           SET action_result_id = (
                 SELECT a.id FROM action_results a WHERE a.operation_id = NEW.operation_id
               ),
               result_summary_json = (
                 SELECT a.summary_json FROM action_results a WHERE a.operation_id = NEW.operation_id
               )
         WHERE id = NEW.id
           AND action_result_id IS NULL;
      END;

    CREATE TRIGGER IF NOT EXISTS pending_confirmation_settlement_scrubs_operation
      AFTER UPDATE OF status ON pending_confirmations
      WHEN OLD.status IN ('executing', 'outcome_unknown')
       AND NEW.status IN ('succeeded', 'partial', 'definitive_failed')
      BEGIN
        UPDATE operation_runs
           SET operation_json = '{}'
         WHERE id = NEW.operation_id;
      END;

    CREATE TRIGGER IF NOT EXISTS confirmed_operation_terminal_scrub
      AFTER UPDATE OF status ON operation_runs
      WHEN NEW.confirmation_id IS NOT NULL
       AND NEW.status IN ('succeeded', 'partial', 'definitive_failed')
       AND NEW.operation_json <> '{}'
      BEGIN
        UPDATE operation_runs SET operation_json = '{}' WHERE id = NEW.id;
      END;

    -- Repair previews terminalized by an older build that did not settle their
    -- linked prepared operation. This is the startup counterpart of the live
    -- trigger above and is idempotent via the unique operation-owned result.
    INSERT INTO action_results (
      id, operation_id, workspace_id, admin_user_id, session_id, action_name,
      kind, result_json, summary_json, created_at
    )
    SELECT
      lower(hex(randomblob(16))), o.id, o.workspace_id, o.admin_user_id,
      o.session_id, o.action_name, 'definitive_failed',
      json_object(
        'kind', 'receipt',
        'receipt', json_object(
          'ok', json('false'),
          'action', o.action_name,
          'code', CASE c.status
            WHEN 'cancelled' THEN 'confirmation_cancelled'
            ELSE 'confirmation_expired'
          END,
          'message', CASE c.status
            WHEN 'cancelled' THEN 'This preview was cancelled before dispatch. No change was made.'
            ELSE 'This preview expired before dispatch. No change was made.'
          END
        )
      ),
      json_object(
        'kind', 'receipt',
        'receipt', json_object(
          'ok', json('false'),
          'action', o.action_name,
          'code', CASE c.status
            WHEN 'cancelled' THEN 'confirmation_cancelled'
            ELSE 'confirmation_expired'
          END,
          'message', CASE c.status
            WHEN 'cancelled' THEN 'This preview was cancelled before dispatch. No change was made.'
            ELSE 'This preview expired before dispatch. No change was made.'
          END
        )
      ),
      COALESCE(c.used_at, c.created_at)
    FROM pending_confirmations c
    JOIN operation_runs o ON o.id = c.operation_id
    WHERE c.status IN ('cancelled', 'expired')
      AND c.action_result_id IS NULL
      AND o.status = 'prepared'
      AND o.action_result_id IS NULL;

    UPDATE operation_runs
       SET status = 'definitive_failed',
           action_result_id = (
             SELECT a.id FROM action_results a WHERE a.operation_id = operation_runs.id
           ),
           operation_json = '{}',
           updated_at = COALESCE(
             (SELECT c.used_at FROM pending_confirmations c
               WHERE c.operation_id = operation_runs.id
                 AND c.status IN ('cancelled', 'expired')),
             (SELECT c.created_at FROM pending_confirmations c
               WHERE c.operation_id = operation_runs.id
                 AND c.status IN ('cancelled', 'expired')),
             updated_at
           )
     WHERE status = 'prepared'
       AND action_result_id IS NULL
       AND id IN (
         SELECT c.operation_id FROM pending_confirmations c
          WHERE c.status IN ('cancelled', 'expired')
       );

    UPDATE pending_confirmations
       SET action_result_id = (
             SELECT a.id FROM action_results a WHERE a.operation_id = pending_confirmations.operation_id
           ),
           result_summary_json = (
             SELECT a.summary_json FROM action_results a WHERE a.operation_id = pending_confirmations.operation_id
           )
     WHERE status IN ('cancelled', 'expired')
       AND action_result_id IS NULL
       AND EXISTS (
         SELECT 1 FROM action_results a WHERE a.operation_id = pending_confirmations.operation_id
       );

    UPDATE operation_runs
       SET operation_json = '{}'
     WHERE confirmation_id IS NOT NULL
       AND status IN ('succeeded', 'partial', 'definitive_failed');
  `))();
}

function dropConfirmationOperationTerminalTriggers(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS pending_confirmation_nonpending_payload_guard;
    DROP TRIGGER IF EXISTS pending_confirmation_nonpending_insert_guard;
    DROP TRIGGER IF EXISTS pending_confirmation_pre_dispatch_operation_guard;
    DROP TRIGGER IF EXISTS pending_confirmation_pre_dispatch_terminal;
    DROP TRIGGER IF EXISTS pending_confirmation_settlement_scrubs_operation;
    DROP TRIGGER IF EXISTS confirmed_operation_terminal_scrub;
  `);
}

/**
 * Persisted admin-authored write authority. Capability rows are append-only:
 * usage is recorded separately and operation/confirmation rows retain the
 * exact capability id + hash they were authorized against. Nullable bindings
 * intentionally leave pre-v6 previews incompatible with the enforcement path.
 */
function migrateToV6(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS intent_capabilities (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      admin_user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
      catalog_hash TEXT NOT NULL,
      capability_hash TEXT NOT NULL CHECK (length(capability_hash) = 64),
      mode TEXT NOT NULL CHECK (mode IN ('allow', 'deny_all_writes')),
      capability_json TEXT NOT NULL CHECK (
        json_valid(capability_json) AND
        length(CAST(capability_json AS BLOB)) <= 65536
      ),
      created_at TEXT NOT NULL,
      UNIQUE (workspace_id, admin_user_id, session_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS idx_intent_capabilities_scope
      ON intent_capabilities(workspace_id, admin_user_id, session_id, request_id);
    CREATE TRIGGER IF NOT EXISTS intent_capabilities_immutable
      BEFORE UPDATE ON intent_capabilities
      BEGIN
        SELECT RAISE(ABORT, 'intent_capability_immutable');
      END;
  `);

  addColumnIfMissing(db, "operation_runs", "capability_id", "TEXT");
  addColumnIfMissing(db, "pending_confirmations", "capability_id", "TEXT");
  addColumnIfMissing(db, "pending_confirmations", "capability_hash", "TEXT");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_operation_runs_capability
      ON operation_runs(capability_id);
    CREATE INDEX IF NOT EXISTS idx_pending_confirmations_capability
      ON pending_confirmations(capability_id);
    CREATE TABLE IF NOT EXISTS intent_capability_usage (
      id TEXT PRIMARY KEY,
      capability_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      action_name TEXT NOT NULL,
      execution_index INTEGER NOT NULL CHECK (execution_index > 0),
      created_at TEXT NOT NULL,
      UNIQUE (operation_id),
      UNIQUE (capability_id, action_name, execution_index),
      FOREIGN KEY (capability_id) REFERENCES intent_capabilities(id) ON DELETE CASCADE,
      FOREIGN KEY (operation_id) REFERENCES operation_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_intent_capability_usage_action
      ON intent_capability_usage(capability_id, action_name, execution_index);
  `);
}

/**
 * Durable mutation substrate. Operation intent is the canonical, nonsecret
 * normalized wire description retained after a confirmation scrubs its payload.
 * Steps are rebuilt once because SQLite cannot add the stricter status/kind and
 * compensation-link constraints piecemeal.
 */
function migrateToV5(db: Database.Database): void {
  addColumnIfMissing(
    db,
    "operation_runs",
    "operation_json",
    "TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(operation_json))",
  );
  addColumnIfMissing(db, "operation_runs", "reconciled_at", "TEXT");
  addColumnIfMissing(
    db,
    "operation_runs",
    "reconciliation_json",
    "TEXT CHECK (reconciliation_json IS NULL OR json_valid(reconciliation_json))",
  );
  addColumnIfMissing(db, "operation_runs", "capability_hash", "TEXT");

  const stepColumns = db.prepare("PRAGMA table_info(operation_steps)").all() as Array<{ name: string }>;
  if (stepColumns.some((column) => column.name === "plan_step_id")) return;

  db.prepare("DROP TABLE IF EXISTS operation_steps_v4").run();
  db.prepare("ALTER TABLE operation_steps RENAME TO operation_steps_v4").run();
  db.exec(`
    CREATE TABLE operation_steps (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      step_index INTEGER NOT NULL CHECK (step_index >= 0),
      plan_step_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('primary', 'compensation')),
      status TEXT NOT NULL CHECK (status IN (
        'prepared', 'executing', 'succeeded', 'definitive_failed',
        'outcome_unknown', 'compensating', 'compensated',
        'compensation_failed', 'skipped'
      )),
      external_id TEXT,
      target_fingerprint TEXT,
      effect_json TEXT CHECK (effect_json IS NULL OR json_valid(effect_json)),
      detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
      dispatched_at TEXT,
      settled_at TEXT,
      compensates_step_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (operation_id, step_index),
      UNIQUE (operation_id, plan_step_id),
      FOREIGN KEY (operation_id) REFERENCES operation_runs(id),
      FOREIGN KEY (compensates_step_id) REFERENCES operation_steps(id)
    );
    INSERT INTO operation_steps (
      id, operation_id, step_index, plan_step_id, name, kind, status,
      external_id, target_fingerprint, effect_json, detail_json,
      dispatched_at, settled_at, compensates_step_id, created_at, updated_at
    )
    SELECT
      id, operation_id, step_index, name || ':' || step_index, name, 'primary', status,
      external_id, fingerprint, NULL, detail_json,
      CASE WHEN status <> 'prepared' THEN updated_at ELSE NULL END,
      CASE WHEN status NOT IN ('prepared', 'executing') THEN updated_at ELSE NULL END,
      NULL, created_at, updated_at
    FROM operation_steps_v4;
    DROP TABLE operation_steps_v4;
    CREATE INDEX idx_operation_steps_operation ON operation_steps(operation_id, step_index);
  `);
}

const terminalKind = (value: unknown): ActionResultKind => {
  if (value && typeof value === "object" && (value as { kind?: unknown }).kind === "partial") return "partial";
  const receipt = value && typeof value === "object" && "receipt" in value
    ? (value as { receipt?: unknown }).receipt
    : value;
  if (receipt && typeof receipt === "object") {
    if (
      (receipt as { outcome?: unknown }).outcome === "partial" ||
      (receipt as { status?: unknown }).status === "partial"
    ) return "partial";
    if ((receipt as { ok?: unknown }).ok === true) return "succeeded";
    if ((receipt as { code?: unknown }).code === "commit_outcome_unknown") return "outcome_unknown";
  }
  return "definitive_failed";
};

const resultAction = (value: unknown, fallback: string): string => {
  const receipt = value && typeof value === "object" && "receipt" in value
    ? (value as { receipt?: unknown }).receipt
    : value;
  const action = receipt && typeof receipt === "object" ? (receipt as { action?: unknown }).action : undefined;
  return typeof action === "string" && action.length > 0 ? action : fallback;
};

const withoutNonce = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutNonce);
  if (!value || typeof value !== "object") return value;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key !== "nonce") next[key] = withoutNonce(child);
  }
  return next;
};

function migrateToV4(db: Database.Database): void {
  for (const scratch of [
    "action_results_v3",
    "chat_messages_v3",
    "turn_runs_v3",
    "pending_confirmations_v3",
    "audit_events_v3",
    "undo_records_v3",
    "idempotency_keys_v3",
    "artifacts_v3",
  ]) {
    db.prepare(`DROP TABLE IF EXISTS ${scratch}`).run();
  }

  db.prepare("ALTER TABLE action_results RENAME TO action_results_v3").run();
  db.exec(`
    CREATE TABLE action_results (
      id TEXT PRIMARY KEY,
      operation_id TEXT,
      workspace_id TEXT NOT NULL,
      admin_user_id TEXT NOT NULL,
      session_id TEXT,
      action_name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('succeeded', 'partial', 'definitive_failed', 'outcome_unknown')),
      result_json TEXT NOT NULL CHECK (json_valid(result_json)),
      summary_json TEXT NOT NULL CHECK (json_valid(summary_json) AND length(CAST(summary_json AS BLOB)) <= 65536),
      created_at TEXT NOT NULL
    );
  `);
  const legacyResults = db.prepare("SELECT * FROM action_results_v3 ORDER BY rowid").all() as Array<{
    id: string;
    workspace_id: string;
    admin_user_id: string;
    session_id: string | null;
    action_name: string;
    kind: ActionResultKind;
    result_json: string;
    created_at: string;
  }>;
  const insertResult = db.prepare(
    `INSERT INTO action_results (
       id, operation_id, workspace_id, admin_user_id, session_id, action_name, kind,
       result_json, summary_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of legacyResults) {
    const result = JSON.parse(row.result_json) as unknown;
    const operation = db.prepare(
      "SELECT id FROM operation_runs WHERE action_result_id = ? ORDER BY rowid LIMIT 1",
    ).get(row.id) as { id: string } | undefined;
    insertResult.run(
      row.id,
      operation?.id ?? null,
      row.workspace_id,
      row.admin_user_id,
      row.session_id,
      row.action_name,
      row.kind,
      row.result_json,
      actionResultJson(buildActionResultSummary(row.id, result)),
      row.created_at,
    );
  }

  type MigratedCanonical = {
    id: string;
    operationId: string | null;
    workspaceId: string;
    adminUserId: string;
    sessionId: string | null;
    actionName: string;
    kind: ActionResultKind;
    result: unknown;
    createdAt: string;
  };
  const stableValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, stableValue(child)]),
    );
  };
  const identityOf = (value: unknown): string => {
    const receipt = value && typeof value === "object" && "receipt" in value
      ? (value as { receipt?: unknown }).receipt
      : value;
    return actionResultJson(stableValue(withoutNonce(receipt)));
  };
  const graphKey = (input: {
    workspaceId: string;
    adminUserId: string;
    sessionId: string | null;
    actionName: string;
    result: unknown;
  }): string => actionResultJson([
    input.workspaceId,
    input.adminUserId,
    input.sessionId,
    input.actionName,
    identityOf(input.result),
  ]);
  const canonicalRows: MigratedCanonical[] = legacyResults.map((row) => {
    const operation = db.prepare(
      "SELECT id FROM operation_runs WHERE action_result_id = ? ORDER BY rowid LIMIT 1",
    ).get(row.id) as { id: string } | undefined;
    return {
      id: row.id,
      operationId: operation?.id ?? null,
      workspaceId: row.workspace_id,
      adminUserId: row.admin_user_id,
      sessionId: row.session_id,
      actionName: row.action_name,
      kind: row.kind,
      result: JSON.parse(row.result_json),
      createdAt: row.created_at,
    };
  });
  const canonicalById = new Map(canonicalRows.map((row) => [row.id, row]));
  const canonicalByGraph = new Map<string, MigratedCanonical[]>();
  for (const row of canonicalRows) {
    const key = graphKey(row);
    const graph = canonicalByGraph.get(key) ?? [];
    graph.push(row);
    canonicalByGraph.set(key, graph);
  }
  const ownerConsumptions = new Map<string, Set<string>>();
  const ownerConsumption = (owner: string, key: string): Set<string> => {
    const ownerKey = `${owner}\u0000${key}`;
    const consumed = ownerConsumptions.get(ownerKey) ?? new Set<string>();
    ownerConsumptions.set(ownerKey, consumed);
    return consumed;
  };
  const createCanonical = (input: {
    owner: "chat" | "turn" | "confirmation" | "audit" | "undo";
    workspaceId: string;
    adminUserId: string;
    sessionId: string | null;
    actionName: string;
    result: unknown;
    kind?: ActionResultKind;
    createdAt: string;
    operationId?: string;
    preferredId?: string;
  }): { id: string; kind: ActionResultKind; summary: unknown } => {
    const key = graphKey(input);
    const graph = canonicalByGraph.get(key) ?? [];
    const consumed = ownerConsumption(input.owner, key);
    const preferred = input.preferredId ? canonicalById.get(input.preferredId) : undefined;
    const candidate = preferred && graphKey(preferred) === key && !consumed.has(preferred.id)
      ? preferred
      : graph.find((row) => !consumed.has(row.id));
    if (candidate) {
      consumed.add(candidate.id);
      const desiredKind = input.kind ?? terminalKind(input.result);
      if (desiredKind === "partial" && candidate.kind !== "partial") {
        const promotedSummary = buildActionResultSummary(candidate.id, input.result);
        db.prepare(
          "UPDATE action_results SET kind = 'partial', result_json = ?, summary_json = ? WHERE id = ?",
        ).run(actionResultJson(input.result), actionResultJson(promotedSummary), candidate.id);
        candidate.kind = "partial";
        candidate.result = input.result;
        return { id: candidate.id, kind: "partial", summary: promotedSummary };
      }
      const stored = db.prepare("SELECT summary_json FROM action_results WHERE id = ?").get(candidate.id) as {
        summary_json: string;
      };
      return { id: candidate.id, kind: candidate.kind, summary: JSON.parse(stored.summary_json) };
    }
    const id = randomUUID();
    const kind = input.kind ?? terminalKind(input.result);
    const summary = buildActionResultSummary(id, input.result);
    insertResult.run(
      id,
      input.operationId ?? null,
      input.workspaceId,
      input.adminUserId,
      input.sessionId,
      input.actionName,
      kind,
      actionResultJson(input.result),
      actionResultJson(summary),
      input.createdAt,
    );
    const created = {
      id,
      operationId: input.operationId ?? null,
      workspaceId: input.workspaceId,
      adminUserId: input.adminUserId,
      sessionId: input.sessionId,
      actionName: input.actionName,
      kind,
      result: input.result,
      createdAt: input.createdAt,
    };
    canonicalRows.push(created);
    canonicalById.set(id, created);
    graph.push(created);
    canonicalByGraph.set(key, graph);
    consumed.add(id);
    return { id, kind, summary };
  };

  db.prepare("ALTER TABLE chat_messages RENAME TO chat_messages_v3").run();
  db.exec(`
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      admin_user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id)
    );
    CREATE TABLE chat_message_result_links (
      message_id TEXT NOT NULL,
      result_index INTEGER NOT NULL CHECK (result_index >= 0),
      descriptor_kind TEXT NOT NULL CHECK (descriptor_kind IN ('action_result', 'preview', 'inline')),
      action_result_id TEXT,
      descriptor_json TEXT CHECK (descriptor_json IS NULL OR json_valid(descriptor_json)),
      PRIMARY KEY (message_id, result_index),
      FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
    );
  `);
  const insertMessage = db.prepare(
    `INSERT INTO chat_messages (
       id, session_id, workspace_id, admin_user_id, role, content, payload_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMessageLink = db.prepare(
    `INSERT INTO chat_message_result_links (
       message_id, result_index, descriptor_kind, action_result_id, descriptor_json
     ) VALUES (?, ?, ?, ?, ?)`,
  );
  const legacyMessages = db.prepare("SELECT * FROM chat_messages_v3 ORDER BY rowid").all() as Array<{
    id: string;
    session_id: string;
    workspace_id: string;
    admin_user_id: string;
    role: string;
    content: string;
    payload_json: string | null;
    created_at: string;
  }>;
  for (const row of legacyMessages) {
    const payload = row.payload_json ? JSON.parse(row.payload_json) as Record<string, unknown> : undefined;
    const results = Array.isArray(payload?.results) ? payload.results : [];
    const envelope = payload ? withoutNonce(Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "results"))) : undefined;
    insertMessage.run(
      row.id,
      row.session_id,
      row.workspace_id,
      row.admin_user_id,
      row.role,
      row.content,
      envelope === undefined ? null : actionResultJson(envelope),
      row.created_at,
    );
    results.forEach((result, index) => {
      const kind = result && typeof result === "object" ? (result as { kind?: unknown }).kind : undefined;
      if (kind === "receipt" || kind === "partial") {
        const ref = createCanonical({
          owner: "chat",
          workspaceId: row.workspace_id,
          adminUserId: row.admin_user_id,
          sessionId: row.session_id,
          actionName: resultAction(result, "legacy"),
          result,
          createdAt: row.created_at,
        });
        insertMessageLink.run(row.id, index, "action_result", ref.id, null);
      } else {
        insertMessageLink.run(
          row.id,
          index,
          kind === "preview" ? "preview" : "inline",
          null,
          actionResultJson(withoutNonce(result)),
        );
      }
    });
  }

  db.prepare("ALTER TABLE turn_runs RENAME TO turn_runs_v3").run();
  db.exec(`
    CREATE TABLE turn_runs (
      request_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      admin_user_id TEXT NOT NULL,
      intent_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('prepared', 'executing', 'succeeded', 'failed', 'outcome_unknown')),
      response_envelope_json TEXT CHECK (response_envelope_json IS NULL OR json_valid(response_envelope_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, request_id)
    );
    CREATE TABLE turn_run_result_links (
      session_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      result_index INTEGER NOT NULL CHECK (result_index >= 0),
      descriptor_kind TEXT NOT NULL CHECK (descriptor_kind IN ('action_result', 'preview', 'inline')),
      action_result_id TEXT,
      descriptor_json TEXT CHECK (descriptor_json IS NULL OR json_valid(descriptor_json)),
      PRIMARY KEY (session_id, request_id, result_index),
      FOREIGN KEY (session_id, request_id) REFERENCES turn_runs(session_id, request_id) ON DELETE CASCADE
    );
  `);
  const insertTurn = db.prepare(
    `INSERT INTO turn_runs (
       request_id, session_id, workspace_id, admin_user_id, intent_hash, status,
       response_envelope_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertTurnLink = db.prepare(
    `INSERT INTO turn_run_result_links (
       session_id, request_id, result_index, descriptor_kind, action_result_id, descriptor_json
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const legacyTurns = db.prepare("SELECT * FROM turn_runs_v3 ORDER BY rowid").all() as Array<{
    request_id: string;
    session_id: string;
    workspace_id: string;
    admin_user_id: string;
    intent_hash: string;
    status: string;
    response_json: string | null;
    created_at: string;
    updated_at: string;
  }>;
  for (const row of legacyTurns) {
    const response = row.response_json ? JSON.parse(row.response_json) as Record<string, unknown> : undefined;
    const body = response?.body && typeof response.body === "object" ? response.body as Record<string, unknown> : undefined;
    const results = Array.isArray(body?.results) ? body.results : [];
    const cleanBody = body ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "results")) : body;
    const envelope = response
      ? withoutNonce({ ...response, ...(cleanBody ? { body: cleanBody } : {}) })
      : undefined;
    insertTurn.run(
      row.request_id,
      row.session_id,
      row.workspace_id,
      row.admin_user_id,
      row.intent_hash,
      row.status,
      envelope === undefined ? null : actionResultJson(envelope),
      row.created_at,
      row.updated_at,
    );
    const operationOccurrences = new Map<string, number>();
    results.forEach((result, index) => {
      const kind = result && typeof result === "object" ? (result as { kind?: unknown }).kind : undefined;
      if (kind === "receipt" || kind === "partial") {
        const actionName = resultAction(result, "legacy");
        const operationOccurrence = operationOccurrences.get(actionName) ?? 0;
        operationOccurrences.set(actionName, operationOccurrence + 1);
        const operation = db.prepare(
          `SELECT id, action_result_id
             FROM operation_runs
            WHERE request_id = ? AND action_name = ?
            ORDER BY rowid LIMIT 1 OFFSET ?`,
        ).get(row.request_id, actionName, operationOccurrence) as {
          id: string;
          action_result_id: string | null;
        } | undefined;
        const ref = createCanonical({
          owner: "turn",
          workspaceId: row.workspace_id,
          adminUserId: row.admin_user_id,
          sessionId: row.session_id,
          actionName,
          result,
          createdAt: row.updated_at,
          operationId: operation?.id,
          preferredId: operation?.action_result_id ?? undefined,
        });
        insertTurnLink.run(row.session_id, row.request_id, index, "action_result", ref.id, null);
      } else {
        insertTurnLink.run(
          row.session_id,
          row.request_id,
          index,
          kind === "preview" ? "preview" : "inline",
          null,
          actionResultJson(withoutNonce(result)),
        );
      }
    });
  }

  db.prepare("ALTER TABLE pending_confirmations RENAME TO pending_confirmations_v3").run();
  db.exec(`
    CREATE TABLE pending_confirmations (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      admin_user_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'executing', 'succeeded', 'partial', 'definitive_failed', 'outcome_unknown', 'cancelled', 'expired')),
      risk_json TEXT NOT NULL,
      preview_json TEXT NOT NULL,
      operation_json TEXT,
      operation_hash TEXT NOT NULL,
      target_fingerprints_json TEXT NOT NULL,
      action_fingerprint TEXT NOT NULL,
      catalog_hash TEXT NOT NULL,
      nonce_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      used_at TEXT,
      action_result_id TEXT,
      idempotency_key TEXT,
      result_summary_json TEXT CHECK (result_summary_json IS NULL OR (json_valid(result_summary_json) AND length(CAST(result_summary_json AS BLOB)) <= 65536)),
      agent_state_json TEXT,
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id)
    );
  `);
  const legacyConfirmations = db.prepare("SELECT * FROM pending_confirmations_v3 ORDER BY rowid").all() as Array<Record<string, unknown>>;
  const insertConfirmation = db.prepare(
    `INSERT INTO pending_confirmations (
       id, operation_id, session_id, workspace_id, admin_user_id, status, risk_json,
       preview_json, operation_json, operation_hash, target_fingerprints_json,
       action_fingerprint, catalog_hash, nonce_hash, expires_at, created_at, used_at,
       action_result_id, idempotency_key, result_summary_json, agent_state_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of legacyConfirmations) {
    const status = row.status as string;
    const terminal = !["pending", "executing"].includes(status);
    let actionResultId = row.action_result_id as string | null;
    let summary: unknown;
    if (actionResultId) {
      const result = db.prepare("SELECT summary_json FROM action_results WHERE id = ?").get(actionResultId) as { summary_json: string } | undefined;
      summary = result ? JSON.parse(result.summary_json) : undefined;
    } else if (terminal && typeof row.result_json === "string") {
      const full = JSON.parse(row.result_json) as unknown;
      const operation = typeof row.operation_json === "string" ? JSON.parse(row.operation_json) as { actionName?: string } : undefined;
      const ref = createCanonical({
        owner: "confirmation",
        workspaceId: row.workspace_id as string,
        adminUserId: row.admin_user_id as string,
        sessionId: row.session_id as string,
        actionName: resultAction(full, operation?.actionName ?? "legacy"),
        result: full,
        kind: status === "partial" || status === "outcome_unknown" || status === "definitive_failed" || status === "succeeded"
          ? status
          : undefined,
        createdAt: row.used_at as string || row.created_at as string,
      });
      actionResultId = ref.id;
      summary = ref.summary;
    }
    insertConfirmation.run(
      row.id,
      row.operation_id,
      row.session_id,
      row.workspace_id,
      row.admin_user_id,
      status,
      row.risk_json,
      row.preview_json,
      terminal ? null : row.operation_json,
      row.operation_hash,
      row.target_fingerprints_json,
      row.action_fingerprint,
      row.catalog_hash,
      terminal ? "" : row.nonce_hash,
      row.expires_at,
      row.created_at,
      row.used_at,
      actionResultId,
      null,
      summary === undefined ? null : actionResultJson(summary),
      terminal ? null : row.agent_state_json,
    );
  }

  db.prepare("ALTER TABLE audit_events RENAME TO audit_events_v3").run();
  db.exec(`
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      admin_user_id TEXT NOT NULL,
      session_id TEXT,
      action_name TEXT NOT NULL,
      risk_json TEXT NOT NULL,
      action_result_id TEXT NOT NULL,
      result_summary_json TEXT NOT NULL CHECK (json_valid(result_summary_json) AND length(CAST(result_summary_json AS BLOB)) <= 65536),
      created_at TEXT NOT NULL
    );
  `);
  const legacyAudit = db.prepare("SELECT * FROM audit_events_v3 ORDER BY rowid").all() as Array<Record<string, unknown>>;
  const insertAudit = db.prepare(
    `INSERT INTO audit_events (
       id, workspace_id, admin_user_id, session_id, action_name, risk_json,
       action_result_id, result_summary_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of legacyAudit) {
    const receipt = JSON.parse(row.receipt_json as string) as unknown;
    const partialReceipt = terminalKind(receipt) === "partial" && receipt && typeof receipt === "object" && !Array.isArray(receipt)
      ? receipt as Record<string, unknown>
      : undefined;
    const result = partialReceipt
      ? {
          kind: "partial",
          receipt: Object.fromEntries(
            Object.entries(partialReceipt).filter(([key]) => !["outcome", "message", "recovery"].includes(key)),
          ),
          ...(Object.hasOwn(partialReceipt, "message") ? { message: partialReceipt.message } : {}),
          ...(Object.hasOwn(partialReceipt, "recovery") ? { recovery: partialReceipt.recovery } : {}),
        }
      : { kind: "receipt", receipt };
    const ref = createCanonical({
      owner: "audit",
      workspaceId: row.workspace_id as string,
      adminUserId: row.admin_user_id as string,
      sessionId: row.session_id as string | null,
      actionName: row.action_name as string,
      result,
      createdAt: row.created_at as string,
    });
    insertAudit.run(row.id, row.workspace_id, row.admin_user_id, row.session_id, row.action_name, row.risk_json, ref.id, actionResultJson(ref.summary), row.created_at);
  }

  db.prepare("ALTER TABLE undo_records RENAME TO undo_records_v3").run();
  db.exec(`
    CREATE TABLE undo_records (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      admin_user_id TEXT NOT NULL,
      action_name TEXT NOT NULL,
      reversal_json TEXT NOT NULL,
      remaining_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('available', 'executing', 'partially_undone', 'undone', 'failed', 'outcome_unknown', 'expired')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      undone_at TEXT,
      action_result_id TEXT,
      result_summary_json TEXT CHECK (result_summary_json IS NULL OR (json_valid(result_summary_json) AND length(CAST(result_summary_json AS BLOB)) <= 65536))
    );
  `);
  const legacyUndo = db.prepare("SELECT * FROM undo_records_v3 ORDER BY rowid").all() as Array<Record<string, unknown>>;
  const insertUndo = db.prepare(
    `INSERT INTO undo_records (
       id, session_id, workspace_id, admin_user_id, action_name, reversal_json,
       remaining_json, status, created_at, expires_at, undone_at,
       action_result_id, result_summary_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of legacyUndo) {
    let ref: { id: string; summary: unknown } | undefined;
    if (typeof row.result_json === "string") {
      const full = JSON.parse(row.result_json) as unknown;
      ref = createCanonical({
        owner: "undo",
        workspaceId: row.workspace_id as string,
        adminUserId: row.admin_user_id as string,
        sessionId: row.session_id as string,
        actionName: "undo",
        result: { kind: "receipt", receipt: full },
        createdAt: row.undone_at as string || row.created_at as string,
      });
    }
    insertUndo.run(
      row.id,
      row.session_id,
      row.workspace_id,
      row.admin_user_id,
      row.action_name,
      row.reversal_json,
      row.remaining_json,
      row.status,
      row.created_at,
      row.expires_at,
      row.undone_at,
      ref?.id ?? null,
      ref ? actionResultJson(ref.summary) : null,
    );
  }

  db.prepare("ALTER TABLE idempotency_keys RENAME TO idempotency_keys_v3").run();
  db.exec(`
    CREATE TABLE idempotency_keys (
      key TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      admin_user_id TEXT NOT NULL,
      action_result_id TEXT,
      result_summary_json TEXT CHECK (result_summary_json IS NULL OR (json_valid(result_summary_json) AND length(CAST(result_summary_json AS BLOB)) <= 65536)),
      committed_at INTEGER,
      claimed_at INTEGER,
      PRIMARY KEY (key, workspace_id, admin_user_id)
    );
  `);

  db.prepare("ALTER TABLE artifacts RENAME TO artifacts_v3").run();
  db.exec(`
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      admin_user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      content_type TEXT NOT NULL,
      filename TEXT NOT NULL,
      bytes BLOB NOT NULL CHECK (length(bytes) <= 1000000),
      checksum TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    INSERT INTO artifacts
      SELECT * FROM artifacts_v3 WHERE length(bytes) <= 1000000;
  `);

  for (const table of [
    "action_results_v3",
    "chat_messages_v3",
    "turn_runs_v3",
    "pending_confirmations_v3",
    "audit_events_v3",
    "undo_records_v3",
    "idempotency_keys_v3",
    "artifacts_v3",
  ]) {
    db.prepare(`DROP TABLE ${table}`).run();
  }

  db.exec(`
    CREATE INDEX idx_chat_messages_session_created ON chat_messages(session_id, created_at);
    CREATE INDEX idx_pending_confirmations_lookup ON pending_confirmations(workspace_id, admin_user_id, status, expires_at);
    CREATE INDEX idx_pending_confirmations_session ON pending_confirmations(session_id, status, expires_at);
    CREATE INDEX idx_audit_events_workspace_admin_created ON audit_events(workspace_id, admin_user_id, created_at);
    CREATE INDEX idx_turn_runs_workspace_admin_updated ON turn_runs(workspace_id, admin_user_id, updated_at);
    CREATE INDEX idx_artifacts_scope_expires ON artifacts(workspace_id, admin_user_id, expires_at);
    CREATE INDEX idx_chat_message_result_links_action ON chat_message_result_links(action_result_id);
    CREATE INDEX idx_turn_run_result_links_action ON turn_run_result_links(action_result_id);
  `);
}

/**
 * Relax `idempotency_keys.receipt_json` from NOT NULL to NULLABLE on an existing
 * DB. better-sqlite3 (SQLite) can't drop NOT NULL via ALTER, so we rebuild the
 * table — but only when the old constraint is still present (PRAGMA notnull=1).
 *
 * Crash-safety: the rebuild is wrapped in ONE transaction (atomic) and prefixed
 * with `DROP TABLE IF EXISTS idempotency_keys_new`, so a leftover scratch table
 * from a crashed prior rebuild cannot wedge startup (a re-CREATE of an existing
 * table throws "table already exists" — probed). Fires at most once per DB.
 */
function relaxIdempotencyReceiptNullable(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(idempotency_keys)").all() as Array<{
    name: string;
    notnull: number;
  }>;
  const receipt = cols.find((c) => c.name === "receipt_json");
  if (!receipt || receipt.notnull !== 1) return; // already nullable (or table absent)

  db.transaction(() => {
    db.prepare("DROP TABLE IF EXISTS idempotency_keys_new").run();
    db.prepare(
      `CREATE TABLE idempotency_keys_new (
         key TEXT PRIMARY KEY,
         receipt_json TEXT,
         committed_at INTEGER,
         claimed_at INTEGER
       )`,
    ).run();
    db.prepare(
      `INSERT INTO idempotency_keys_new (key, receipt_json, committed_at, claimed_at)
         SELECT key, receipt_json, committed_at, claimed_at FROM idempotency_keys`,
    ).run();
    db.prepare("DROP TABLE idempotency_keys").run();
    db.prepare("ALTER TABLE idempotency_keys_new RENAME TO idempotency_keys").run();
  })();
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  type: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
  }
}
