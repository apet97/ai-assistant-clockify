import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decryptSecret, encryptSecret } from "../../src/db/encryption.js";
import { LATEST_SCHEMA_VERSION, migrate } from "../../src/db/schema.js";

/**
 * The idempotency-ledger migration (r1-concurrency-races-01): an OLD DB has
 * idempotency_keys with `receipt_json NOT NULL` and no `claimed_at` column. The
 * atomic-claim design needs receipt_json NULLABLE (a CLAIMED row carries no
 * receipt yet) and a `claimed_at` column. The migration relaxes the column via a
 * guarded, transactional rebuild that must be crash-idempotent (a leftover
 * `idempotency_keys_new` from a crashed prior rebuild must not wedge startup).
 */
function oldSchema(db: Database.Database): void {
  db.prepare(
    `CREATE TABLE idempotency_keys (
       key TEXT PRIMARY KEY,
       receipt_json TEXT NOT NULL,
       committed_at INTEGER NOT NULL
     )`,
  ).run();
}

function receiptNotNull(db: Database.Database): boolean {
  const cols = db.prepare("PRAGMA table_info(idempotency_keys)").all() as Array<{
    name: string;
    notnull: number;
  }>;
  return cols.find((c) => c.name === "receipt_json")?.notnull === 1;
}

describe("idempotency_keys migration", () => {
  it("rebuilds the ledger with explicit tenant scope and deletes legacy unscoped rows", () => {
    const db = new Database(":memory:");
    oldSchema(db);
    db.prepare(
      "INSERT INTO idempotency_keys (key, receipt_json, committed_at) VALUES (?, ?, ?)",
    ).run("legacy", JSON.stringify({ ok: true, action: "x" }), 1_000);
    expect(receiptNotNull(db)).toBe(true); // precondition: old shape

    expect(() => migrate(db)).not.toThrow();

    // The v4 ledger carries explicit tenant scope and no full receipt copy.
    const cols = db.prepare("PRAGMA table_info(idempotency_keys)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "claimed_at")).toBe(true);
    expect(cols.map((c) => c.name)).toEqual([
      "key",
      "workspace_id",
      "admin_user_id",
      "action_result_id",
      "result_summary_json",
      "committed_at",
      "claimed_at",
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").get()).toEqual({ n: 0 });
    db.close();
  });

  it("is crash-idempotent: a leftover idempotency_keys_new from a crashed rebuild does not wedge migrate()", () => {
    const db = new Database(":memory:");
    oldSchema(db);
    db.prepare(
      "INSERT INTO idempotency_keys (key, receipt_json, committed_at) VALUES (?, ?, ?)",
    ).run("legacy", JSON.stringify({ ok: true, action: "x" }), 1_000);
    // Simulate a crash mid-rebuild: the *_new scratch table is left behind.
    db.prepare(
      `CREATE TABLE idempotency_keys_new (
         key TEXT PRIMARY KEY,
         receipt_json TEXT,
         committed_at INTEGER,
         claimed_at INTEGER
       )`,
    ).run();

    expect(() => migrate(db)).not.toThrow();

    // The scratch table is gone and the drained migration discarded unscoped data.
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).not.toContain("idempotency_keys_new");
    expect(db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").get()).toEqual({ n: 0 });
    db.close();
  });

  it("is a no-op on an already-migrated (new-schema) DB", () => {
    const db = new Database(":memory:");
    migrate(db); // fresh install gets the nullable schema directly
    expect(() => migrate(db)).not.toThrow();
    expect(() => migrate(db)).not.toThrow(); // re-running stays clean
    expect(receiptNotNull(db)).toBe(false);
    db.close();
  });
});

describe("historical database migration", () => {
  it("migrates a representative version-0 database transactionally and reruns idempotently", () => {
    const db = new Database(":memory:");
    const tokenCiphertext = encryptSecret("legacy-addon-token", "legacy-key");

    db.exec(`
      CREATE TABLE installations (
        workspace_id TEXT PRIMARY KEY,
        addon_id TEXT NOT NULL,
        addon_user_id TEXT NOT NULL,
        addon_token_ciphertext TEXT NOT NULL,
        api_url TEXT,
        backend_url TEXT,
        status TEXT NOT NULL,
        installed_by_user_id TEXT,
        installed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE chat_sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        admin_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE pending_confirmations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        admin_user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        risk_json TEXT NOT NULL,
        preview_json TEXT NOT NULL,
        operation_json TEXT NOT NULL,
        operation_hash TEXT NOT NULL,
        nonce_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        used_at TEXT,
        result_json TEXT
      );
      CREATE TABLE undo_records (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        admin_user_id TEXT NOT NULL,
        action_name TEXT NOT NULL,
        reversal_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        undone_at TEXT
      );
      CREATE TABLE idempotency_keys (
        key TEXT PRIMARY KEY,
        receipt_json TEXT NOT NULL,
        committed_at INTEGER NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO installations (
         workspace_id, addon_id, addon_user_id, addon_token_ciphertext, api_url,
         backend_url, status, installed_by_user_id, installed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "ws-legacy",
      "addon-legacy",
      "addon-user-legacy",
      tokenCiphertext,
      "https://api.clockify.me/api/v1",
      "https://global.api.clockify.me",
      "active",
      "admin-legacy",
      "2025-01-01T00:00:00.000Z",
      "2025-01-01T00:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO chat_sessions VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "session-legacy",
      "ws-legacy",
      "admin-legacy",
      "2025-01-01T00:00:00.000Z",
      "2025-01-01T00:00:00.000Z",
      "2099-01-01T00:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO pending_confirmations (
         id, session_id, workspace_id, admin_user_id, status, risk_json,
         preview_json, operation_json, operation_hash, nonce_hash, expires_at,
         created_at, used_at, result_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(
      "confirmation-legacy",
      "session-legacy",
      "ws-legacy",
      "admin-legacy",
      "executing",
      '["destructive"]',
      '{"title":"Delete tag"}',
      '{"actionName":"clockify_tags_delete"}',
      "operation-hash",
      "nonce-hash",
      "2099-01-01T00:00:00.000Z",
      "2025-01-01T00:00:00.000Z",
    );
    const reversal = '[{"entityType":"tag","id":"tag-1","name":"legacy"}]';
    db.prepare(
      `INSERT INTO undo_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      "undo-legacy",
      "session-legacy",
      "ws-legacy",
      "admin-legacy",
      "clockify_tags_create",
      reversal,
      "available",
      "2025-01-01T00:00:00.000Z",
    );
    db.prepare(
      "INSERT INTO idempotency_keys (key, receipt_json, committed_at) VALUES (?, ?, ?)",
    ).run("legacy-key", '{"ok":true,"action":"clockify_tags_create"}', 1_735_689_600_000);

    migrate(db);
    migrate(db);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    const installation = db.prepare(
      "SELECT addon_token_ciphertext, reports_url FROM installations WHERE workspace_id = ?",
    ).get("ws-legacy") as { addon_token_ciphertext: string; reports_url: string | null };
    expect(decryptSecret(installation.addon_token_ciphertext, "legacy-key")).toBe("legacy-addon-token");
    expect(installation.reports_url).toBeNull();

    const confirmation = db.prepare(
      `SELECT operation_id, status, target_fingerprints_json, action_fingerprint,
              catalog_hash, agent_state_json
         FROM pending_confirmations WHERE id = ?`,
    ).get("confirmation-legacy") as Record<string, unknown>;
    expect(confirmation).toMatchObject({
      operation_id: "confirmation-legacy",
      status: "outcome_unknown",
      target_fingerprints_json: "[]",
      action_fingerprint: "legacy",
      catalog_hash: "legacy",
      agent_state_json: null,
    });

    const undo = db.prepare(
      "SELECT status, remaining_json, expires_at FROM undo_records WHERE id = ?",
    ).get("undo-legacy") as { status: string; remaining_json: string; expires_at: string };
    expect(undo).toEqual({
      status: "expired",
      remaining_json: "[]",
      expires_at: "2025-01-01T00:00:00.000Z",
    });
    expect(db.prepare("SELECT * FROM idempotency_keys WHERE key = ?").get("legacy-key")).toBeUndefined();
    db.close();
  });
});

function v3GraphDatabase(): Database.Database {
  const db = new Database(":memory:");
  migrate(db);
  db.pragma("foreign_keys = OFF");
  db.exec(`
    DROP TABLE chat_message_result_links;
    DROP TABLE turn_run_result_links;
    DROP TABLE chat_messages;
    DROP TABLE turn_runs;
    DROP TABLE pending_confirmations;
    DROP TABLE audit_events;
    DROP TABLE undo_records;
    DROP TABLE idempotency_keys;
    DROP TABLE action_results;
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      admin_user_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
      payload_json TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE turn_runs (
      request_id TEXT NOT NULL, session_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      admin_user_id TEXT NOT NULL, intent_hash TEXT NOT NULL, status TEXT NOT NULL,
      response_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, request_id)
    );
    CREATE TABLE pending_confirmations (
      id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, session_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL, admin_user_id TEXT NOT NULL, status TEXT NOT NULL,
      risk_json TEXT NOT NULL, preview_json TEXT NOT NULL, operation_json TEXT,
      operation_hash TEXT NOT NULL, target_fingerprints_json TEXT NOT NULL,
      action_fingerprint TEXT NOT NULL, catalog_hash TEXT NOT NULL, nonce_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL, used_at TEXT, result_json TEXT,
      action_result_id TEXT, agent_state_json TEXT
    );
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, admin_user_id TEXT NOT NULL,
      session_id TEXT, action_name TEXT NOT NULL, risk_json TEXT NOT NULL,
      receipt_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE undo_records (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      admin_user_id TEXT NOT NULL, action_name TEXT NOT NULL, reversal_json TEXT NOT NULL,
      remaining_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, undone_at TEXT, result_json TEXT
    );
    CREATE TABLE idempotency_keys (
      key TEXT PRIMARY KEY, receipt_json TEXT, committed_at INTEGER, claimed_at INTEGER
    );
    CREATE TABLE action_results (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, admin_user_id TEXT NOT NULL,
      session_id TEXT, action_name TEXT NOT NULL, kind TEXT NOT NULL,
      result_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    PRAGMA user_version = 3;
  `);
  return db;
}

function insertGraphSession(db: Database.Database, id: string, at: string): void {
  db.prepare(
    `INSERT INTO chat_sessions
       (id, workspace_id, admin_user_id, created_at, last_seen_at, expires_at)
     VALUES (?, 'ws', 'admin', ?, ?, '2099-01-01T00:00:00.000Z')`,
  ).run(id, at, at);
}

describe("schema v4 canonical-result ownership", () => {
  it("keeps two identical executions in one turn as two occurrence-correlated canonical results", () => {
    const db = v3GraphDatabase();
    const at = "2026-01-01T00:00:00.000Z";
    const action = "clockify_tags_create";
    const receipt = { ok: true, action, changed: { created: [{ type: "tag", id: "same" }] } };
    const result = { kind: "receipt", receipt };
    insertGraphSession(db, "session-occurrences", at);
    for (const index of [1, 2]) {
      db.prepare(
        `INSERT INTO action_results
           (id, workspace_id, admin_user_id, session_id, action_name, kind, result_json, created_at)
         VALUES (?, 'ws', 'admin', 'session-occurrences', ?, 'succeeded', ?, ?)`,
      ).run(`result-${index}`, action, JSON.stringify(result), at);
      db.prepare(
        `INSERT INTO operation_runs
           (id, request_id, confirmation_id, session_id, workspace_id, admin_user_id,
            action_name, action_fingerprint, catalog_hash, operation_hash, status,
            action_result_id, created_at, updated_at)
         VALUES (?, 'request-occurrences', NULL, 'session-occurrences', 'ws', 'admin',
                 ?, 'fingerprint', 'catalog', ?, 'succeeded', ?, ?, ?)`,
      ).run(`operation-${index}`, action, `hash-${index}`, `result-${index}`, at, at);
      db.prepare(
        `INSERT INTO audit_events
           (id, workspace_id, admin_user_id, session_id, action_name, risk_json, receipt_json, created_at)
         VALUES (?, 'ws', 'admin', 'session-occurrences', ?, '[]', ?, ?)`,
      ).run(`audit-${index}`, action, JSON.stringify(receipt), at);
    }
    db.prepare(
      `INSERT INTO chat_messages
         (id, session_id, workspace_id, admin_user_id, role, content, payload_json, created_at)
       VALUES ('message-occurrences', 'session-occurrences', 'ws', 'admin', 'assistant', 'Created', ?, ?)`,
    ).run(JSON.stringify({ kind: "answer", results: [result, result] }), at);
    db.prepare(
      `INSERT INTO turn_runs
         (request_id, session_id, workspace_id, admin_user_id, intent_hash, status,
          response_json, created_at, updated_at)
       VALUES ('request-occurrences', 'session-occurrences', 'ws', 'admin', 'intent', 'succeeded', ?, ?, ?)`,
    ).run(JSON.stringify({ status: 200, body: { ok: true, results: [result, result] } }), at, at);

    migrate(db);

    expect(db.prepare("SELECT id FROM action_results ORDER BY id").all()).toEqual([{ id: "result-1" }, { id: "result-2" }]);
    expect(db.prepare("SELECT action_result_id FROM chat_message_result_links ORDER BY result_index").all()).toEqual([
      { action_result_id: "result-1" },
      { action_result_id: "result-2" },
    ]);
    expect(db.prepare("SELECT action_result_id FROM turn_run_result_links ORDER BY result_index").all()).toEqual([
      { action_result_id: "result-1" },
      { action_result_id: "result-2" },
    ]);
    expect(db.prepare("SELECT action_result_id FROM audit_events ORDER BY id").all()).toEqual([
      { action_result_id: "result-1" },
      { action_result_id: "result-2" },
    ]);
    db.close();
  });

  it("converges delayed copies of one execution without a time window", () => {
    const db = v3GraphDatabase();
    const times = [
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:02:00.000Z",
      "2026-01-01T00:04:00.000Z",
      "2026-01-01T00:06:00.000Z",
    ];
    const action = "clockify_tags_create";
    const receipt = { ok: true, action, changed: { created: [{ type: "tag", id: "tag-delayed" }] } };
    const result = { kind: "receipt", receipt };
    insertGraphSession(db, "session-delayed", times[0]);
    db.prepare(
      `INSERT INTO action_results VALUES ('result-delayed', 'ws', 'admin', 'session-delayed', ?, 'succeeded', ?, ?)`,
    ).run(action, JSON.stringify(result), times[0]);
    db.prepare(
      `INSERT INTO operation_runs
         (id, request_id, confirmation_id, session_id, workspace_id, admin_user_id,
          action_name, action_fingerprint, catalog_hash, operation_hash, status,
          action_result_id, created_at, updated_at)
       VALUES ('operation-delayed', 'request-delayed', NULL, 'session-delayed', 'ws', 'admin',
               ?, 'fingerprint', 'catalog', 'hash', 'succeeded', 'result-delayed', ?, ?)`,
    ).run(action, times[0], times[0]);
    db.prepare(
      `INSERT INTO chat_messages VALUES ('message-delayed', 'session-delayed', 'ws', 'admin', 'assistant', 'Created', ?, ?)`,
    ).run(JSON.stringify({ kind: "answer", results: [result] }), times[1]);
    db.prepare(
      `INSERT INTO turn_runs VALUES ('request-delayed', 'session-delayed', 'ws', 'admin', 'intent', 'succeeded', ?, ?, ?)`,
    ).run(JSON.stringify({ status: 200, body: { ok: true, results: [result] } }), times[0], times[2]);
    db.prepare(
      `INSERT INTO audit_events VALUES ('audit-delayed', 'ws', 'admin', 'session-delayed', ?, '[]', ?, ?)`,
    ).run(action, JSON.stringify(receipt), times[3]);

    migrate(db);

    expect(db.prepare("SELECT id FROM action_results").all()).toEqual([{ id: "result-delayed" }]);
    expect(db.prepare("SELECT action_result_id FROM chat_message_result_links").get()).toEqual({ action_result_id: "result-delayed" });
    expect(db.prepare("SELECT action_result_id FROM turn_run_result_links").get()).toEqual({ action_result_id: "result-delayed" });
    expect(db.prepare("SELECT action_result_id FROM audit_events").get()).toEqual({ action_result_id: "result-delayed" });
    db.close();
  });

  it("converges historical partial owners and preserves partial kind", () => {
    const db = v3GraphDatabase();
    const at = "2026-01-01T00:00:00.000Z";
    const delayed = "2026-01-01T00:02:00.000Z";
    const action = "clockify_tags_create";
    const receipt = { ok: true, action, warnings: ["One of two tags was created."] };
    const message = "Stopped after one tag.";
    const recovery = { hint: "Review the created tag before retrying.", retryable: false };
    const partial = { kind: "partial", receipt, message, recovery };
    const auditReceipt = { ...receipt, outcome: "partial", message, recovery };
    insertGraphSession(db, "session-partial", at);
    db.prepare(
      `INSERT INTO action_results VALUES ('result-partial', 'ws', 'admin', 'session-partial', ?, 'partial', ?, ?)`,
    ).run(action, JSON.stringify(partial), at);
    db.prepare(
      `INSERT INTO operation_runs
         (id, request_id, confirmation_id, session_id, workspace_id, admin_user_id,
          action_name, action_fingerprint, catalog_hash, operation_hash, status,
          action_result_id, created_at, updated_at)
       VALUES ('operation-partial', 'request-partial', NULL, 'session-partial', 'ws', 'admin',
               ?, 'fingerprint', 'catalog', 'hash', 'partial', 'result-partial', ?, ?)`,
    ).run(action, at, at);
    db.prepare(
      `INSERT INTO chat_messages VALUES ('message-partial', 'session-partial', 'ws', 'admin', 'assistant', 'Partly created', ?, ?)`,
    ).run(JSON.stringify({ kind: "answer", results: [partial] }), at);
    db.prepare(
      `INSERT INTO turn_runs VALUES ('request-partial', 'session-partial', 'ws', 'admin', 'intent', 'succeeded', ?, ?, ?)`,
    ).run(JSON.stringify({ status: 200, body: { ok: true, results: [partial] } }), at, at);
    db.prepare(
      `INSERT INTO audit_events VALUES ('audit-partial', 'ws', 'admin', 'session-partial', ?, '[]', ?, ?)`,
    ).run(action, JSON.stringify(auditReceipt), delayed);

    migrate(db);

    expect(db.prepare("SELECT id, kind FROM action_results").all()).toEqual([{ id: "result-partial", kind: "partial" }]);
    expect(db.prepare("SELECT action_result_id FROM chat_message_result_links").get()).toEqual({ action_result_id: "result-partial" });
    expect(db.prepare("SELECT action_result_id FROM turn_run_result_links").get()).toEqual({ action_result_id: "result-partial" });
    expect(db.prepare("SELECT action_result_id FROM audit_events").get()).toEqual({ action_result_id: "result-partial" });
    expect(JSON.parse((db.prepare("SELECT result_json FROM action_results WHERE id = 'result-partial'").get() as {
      result_json: string;
    }).result_json)).toEqual(partial);
    db.close();
  });

  it("converges one v3 action graph on one canonical result instead of cloning each historical copy", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.pragma("foreign_keys = OFF");
    db.exec(`
      DROP TABLE chat_message_result_links;
      DROP TABLE turn_run_result_links;
      DROP TABLE chat_messages;
      DROP TABLE turn_runs;
      DROP TABLE pending_confirmations;
      DROP TABLE audit_events;
      DROP TABLE undo_records;
      DROP TABLE idempotency_keys;
      DROP TABLE action_results;

      CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        admin_user_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
        payload_json TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE turn_runs (
        request_id TEXT NOT NULL, session_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        admin_user_id TEXT NOT NULL, intent_hash TEXT NOT NULL, status TEXT NOT NULL,
        response_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, request_id)
      );
      CREATE TABLE pending_confirmations (
        id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL, admin_user_id TEXT NOT NULL, status TEXT NOT NULL,
        risk_json TEXT NOT NULL, preview_json TEXT NOT NULL, operation_json TEXT,
        operation_hash TEXT NOT NULL, target_fingerprints_json TEXT NOT NULL,
        action_fingerprint TEXT NOT NULL, catalog_hash TEXT NOT NULL, nonce_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL, created_at TEXT NOT NULL, used_at TEXT, result_json TEXT,
        action_result_id TEXT, agent_state_json TEXT
      );
      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, admin_user_id TEXT NOT NULL,
        session_id TEXT, action_name TEXT NOT NULL, risk_json TEXT NOT NULL,
        receipt_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE undo_records (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        admin_user_id TEXT NOT NULL, action_name TEXT NOT NULL, reversal_json TEXT NOT NULL,
        remaining_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL, undone_at TEXT, result_json TEXT
      );
      CREATE TABLE idempotency_keys (
        key TEXT PRIMARY KEY, receipt_json TEXT, committed_at INTEGER, claimed_at INTEGER
      );
      CREATE TABLE action_results (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, admin_user_id TEXT NOT NULL,
        session_id TEXT, action_name TEXT NOT NULL, kind TEXT NOT NULL,
        result_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      PRAGMA user_version = 3;
    `);

    const at = "2026-01-01T00:00:00.000Z";
    const receipt = {
      ok: true,
      action: "clockify_tags_create",
      changed: { created: [{ entityType: "tag", id: "tag-1" }] },
    };
    const result = { kind: "receipt", receipt };
    db.prepare(
      `INSERT INTO chat_sessions
         (id, workspace_id, admin_user_id, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("session-graph", "ws", "admin", at, at, "2099-01-01T00:00:00.000Z");
    db.prepare(
      `INSERT INTO action_results
         (id, workspace_id, admin_user_id, session_id, action_name, kind, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("result-graph", "ws", "admin", "session-graph", receipt.action, "succeeded", JSON.stringify(result), at);
    db.prepare(
      `INSERT INTO operation_runs
         (id, request_id, confirmation_id, session_id, workspace_id, admin_user_id,
          action_name, action_fingerprint, catalog_hash, operation_hash, status,
          action_result_id, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("operation-graph", "request-graph", "session-graph", "ws", "admin", receipt.action, "fingerprint", "catalog", "hash", "succeeded", "result-graph", at, at);
    db.prepare(
      `INSERT INTO chat_messages
         (id, session_id, workspace_id, admin_user_id, role, content, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("message-graph", "session-graph", "ws", "admin", "assistant", "Created", JSON.stringify({ kind: "answer", results: [result] }), at);
    db.prepare(
      `INSERT INTO turn_runs
         (request_id, session_id, workspace_id, admin_user_id, intent_hash, status,
          response_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("request-graph", "session-graph", "ws", "admin", "intent", "succeeded", JSON.stringify({ status: 200, body: { ok: true, results: [result] } }), at, at);
    db.prepare(
      `INSERT INTO audit_events
         (id, workspace_id, admin_user_id, session_id, action_name, risk_json, receipt_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("audit-graph", "ws", "admin", "session-graph", receipt.action, "[]", JSON.stringify(receipt), at);

    migrate(db);

    expect(db.prepare("SELECT id FROM action_results ORDER BY id").all()).toEqual([{ id: "result-graph" }]);
    expect(db.prepare("SELECT action_result_id FROM operation_runs WHERE id = 'operation-graph'").get()).toEqual({ action_result_id: "result-graph" });
    expect(db.prepare("SELECT action_result_id FROM chat_message_result_links WHERE message_id = 'message-graph'").get()).toEqual({ action_result_id: "result-graph" });
    expect(db.prepare("SELECT action_result_id FROM turn_run_result_links WHERE request_id = 'request-graph'").get()).toEqual({ action_result_id: "result-graph" });
    expect(db.prepare("SELECT action_result_id FROM audit_events WHERE id = 'audit-graph'").get()).toEqual({ action_result_id: "result-graph" });
    db.close();
  });

  it("keeps full result JSON only in action_results and adds ordered durable result links", () => {
    const db = new Database(":memory:");
    migrate(db);

    const tablesWithResultJson = (db
      .prepare(
        `SELECT m.name AS table_name, p.name AS column_name
           FROM sqlite_master m
           JOIN pragma_table_info(m.name) p
          WHERE m.type = 'table' AND p.name = 'result_json'
          ORDER BY m.name`,
      )
      .all() as Array<{ table_name: string }>).map((row) => row.table_name);
    expect(tablesWithResultJson).toEqual(["action_results"]);

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
    expect(tables).toEqual(expect.arrayContaining(["turn_run_result_links", "chat_message_result_links"]));
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it("enforces the one-megabyte artifact limit in SQLite and reruns safely", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    expect(() =>
      db.prepare(
        `INSERT INTO artifacts (
           id, workspace_id, admin_user_id, session_id, content_type, filename,
           bytes, checksum, created_at, expires_at
         ) VALUES ('too-big', 'w', 'a', 's', 'x', 'x', ?, 'x', '2026-01-01', '2026-01-02')`,
      ).run(Buffer.alloc(1_000_001)),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });
});

describe("schema v5 durable mutation substrate", () => {
  it("adds durable normalized operation and reconciliation columns and reruns safely", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(() => migrate(db)).not.toThrow();

    const operationColumns = (db.prepare("PRAGMA table_info(operation_runs)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    expect(operationColumns).toEqual(expect.arrayContaining([
      "operation_json",
      "reconciled_at",
      "reconciliation_json",
      "capability_hash",
    ]));

    const stepColumns = (db.prepare("PRAGMA table_info(operation_steps)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    expect(stepColumns).toEqual(expect.arrayContaining([
      "plan_step_id",
      "kind",
      "effect_json",
      "dispatched_at",
      "settled_at",
      "compensates_step_id",
    ]));
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it("preserves legacy operation rows with a valid empty normalized intent", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.pragma("foreign_keys = OFF");
    db.exec(`
      DROP INDEX IF EXISTS idx_operation_steps_operation;
      ALTER TABLE operation_steps RENAME TO operation_steps_v5_fixture;
      CREATE TABLE operation_steps (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        external_id TEXT,
        fingerprint TEXT,
        detail_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (operation_id, step_index),
        FOREIGN KEY (operation_id) REFERENCES operation_runs(id)
      );
      DROP TABLE operation_steps_v5_fixture;
      ALTER TABLE operation_runs RENAME TO operation_runs_v5_fixture;
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
        status TEXT NOT NULL,
        action_result_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      DROP TABLE operation_runs_v5_fixture;
    `);
    db.pragma("user_version = 4");
    db.exec(`
      INSERT INTO operation_runs (
        id, request_id, confirmation_id, session_id, workspace_id, admin_user_id,
        action_name, action_fingerprint, catalog_hash, operation_hash, status,
        action_result_id, created_at, updated_at
      ) VALUES (
        'legacy-operation', NULL, NULL, 'session', 'workspace', 'admin',
        'clockify_tags_create', 'action', 'catalog', 'operation', 'prepared',
        NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO operation_steps (
        id, operation_id, step_index, name, status, external_id, fingerprint,
        detail_json, created_at, updated_at
      ) VALUES (
        'legacy-step', 'legacy-operation', 0, 'create-tag', 'succeeded',
        'tag-legacy', 'target-legacy', '{"legacy":true}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'
      );
      INSERT INTO operation_steps (
        id, operation_id, step_index, name, status, external_id, fingerprint,
        detail_json, created_at, updated_at
      ) VALUES (
        'legacy-step-2', 'legacy-operation', 1, 'create-tag', 'prepared',
        NULL, NULL, NULL,
        '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z'
      );
    `);
    db.pragma("foreign_keys = ON");

    migrate(db);
    migrate(db);

    const row = db.prepare(
      "SELECT operation_json, reconciled_at, reconciliation_json, capability_hash FROM operation_runs WHERE id = ?",
    ).get("legacy-operation") as Record<string, unknown>;
    expect(JSON.parse(row.operation_json as string)).toEqual({});
    expect(row).toMatchObject({ reconciled_at: null, reconciliation_json: null, capability_hash: null });
    expect(db.prepare(
      `SELECT plan_step_id, kind, status, external_id, target_fingerprint,
              effect_json, detail_json, dispatched_at, settled_at
         FROM operation_steps WHERE id = 'legacy-step'`,
    ).get()).toEqual({
      plan_step_id: "create-tag:0",
      kind: "primary",
      status: "succeeded",
      external_id: "tag-legacy",
      target_fingerprint: "target-legacy",
      effect_json: null,
      detail_json: '{"legacy":true}',
      dispatched_at: "2026-01-01T00:00:01.000Z",
      settled_at: "2026-01-01T00:00:01.000Z",
    });
    expect(db.prepare(
      "SELECT plan_step_id, status FROM operation_steps WHERE id = 'legacy-step-2'",
    ).get()).toEqual({ plan_step_id: "create-tag:1", status: "prepared" });
    db.close();
  });
});

describe("schema v6 persisted intent capabilities", () => {
  it("adds bounded immutable capability records, usage claims, and durable bindings", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(() => migrate(db)).not.toThrow();

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
    expect(tables).toEqual(expect.arrayContaining(["intent_capabilities", "intent_capability_usage"]));

    const operationColumns = (db.prepare("PRAGMA table_info(operation_runs)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    const confirmationColumns = (db.prepare("PRAGMA table_info(pending_confirmations)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    expect(operationColumns).toEqual(expect.arrayContaining(["capability_id", "capability_hash"]));
    expect(confirmationColumns).toEqual(expect.arrayContaining(["capability_id", "capability_hash"]));

    const capabilityJson = JSON.stringify({
      version: 1,
      mode: "deny_all_writes",
      requestHash: "r".repeat(64),
      catalogHash: "catalog-hash",
      reason: "provider_unavailable",
      writeActions: [],
    });
    db.prepare(
      `INSERT INTO intent_capabilities (
         id, workspace_id, admin_user_id, session_id, request_id, request_hash,
         catalog_hash, capability_hash, mode, capability_json, created_at
       ) VALUES ('capability', 'workspace', 'admin', 'session', 'request',
                 '${"r".repeat(64)}', 'catalog-hash', '${"c".repeat(64)}',
                 'deny_all_writes', ?, '2026-01-01T00:00:00.000Z')`,
    ).run(capabilityJson);
    expect(() => db.prepare(
      "UPDATE intent_capabilities SET catalog_hash = 'changed' WHERE id = 'capability'",
    ).run()).toThrow("intent_capability_immutable");
    expect(() => db.prepare(
      `INSERT INTO intent_capabilities (
         id, workspace_id, admin_user_id, session_id, request_id, request_hash,
         catalog_hash, capability_hash, mode, capability_json, created_at
       ) VALUES ('invalid-json', 'w', 'a', 's', 'r', 'rh', 'ch', 'hh',
                 'allow', '{', '2026-01-01T00:00:00.000Z')`,
    ).run()).toThrow(/CHECK constraint failed/);
    expect(() => db.prepare(
      `INSERT INTO intent_capabilities (
         id, workspace_id, admin_user_id, session_id, request_id, request_hash,
         catalog_hash, capability_hash, mode, capability_json, created_at
       ) VALUES ('too-large', 'w', 'a', 's', 'large', 'rh', 'ch', 'hh2',
                 'allow', ?, '2026-01-01T00:00:00.000Z')`,
    ).run(JSON.stringify({ value: "x".repeat(65_536) }))).toThrow(/CHECK constraint failed/);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it("migrates a checked v5 fixture twice and leaves legacy operation/confirmation bindings incompatible", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.exec(`
      DROP TRIGGER intent_capabilities_immutable;
      DROP TABLE intent_capability_usage;
      DROP TABLE intent_capabilities;
      DROP INDEX idx_pending_confirmations_capability;
      DROP INDEX idx_operation_runs_capability;
      ALTER TABLE pending_confirmations DROP COLUMN capability_hash;
      ALTER TABLE pending_confirmations DROP COLUMN capability_id;
      ALTER TABLE operation_runs DROP COLUMN capability_id;
      PRAGMA user_version = 5;
    `);
    db.prepare(
      `INSERT INTO operation_runs (
         id, request_id, confirmation_id, session_id, workspace_id, admin_user_id,
         action_name, action_fingerprint, catalog_hash, operation_hash, status,
         action_result_id, operation_json, reconciled_at, reconciliation_json,
         capability_hash, created_at, updated_at
       ) VALUES (
         'legacy-operation', 'legacy-request', NULL, 'legacy-session', 'legacy-workspace',
         'legacy-admin', 'clockify_clients_create', 'action-hash', 'catalog-hash',
         'operation-hash', 'prepared', NULL, '{}', NULL, NULL, NULL,
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
       )`,
    ).run();

    migrate(db);
    expect(() => migrate(db)).not.toThrow();

    expect(db.prepare(
      "SELECT capability_id, capability_hash FROM operation_runs WHERE id = 'legacy-operation'",
    ).get()).toEqual({ capability_id: null, capability_hash: null });
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });
});

describe("schema v8 lifecycle lineage", () => {
  it("upgrades a v7 database with the bounded hashed-workspace watermark table", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.exec("DROP TABLE lifecycle_authority_watermarks; PRAGMA user_version = 7;");

    migrate(db);

    expect(db.pragma("user_version", { simple: true })).toBe(8);
    const columns = (db.pragma("table_info(lifecycle_authority_watermarks)") as Array<{ name: string }>)
      .map(({ name }) => name);
    expect(columns).toEqual([
      "workspace_fingerprint_sha256",
      "lifecycle_issued_at",
      "authority_state",
      "installation_generation",
      "recorded_at",
      "expires_at",
    ]);
    db.close();
  });
});

describe("schema v7 retention evidence and scrub constraints", () => {
  it("adds bounded retention evidence and enforces expired-payload scrubbing", () => {
    const db = new Database(":memory:");
    migrate(db);

    expect(() => db.prepare(
      `INSERT INTO retention_runs (
         id, recorded_at, duration_ms, deleted_count, expired_count, batches,
         backlog, wal_busy, wal_log, wal_checkpointed, counts_json
       ) VALUES ('bad', '2026-01-01T00:00:00.000Z', -1, 0, 0, 0, 0, 0, 0, 0, '{}')`,
    ).run()).toThrow(/CHECK constraint failed/);

    db.prepare(
      `INSERT INTO chat_sessions
         (id, workspace_id, admin_user_id, created_at, last_seen_at, expires_at)
       VALUES ('session-v7', 'ws', 'admin', '2026-01-01T00:00:00.000Z',
               '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z')`,
    ).run();
    expect(() => db.prepare(
      `INSERT INTO pending_confirmations (
         id, operation_id, session_id, workspace_id, admin_user_id, status,
         risk_json, preview_json, operation_json, operation_hash,
         target_fingerprints_json, action_fingerprint, catalog_hash, nonce_hash,
         expires_at, created_at, agent_state_json
       ) VALUES ('confirmation-v7-expired-insert', 'operation-v7-expired-insert',
                 'session-v7', 'ws', 'admin', 'expired', '["destructive"]',
                 '{"secret":true}', '{"payload":true}', 'hash', '["fingerprint"]',
                 'action', 'catalog', 'nonce', '2026-01-01T00:00:00.000Z',
                 '2026-01-01T00:00:00.000Z', '{"resume":true}')`,
    ).run()).toThrow(/expired_confirmation_not_scrubbed/);
    db.prepare(
      `INSERT INTO pending_confirmations (
         id, operation_id, session_id, workspace_id, admin_user_id, status,
         risk_json, preview_json, operation_json, operation_hash,
         target_fingerprints_json, action_fingerprint, catalog_hash, nonce_hash,
         expires_at, created_at
       ) VALUES ('confirmation-v7', 'operation-v7', 'session-v7', 'ws', 'admin',
                 'pending', '["destructive"]', '{"secret":true}', '{}', 'hash',
                 '["fingerprint"]', 'action', 'catalog',
                 'nonce', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    expect(() => db.prepare(
      "UPDATE pending_confirmations SET status = 'expired' WHERE id = 'confirmation-v7'",
    ).run()).toThrow(/expired_confirmation_not_scrubbed/);
    expect(() => db.prepare(
      `UPDATE pending_confirmations
          SET status = 'expired', nonce_hash = '', operation_json = NULL,
              agent_state_json = NULL
        WHERE id = 'confirmation-v7'`,
    ).run()).toThrow(/expired_confirmation_not_scrubbed/);

    expect(() => db.prepare(
      `INSERT INTO undo_records (
         id, session_id, workspace_id, admin_user_id, action_name, reversal_json,
         remaining_json, status, created_at, expires_at
       ) VALUES ('undo-v7-expired-insert', 'session-v7', 'ws', 'admin', 'x',
                 '[{"id":"secret"}]', '[{"id":"secret"}]', 'expired',
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:30:00.000Z')`,
    ).run()).toThrow(/expired_undo_not_scrubbed/);
    db.prepare(
      `INSERT INTO undo_records (
         id, session_id, workspace_id, admin_user_id, action_name, reversal_json,
         remaining_json, status, created_at, expires_at
       ) VALUES ('undo-v7', 'session-v7', 'ws', 'admin', 'x', '[{"id":"secret"}]',
                 '[{"id":"secret"}]', 'available', '2026-01-01T00:00:00.000Z',
                 '2026-01-01T00:30:00.000Z')`,
    ).run();
    expect(() => db.prepare(
      "UPDATE undo_records SET status = 'expired' WHERE id = 'undo-v7'",
    ).run()).toThrow(/expired_undo_not_scrubbed/);
    db.close();
  });

  it("scrubs already-expired v6 confirmation and undo payloads during migration", () => {
    const fixturePath = fileURLToPath(new URL("../fixtures/db/schema-v6.sql", import.meta.url));
    const db = new Database(":memory:");
    db.exec(readFileSync(fixturePath, "utf8"));
    db.prepare(
      `INSERT INTO chat_sessions
         (id, workspace_id, admin_user_id, created_at, last_seen_at, expires_at)
       VALUES ('session-v6-expired', 'ws', 'admin', '2026-01-01T00:00:00.000Z',
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO pending_confirmations (
         id, operation_id, session_id, workspace_id, admin_user_id, status,
         risk_json, preview_json, operation_json, operation_hash,
         target_fingerprints_json, action_fingerprint, catalog_hash, nonce_hash,
         expires_at, created_at, agent_state_json
       ) VALUES ('confirmation-v6-expired', 'operation-v6-expired', 'session-v6-expired',
                 'ws', 'admin', 'expired', '["destructive"]', '{"secret":true}',
                 '{"secret":true}', 'hash', '["fingerprint"]', 'action', 'catalog',
                 'nonce', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
                 '{"secret":true}')`,
    ).run();
    db.prepare(
      `INSERT INTO undo_records (
         id, session_id, workspace_id, admin_user_id, action_name, reversal_json,
         remaining_json, status, created_at, expires_at
       ) VALUES ('undo-v6-expired', 'session-v6-expired', 'ws', 'admin', 'x',
                 '[{"id":"secret"}]', '[{"id":"secret"}]', 'expired',
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:30:00.000Z')`,
    ).run();

    migrate(db);

    expect(db.prepare(
      `SELECT risk_json, preview_json, operation_json, target_fingerprints_json,
              nonce_hash, agent_state_json
         FROM pending_confirmations WHERE id = 'confirmation-v6-expired'`,
    ).get()).toEqual({
      risk_json: "[]",
      preview_json: "{}",
      operation_json: null,
      target_fingerprints_json: "[]",
      nonce_hash: "",
      agent_state_json: null,
    });
    expect(db.prepare(
      "SELECT reversal_json, remaining_json FROM undo_records WHERE id = 'undo-v6-expired'",
    ).get()).toEqual({ reversal_json: "[]", remaining_json: "[]" });
    db.close();
  });
});

describe("checked historical schema fixtures", () => {
  for (let version = 0; version <= LATEST_SCHEMA_VERSION; version += 1) {
    it(`migrates schema-v${version} twice`, () => {
      const path = fileURLToPath(new URL(`../fixtures/db/schema-v${version}.sql`, import.meta.url));
      const db = new Database(":memory:");
      db.exec(readFileSync(path, "utf8"));
      expect(db.pragma("user_version", { simple: true })).toBe(version);

      migrate(db);
      migrate(db);

      expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
      expect(db.prepare("PRAGMA integrity_check").pluck().get()).toBe("ok");
      expect(db.prepare("SELECT COUNT(*) FROM retention_runs").pluck().get()).toBeTypeOf("number");
      const confirmationColumns = db.prepare("PRAGMA table_info(pending_confirmations)").all() as Array<{ name: string }>;
      const undoColumns = db.prepare("PRAGMA table_info(undo_records)").all() as Array<{ name: string }>;
      expect(confirmationColumns.map((column) => column.name)).toContain("installation_generation");
      expect(undoColumns.map((column) => column.name)).toContain("installation_generation");
      db.close();
    });
  }
});
