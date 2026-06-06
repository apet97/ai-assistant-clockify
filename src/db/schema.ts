import type Database from "better-sqlite3";

/**
 * SQLite schema (DATA_MODEL). All tables small and explicit. IDs are strings,
 * timestamps are ISO-8601 UTC strings, and every admin-scoped row carries
 * workspace_id + admin_user_id.
 */
export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS installations (
    workspace_id TEXT PRIMARY KEY,
    addon_id TEXT NOT NULL,
    addon_user_id TEXT NOT NULL,
    addon_token_ciphertext TEXT NOT NULL,
    api_url TEXT,
    backend_url TEXT,
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
  `CREATE INDEX IF NOT EXISTS idx_audit_events_workspace_admin_created
    ON audit_events(workspace_id, admin_user_id, created_at)`,
];

export function migrate(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const statement of SCHEMA_STATEMENTS) {
    db.prepare(statement).run();
  }
}
