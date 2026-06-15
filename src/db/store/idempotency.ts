import type { ClaimState } from "../../harness/action.js";
import type { SuccessReceipt } from "../../harness/receipts.js";
import type { StoreContext } from "./context.js";

/**
 * Idempotency concern (Phase 5 + the r1-concurrency-races-01 atomic-claim
 * ledger). The atomic-claim transaction's semantics are invariant-dense — the
 * whole `db.transaction` is moved here VERBATIM (sweep-then-race, the
 * crash-before-fill `stale_unknown` discriminator, and the NULL-receipt guards).
 */
export function buildIdempotencyStore(ctx: StoreContext): {
  recordIdempotency(key: string, receipt: SuccessReceipt, committedAtEpochMs: number): void;
  lookupIdempotency(key: string, notBeforeEpochMs: number): SuccessReceipt | undefined;
  claimIdempotency(
    key: string,
    claimedAtEpochMs: number,
    completedNotBeforeEpochMs: number,
    claimNotBeforeEpochMs: number,
  ): ClaimState;
  claimIdempotencyReceipt(key: string): SuccessReceipt | undefined;
  fillIdempotency(key: string, receipt: SuccessReceipt, committedAtEpochMs: number): void;
  releaseIdempotency(key: string): void;
  touchIdempotencyClaim(key: string, claimedAtEpochMs: number): void;
} {
  const { db } = ctx;
  return {
    recordIdempotency(key, receipt, committedAtEpochMs) {
      // Legacy/best-effort path (non-atomic ledger). Stamp claimed_at too so the
      // row is prune-able by BOTH prune arms.
      db.prepare(
        `INSERT INTO idempotency_keys (key, receipt_json, committed_at, claimed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET receipt_json = excluded.receipt_json, committed_at = excluded.committed_at, claimed_at = excluded.claimed_at`,
      ).run(key, JSON.stringify(receipt), committedAtEpochMs, committedAtEpochMs);
    },

    lookupIdempotency(key, notBeforeEpochMs) {
      // `receipt_json IS NOT NULL` so an in-flight CLAIM is never returned as a
      // completed receipt (it also can't JSON.parse).
      const row = db
        .prepare(
          "SELECT receipt_json FROM idempotency_keys WHERE key = ? AND committed_at >= ? AND receipt_json IS NOT NULL",
        )
        .get(key, notBeforeEpochMs) as { receipt_json: string } | undefined;
      return row ? (JSON.parse(row.receipt_json) as SuccessReceipt) : undefined;
    },

    claimIdempotency(key, claimedAtEpochMs, completedNotBeforeEpochMs, claimNotBeforeEpochMs) {
      // ONE synchronous transaction (better-sqlite3 is sync, so no JS
      // interleaving): sweep a row that is OUT of the dedup window, then race the
      // INSERT. ON CONFLICT DO NOTHING gives changes===1 to exactly one winner.
      //
      // crash-before-fill residual: a NULL-receipt claim is swept ONLY once it is
      // older than the dedup window (completedNotBefore), NOT at CLAIM_TTL. A claim
      // orphaned by a crash between the host write and `fill` is therefore retained
      // for the whole window, so a re-claim returns `stale_unknown` (below) instead
      // of silently re-winning and double-committing a money write whose outcome is
      // unknown. (Sweeping it at CLAIM_TTL was the silent-duplicate window.)
      return db.transaction((): ClaimState => {
        db.prepare(
          `DELETE FROM idempotency_keys
             WHERE key = ?
               AND ((receipt_json IS NOT NULL AND committed_at < ?)
                 OR (receipt_json IS NULL AND claimed_at < ?))`,
        ).run(key, completedNotBeforeEpochMs, completedNotBeforeEpochMs);
        const ins = db
          .prepare(
            `INSERT INTO idempotency_keys (key, receipt_json, committed_at, claimed_at)
               VALUES (?, NULL, NULL, ?) ON CONFLICT(key) DO NOTHING`,
          )
          .run(key, claimedAtEpochMs);
        if (ins.changes === 1) return "won";
        const row = db
          .prepare("SELECT receipt_json, claimed_at FROM idempotency_keys WHERE key = ?")
          .get(key) as { receipt_json: string | null; claimed_at: number } | undefined;
        // The row vanished mid-transaction (a concurrent release won the row):
        // the key is free again, so report a fresh win — the caller commits.
        if (!row) return "won";
        if (row.receipt_json !== null) return "replay";
        // NULL receipt = an UNcompleted claim still inside the dedup window. A LIVE
        // commit heartbeats, so claimed_at stays >= claimNotBefore → a genuine
        // concurrent in-flight claim. A claim NOT refreshed within CLAIM_TTL means
        // its process died mid-commit: the host-side outcome is unknown, so report
        // `stale_unknown` — the caller must not re-commit (crash-before-fill).
        return row.claimed_at < claimNotBeforeEpochMs ? "stale_unknown" : "in_flight";
      })();
    },

    claimIdempotencyReceipt(key) {
      const row = db
        .prepare("SELECT receipt_json FROM idempotency_keys WHERE key = ? AND receipt_json IS NOT NULL")
        .get(key) as { receipt_json: string } | undefined;
      return row ? (JSON.parse(row.receipt_json) as SuccessReceipt) : undefined;
    },

    fillIdempotency(key, receipt, committedAtEpochMs) {
      // Guarded on receipt_json IS NULL: fills only the OWN (still-claimed) row;
      // a re-fill or a fill of an already-completed row no-ops.
      db.prepare(
        "UPDATE idempotency_keys SET receipt_json = ?, committed_at = ? WHERE key = ? AND receipt_json IS NULL",
      ).run(JSON.stringify(receipt), committedAtEpochMs, key);
    },

    releaseIdempotency(key) {
      // Guarded on receipt_json IS NULL: a release can NEVER drop a COMPLETED row.
      db.prepare("DELETE FROM idempotency_keys WHERE key = ? AND receipt_json IS NULL").run(key);
    },

    touchIdempotencyClaim(key, claimedAtEpochMs) {
      // Guarded on receipt_json IS NULL: only refreshes a still-in-flight claim.
      // A completed (filled) row is never disturbed; a missing key no-ops.
      db.prepare(
        "UPDATE idempotency_keys SET claimed_at = ? WHERE key = ? AND receipt_json IS NULL",
      ).run(claimedAtEpochMs, key);
    },
  };
}
