import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/schema.js";

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
