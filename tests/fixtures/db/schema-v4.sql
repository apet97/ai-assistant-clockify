-- Historical schema fixture v4 (canonical action results, commit 694fc01).
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE installations (
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
  );
CREATE TABLE admin_policies (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    admin_user_id TEXT NOT NULL,
    policy_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (workspace_id, admin_user_id)
  );
CREATE TABLE chat_sessions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    admin_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
CREATE TABLE turn_telemetry (
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
  );
CREATE TABLE operation_runs (
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
      );
CREATE TABLE operation_steps (
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
      );
CREATE TABLE readiness_probe (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        checked_at TEXT NOT NULL
      );
INSERT INTO readiness_probe VALUES(1,'1970-01-01T00:00:00.000Z');
CREATE TABLE action_results (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      admin_user_id TEXT NOT NULL,
      session_id TEXT,
      action_name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('succeeded', 'partial', 'definitive_failed', 'outcome_unknown')),
      result_json TEXT NOT NULL CHECK (json_valid(result_json)),
      summary_json TEXT NOT NULL CHECK (json_valid(summary_json) AND length(CAST(summary_json AS BLOB)) <= 65536),
      created_at TEXT NOT NULL
    );
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
      result_summary_json TEXT CHECK (result_summary_json IS NULL OR (json_valid(result_summary_json) AND length(CAST(result_summary_json AS BLOB)) <= 65536)),
      agent_state_json TEXT,
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id)
    );
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
CREATE INDEX idx_chat_sessions_workspace_admin_expires
    ON chat_sessions(workspace_id, admin_user_id, expires_at);
CREATE INDEX idx_turn_telemetry_workspace_admin_created
    ON turn_telemetry(workspace_id, admin_user_id, created_at);
CREATE INDEX idx_operation_runs_scope_updated
        ON operation_runs(workspace_id, admin_user_id, updated_at);
CREATE INDEX idx_chat_messages_session_created ON chat_messages(session_id, created_at);
CREATE INDEX idx_pending_confirmations_lookup ON pending_confirmations(workspace_id, admin_user_id, status, expires_at);
CREATE INDEX idx_pending_confirmations_session ON pending_confirmations(session_id, status, expires_at);
CREATE INDEX idx_audit_events_workspace_admin_created ON audit_events(workspace_id, admin_user_id, created_at);
CREATE INDEX idx_turn_runs_workspace_admin_updated ON turn_runs(workspace_id, admin_user_id, updated_at);
CREATE INDEX idx_artifacts_scope_expires ON artifacts(workspace_id, admin_user_id, expires_at);
CREATE INDEX idx_chat_message_result_links_action ON chat_message_result_links(action_result_id);
CREATE INDEX idx_turn_run_result_links_action ON turn_run_result_links(action_result_id);
CREATE INDEX idx_pending_confirmations_prune_created
    ON pending_confirmations(created_at);
CREATE INDEX idx_pending_confirmations_prune_expires
    ON pending_confirmations(status, expires_at);
CREATE INDEX idx_idempotency_keys_prune_committed
    ON idempotency_keys(committed_at);
CREATE INDEX idx_idempotency_keys_prune_claimed
    ON idempotency_keys(claimed_at);
CREATE INDEX idx_undo_records_prune
    ON undo_records(status, undone_at);
CREATE INDEX idx_undo_records_prune_expires
    ON undo_records(status, expires_at);
CREATE INDEX idx_turn_telemetry_prune_created
    ON turn_telemetry(created_at);
CREATE INDEX idx_chat_messages_prune_created
    ON chat_messages(created_at);
CREATE INDEX idx_audit_events_prune_created
    ON audit_events(created_at);
CREATE INDEX idx_artifacts_prune_expires
    ON artifacts(expires_at);
CREATE INDEX idx_operation_runs_prune_updated
    ON operation_runs(updated_at);
CREATE INDEX idx_action_results_prune_created
    ON action_results(created_at);
CREATE INDEX idx_turn_runs_prune_updated
    ON turn_runs(updated_at);
CREATE INDEX idx_chat_sessions_prune_expires
    ON chat_sessions(expires_at);
CREATE INDEX idx_undo_records_session
    ON undo_records(session_id);
CREATE INDEX idx_turn_telemetry_session
    ON turn_telemetry(session_id);
CREATE INDEX idx_turn_runs_session
    ON turn_runs(session_id);
CREATE INDEX idx_operation_runs_session
    ON operation_runs(session_id);
CREATE INDEX idx_action_results_session
    ON action_results(session_id);
CREATE INDEX idx_artifacts_session
    ON artifacts(session_id);
PRAGMA user_version = 4;
COMMIT;
