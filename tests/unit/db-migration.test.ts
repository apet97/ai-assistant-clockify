import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
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
  it("relaxes receipt_json to NULLABLE, adds claimed_at, and preserves existing completed rows", () => {
    const db = new Database(":memory:");
    oldSchema(db);
    db.prepare(
      "INSERT INTO idempotency_keys (key, receipt_json, committed_at) VALUES (?, ?, ?)",
    ).run("legacy", JSON.stringify({ ok: true, action: "x" }), 1_000);
    expect(receiptNotNull(db)).toBe(true); // precondition: old shape

    expect(() => migrate(db)).not.toThrow();

    // receipt_json is now nullable: a NULL-receipt CLAIM insert succeeds.
    expect(receiptNotNull(db)).toBe(false);
    expect(() =>
      db
        .prepare("INSERT INTO idempotency_keys (key, receipt_json, committed_at, claimed_at) VALUES (?, NULL, NULL, ?)")
        .run("claim", 2_000),
    ).not.toThrow();

    // claimed_at column exists.
    const cols = db.prepare("PRAGMA table_info(idempotency_keys)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "claimed_at")).toBe(true);

    // The pre-existing completed row survived the rebuild unchanged.
    const legacy = db
      .prepare("SELECT receipt_json, committed_at FROM idempotency_keys WHERE key = ?")
      .get("legacy") as { receipt_json: string; committed_at: number };
    expect(JSON.parse(legacy.receipt_json).action).toBe("x");
    expect(legacy.committed_at).toBe(1_000);
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

    // The scratch table is gone, the rebuild completed, the data survived.
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).not.toContain("idempotency_keys_new");
    expect(receiptNotNull(db)).toBe(false);
    const legacy = db.prepare("SELECT receipt_json FROM idempotency_keys WHERE key = ?").get("legacy") as
      | { receipt_json: string }
      | undefined;
    expect(legacy && JSON.parse(legacy.receipt_json).action).toBe("x");
    db.close();
  });

  it("is a no-op on an already-migrated (new-schema) DB", () => {
    const db = new Database(":memory:");
    migrate(db); // fresh install gets the nullable schema directly
    expect(receiptNotNull(db)).toBe(false);
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
      remaining_json: reversal,
      expires_at: "2025-01-01T00:00:00.000Z",
    });
    expect(db.prepare("SELECT receipt_json FROM idempotency_keys WHERE key = ?").get("legacy-key")).toEqual({
      receipt_json: '{"ok":true,"action":"clockify_tags_create"}',
    });
    db.close();
  });
});
