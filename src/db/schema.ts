import type Database from "better-sqlite3";

/**
 * SQLite schema (DATA_MODEL). All tables small and explicit. IDs are strings,
 * timestamps are ISO-8601 UTC strings, and every admin-scoped row carries
 * workspace_id + admin_user_id.
 */
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
    installed_by_user_id TEXT,
    installed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
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
];

export const LATEST_SCHEMA_VERSION = 3;

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
  for (const migration of VERSIONED_MIGRATIONS) {
    if (migration.version <= currentVersion) continue;
    db.transaction(() => {
      for (const statement of migration.statements) db.prepare(statement).run();
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
  // Retention-prune indexes run last: claimed_at exists and idempotency_keys is
  // in its final (rebuilt) shape, so indexing those columns can't throw.
  for (const statement of PRUNE_INDEX_STATEMENTS) {
    db.prepare(statement).run();
  }
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
