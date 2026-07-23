-- Historical schema fixture v9 (assistant run state).
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
  , generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1), lifecycle_issued_at INTEGER CHECK (lifecycle_issued_at IS NULL OR lifecycle_issued_at >= 0), deletion_started_at TEXT);
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
      , operation_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(operation_json)), reconciled_at TEXT, reconciliation_json TEXT CHECK (reconciliation_json IS NULL OR json_valid(reconciliation_json)), capability_hash TEXT, capability_id TEXT);
CREATE TABLE readiness_probe (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        checked_at TEXT NOT NULL
      );
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
      idempotency_key TEXT,
      result_summary_json TEXT CHECK (result_summary_json IS NULL OR (json_valid(result_summary_json) AND length(CAST(result_summary_json AS BLOB)) <= 65536)),
      agent_state_json TEXT, capability_id TEXT, capability_hash TEXT, installation_generation INTEGER CHECK (installation_generation >= 1),
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
    , installation_generation INTEGER CHECK (installation_generation >= 1));
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
      updated_at TEXT NOT NULL, queued_at TEXT,
      UNIQUE (operation_id, step_index),
      UNIQUE (operation_id, plan_step_id),
      FOREIGN KEY (operation_id) REFERENCES operation_runs(id),
      FOREIGN KEY (compensates_step_id) REFERENCES operation_steps(id)
    );
CREATE TABLE intent_capabilities (
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
CREATE TABLE intent_capability_usage (
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
CREATE TABLE retention_runs (
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
CREATE INDEX idx_operation_steps_operation ON operation_steps(operation_id, step_index);
CREATE INDEX idx_intent_capabilities_scope
      ON intent_capabilities(workspace_id, admin_user_id, session_id, request_id);
CREATE TRIGGER intent_capabilities_immutable
      BEFORE UPDATE ON intent_capabilities
      BEGIN
        SELECT RAISE(ABORT, 'intent_capability_immutable');
      END;
CREATE INDEX idx_operation_runs_capability
      ON operation_runs(capability_id);
CREATE INDEX idx_pending_confirmations_capability
      ON pending_confirmations(capability_id);
CREATE INDEX idx_intent_capability_usage_action
      ON intent_capability_usage(capability_id, action_name, execution_index);
CREATE INDEX idx_retention_runs_recorded
      ON retention_runs(recorded_at);
CREATE TRIGGER pending_confirmations_expired_scrub
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
CREATE TRIGGER pending_confirmations_expired_insert_scrub
      BEFORE INSERT ON pending_confirmations
      WHEN NEW.status = 'expired' AND (
        NEW.risk_json <> '[]' OR NEW.preview_json <> '{}' OR
        NEW.target_fingerprints_json <> '[]' OR NEW.nonce_hash <> '' OR
        NEW.operation_json IS NOT NULL OR NEW.agent_state_json IS NOT NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'expired_confirmation_not_scrubbed');
      END;
CREATE TRIGGER undo_records_expired_scrub
      BEFORE UPDATE OF status, reversal_json, remaining_json
      ON undo_records
      WHEN NEW.status = 'expired' AND (
        NEW.reversal_json <> '[]' OR NEW.remaining_json <> '[]'
      )
      BEGIN
        SELECT RAISE(ABORT, 'expired_undo_not_scrubbed');
      END;
CREATE TRIGGER undo_records_expired_insert_scrub
      BEFORE INSERT ON undo_records
      WHEN NEW.status = 'expired' AND (
        NEW.reversal_json <> '[]' OR NEW.remaining_json <> '[]'
      )
      BEGIN
        SELECT RAISE(ABORT, 'expired_undo_not_scrubbed');
      END;
CREATE UNIQUE INDEX idx_action_results_operation
       ON action_results(operation_id) WHERE operation_id IS NOT NULL;
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
CREATE INDEX idx_intent_capabilities_prune_created
    ON intent_capabilities(created_at);
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
CREATE TABLE lifecycle_authority_watermarks (
    workspace_fingerprint_sha256 TEXT PRIMARY KEY CHECK (length(workspace_fingerprint_sha256) = 64),
    lifecycle_issued_at INTEGER NOT NULL CHECK (lifecycle_issued_at >= 0),
    authority_state TEXT NOT NULL CHECK (authority_state IN ('active', 'inactive', 'deleted')),
    installation_generation INTEGER NOT NULL CHECK (installation_generation >= 0),
    recorded_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
CREATE TABLE installation_attestations (
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
  );
CREATE TABLE retired_installation_tokens (
    token_fingerprint_sha256 TEXT PRIMARY KEY CHECK (length(token_fingerprint_sha256) = 64),
    retired_at TEXT NOT NULL
  );
CREATE UNIQUE INDEX idx_turn_runs_request_scope
    ON turn_runs(session_id, request_id, workspace_id, admin_user_id);
CREATE TABLE assistant_runs (
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  admin_user_id TEXT NOT NULL,
  installation_generation INTEGER NOT NULL CHECK (installation_generation >= 0),
  auth_class TEXT NOT NULL CHECK (auth_class IN ('addon', 'api_key')),
  original_request TEXT NOT NULL
    CHECK (length(CAST(original_request AS BLOB)) <= 16000),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  phase TEXT NOT NULL CHECK (phase IN (
    'model', 'discovering', 'executing_reads', 'preparing_writes',
    'awaiting_confirmation', 'awaiting_clarification', 'completed', 'failed'
  )),
  registry_id TEXT NOT NULL CHECK (registry_id = 'v2-api'),
  catalog_hash TEXT NOT NULL CHECK (length(catalog_hash) = 64),
  loaded_tool_names_json TEXT NOT NULL
    CHECK (json_valid(loaded_tool_names_json)
      AND length(CAST(loaded_tool_names_json AS BLOB)) <= 8192),
  used_tool_names_json TEXT NOT NULL
    CHECK (json_valid(used_tool_names_json)
      AND length(CAST(used_tool_names_json AS BLOB)) <= 8192),
  continuation_json TEXT NOT NULL
    CHECK (json_valid(continuation_json)
      AND length(CAST(continuation_json AS BLOB)) <= 65536),
  budget_json TEXT NOT NULL
    CHECK (json_valid(budget_json)
      AND length(CAST(budget_json AS BLOB)) <= 4096),
  unfinished_operations_json TEXT NOT NULL
    CHECK (json_valid(unfinished_operations_json)
      AND length(CAST(unfinished_operations_json AS BLOB)) <= 16384),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, run_id),
  UNIQUE (session_id, run_id, workspace_id, admin_user_id),
  FOREIGN KEY (session_id, run_id, workspace_id, admin_user_id)
    REFERENCES turn_runs(session_id, request_id, workspace_id, admin_user_id)
    ON DELETE CASCADE
);
CREATE INDEX idx_assistant_runs_scope_updated
    ON assistant_runs(
      workspace_id, admin_user_id, session_id,
      installation_generation, auth_class, updated_at DESC
    );
CREATE INDEX idx_assistant_runs_phase_updated
    ON assistant_runs(phase, updated_at);
CREATE UNIQUE INDEX idx_assistant_runs_one_active_per_session
    ON assistant_runs(session_id)
    WHERE phase NOT IN ('completed', 'failed');
CREATE TABLE assistant_run_request_links (
    session_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    admin_user_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('initial', 'free_text_continuation')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, request_id),
    CHECK (
      (kind = 'initial' AND request_id = run_id)
      OR (kind = 'free_text_continuation' AND request_id <> run_id)
    ),
    FOREIGN KEY (session_id, request_id, workspace_id, admin_user_id)
      REFERENCES turn_runs(session_id, request_id, workspace_id, admin_user_id)
      ON DELETE CASCADE,
    FOREIGN KEY (session_id, run_id, workspace_id, admin_user_id)
      REFERENCES assistant_runs(session_id, run_id, workspace_id, admin_user_id)
      ON DELETE CASCADE
  );
CREATE INDEX idx_assistant_run_request_links_run
    ON assistant_run_request_links(
      workspace_id, admin_user_id, session_id, run_id, created_at
    );
CREATE UNIQUE INDEX idx_action_results_id_scope
    ON action_results(id, session_id, workspace_id, admin_user_id);
CREATE TABLE assistant_run_result_links (
    session_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    workspace_id TEXT NOT NULL,
    admin_user_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL
      CHECK (length(CAST(tool_call_id AS BLOB)) BETWEEN 1 AND 256),
    action_name TEXT NOT NULL
      CHECK (length(CAST(action_name AS BLOB)) BETWEEN 1 AND 256),
    action_result_id TEXT NOT NULL,
    PRIMARY KEY (session_id, run_id, sequence),
    UNIQUE (session_id, run_id, tool_call_id),
    FOREIGN KEY (session_id, run_id, workspace_id, admin_user_id)
      REFERENCES assistant_runs(session_id, run_id, workspace_id, admin_user_id)
      ON DELETE CASCADE,
    FOREIGN KEY (action_result_id, session_id, workspace_id, admin_user_id)
      REFERENCES action_results(id, session_id, workspace_id, admin_user_id)
      ON DELETE RESTRICT
  );
CREATE INDEX idx_assistant_run_result_links_result
    ON assistant_run_result_links(action_result_id);
CREATE INDEX idx_assistant_runs_prune_updated
    ON assistant_runs(updated_at);
CREATE TRIGGER pending_confirmation_nonpending_payload_guard
      BEFORE UPDATE OF status, nonce_hash, operation_json, agent_state_json
      ON pending_confirmations
      WHEN NEW.status NOT IN ('pending', 'expired') AND (
        NEW.nonce_hash <> '' OR NEW.operation_json IS NOT NULL OR
        NEW.agent_state_json IS NOT NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'terminal_confirmation_not_scrubbed');
      END;
CREATE TRIGGER pending_confirmation_nonpending_insert_guard
      BEFORE INSERT ON pending_confirmations
      WHEN NEW.status NOT IN ('pending', 'expired') AND (
        NEW.nonce_hash <> '' OR NEW.operation_json IS NOT NULL OR
        NEW.agent_state_json IS NOT NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'terminal_confirmation_not_scrubbed');
      END;
CREATE TRIGGER pending_confirmation_pre_dispatch_operation_guard
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
CREATE TRIGGER pending_confirmation_pre_dispatch_terminal
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
CREATE TRIGGER pending_confirmation_settlement_scrubs_operation
      AFTER UPDATE OF status ON pending_confirmations
      WHEN OLD.status IN ('executing', 'outcome_unknown')
       AND NEW.status IN ('succeeded', 'partial', 'definitive_failed')
      BEGIN
        UPDATE operation_runs
           SET operation_json = '{}'
         WHERE id = NEW.operation_id;
      END;
CREATE TRIGGER confirmed_operation_terminal_scrub
      AFTER UPDATE OF status ON operation_runs
      WHEN NEW.confirmation_id IS NOT NULL
       AND NEW.status IN ('succeeded', 'partial', 'definitive_failed')
       AND NEW.operation_json <> '{}'
      BEGIN
        UPDATE operation_runs SET operation_json = '{}' WHERE id = NEW.id;
      END;

CREATE TABLE run_events (
    session_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    workspace_id TEXT NOT NULL,
    admin_user_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN (
      'run.started', 'model.started', 'model.completed',
      'api.search_started', 'api.operations_loaded',
      'tool.requested', 'tool.denied', 'tool.started', 'tool.completed',
      'operation.prepared', 'operation.confirmed', 'operation.started',
      'operation.completed', 'clarification.required', 'run.suspended',
      'run.completed', 'run.failed'
    )),
    payload_json TEXT NOT NULL
      CHECK (json_valid(payload_json)
        AND length(CAST(payload_json AS BLOB)) <= 65536),
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, run_id, sequence),
    FOREIGN KEY (session_id, run_id, workspace_id, admin_user_id)
      REFERENCES assistant_runs(session_id, run_id, workspace_id, admin_user_id)
      ON DELETE CASCADE
  );
CREATE INDEX idx_run_events_scope_sequence
    ON run_events(workspace_id, admin_user_id, session_id, run_id, sequence);
CREATE INDEX idx_run_events_prune_created
    ON run_events(created_at);
PRAGMA user_version = 10;
COMMIT;
