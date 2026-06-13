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
    turn_ms INTEGER NOT NULL,
    model_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_turn_telemetry_workspace_admin_created
    ON turn_telemetry(workspace_id, admin_user_id, created_at)`,
];

export function migrate(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const statement of SCHEMA_STATEMENTS) {
    db.prepare(statement).run();
  }
  // Additive column for DBs created before reports-host capture. ALTER ADD COLUMN
  // throws if it already exists, so add only when missing.
  addColumnIfMissing(db, "installations", "reports_url", "TEXT");
  // Additive column for DBs created before the durable agentic resume (Phase 3):
  // a NULL agent_state_json row confirms exactly as before.
  addColumnIfMissing(db, "pending_confirmations", "agent_state_json", "TEXT");
  // Atomic-claim ledger (r1-concurrency-races-01): old DBs have idempotency_keys
  // with `receipt_json NOT NULL` and no `claimed_at`. Add the column additively,
  // then relax receipt_json via a guarded, crash-idempotent rebuild.
  addColumnIfMissing(db, "idempotency_keys", "claimed_at", "INTEGER");
  relaxIdempotencyReceiptNullable(db);
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
