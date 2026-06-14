import { afterEach, describe, expect, it } from "vitest";
import { createStore, CLAIM_TTL_MS, type Store } from "../../src/db/store.js";
import { CLAIM_HEARTBEAT_MS } from "../../src/harness/actions.js";
import type { SuccessReceipt } from "../../src/harness/receipts.js";

const receipt: SuccessReceipt = { ok: true, action: "clockify_invoices_create", entity: "invoice" };

let store: Store | undefined;
afterEach(() => store?.close());

describe("store idempotency ledger", () => {
  it("returns a recorded receipt only within the window", () => {
    store = createStore(":memory:");
    const T = 1_000_000;
    store.recordIdempotency("k1", receipt, T);

    // committed at T; a lookup whose window starts at or before T finds it
    expect(store.lookupIdempotency("k1", T)?.action).toBe("clockify_invoices_create");
    expect(store.lookupIdempotency("k1", T - 5_000)).toBeDefined();
    // a window that starts AFTER T (older than the window) misses it
    expect(store.lookupIdempotency("k1", T + 1)).toBeUndefined();
    // an unknown key misses
    expect(store.lookupIdempotency("nope", 0)).toBeUndefined();
  });

  it("upserts: re-recording the same key refreshes its timestamp", () => {
    store = createStore(":memory:");
    store.recordIdempotency("k2", receipt, 1_000);
    expect(store.lookupIdempotency("k2", 2_000)).toBeUndefined(); // stale at the later window
    store.recordIdempotency("k2", receipt, 3_000); // refreshed
    expect(store.lookupIdempotency("k2", 2_000)).toBeDefined();
  });
});

/**
 * Atomic-claim ledger (r1-concurrency-races-01). The cross-row dedup must be the
 * SERIALIZATION point: two concurrent confirms of one semantic intent must not
 * both reach the host. A claim is taken BEFORE the commit await; the winner
 * fills (on ok) or releases (on failure); the loser reads the row's three-state
 * machine (COMPLETED ⇒ replay, still-CLAIMED ⇒ in_flight, GONE ⇒ re-claim).
 */
describe("store atomic idempotency claim", () => {
  const T = 1_000_000;
  // completedNotBefore: T (everything written at >= T is in-window); claimNotBefore:
  // T - 1 (a claim stamped at T is still LIVE, never swept) unless overridden.
  const claim = (key: string, claimedAt = T, completedNotBefore = T, claimNotBefore = T - 1) =>
    store!.claimIdempotency(key, claimedAt, completedNotBefore, claimNotBefore);

  it("three-state machine: won → in_flight → replay → (release) → won", () => {
    store = createStore(":memory:");
    // First claim wins; the row is CLAIMED (receipt NULL).
    expect(claim("k")).toBe("won");
    // A concurrent claim while the winner is in flight sees the live claim.
    expect(claim("k")).toBe("in_flight");
    // lookupIdempotency must NOT return an in-flight claim as a completed receipt.
    expect(store.lookupIdempotency("k", T)).toBeUndefined();
    // The winner fills the claim with its receipt.
    store.fillIdempotency("k", receipt, T);
    // Now a same-key claim within window is a replay, and the receipt is readable.
    expect(claim("k")).toBe("replay");
    expect(store.claimIdempotencyReceipt("k")?.action).toBe("clockify_invoices_create");
    expect(store.lookupIdempotency("k", T)?.action).toBe("clockify_invoices_create");
  });

  it("release frees a still-NULL claim so a fresh claim wins again (failed-commit retry)", () => {
    store = createStore(":memory:");
    expect(claim("k")).toBe("won");
    store.releaseIdempotency("k"); // winner's commit failed → release the claim
    expect(claim("k")).toBe("won"); // a legitimate retry re-claims and commits for real
  });

  it("release can NEVER drop a COMPLETED row (guarded on receipt_json IS NULL)", () => {
    store = createStore(":memory:");
    expect(claim("k")).toBe("won");
    store.fillIdempotency("k", receipt, T);
    store.releaseIdempotency("k"); // stray release after fill must be a no-op
    expect(store.claimIdempotencyReceipt("k")?.action).toBe("clockify_invoices_create");
  });

  it("STALE-ROW RECLAIM: an out-of-window COMPLETED row is swept, not treated as a blocking conflict", () => {
    store = createStore(":memory:");
    // A completed row at T.
    store.recordIdempotency("k", receipt, T);
    expect(store.claimIdempotencyReceipt("k")?.action).toBe("clockify_invoices_create");
    // Claim with completedNotBefore = T + 1 → the row at T is now OUT of window.
    // The claim's stale-sweep deletes it and the fresh claim wins.
    expect(claim("k", T + 100, T + 1)).toBe("won");
    // The new claim row is a NULL-receipt CLAIM, not the stale completed receipt.
    expect(store.claimIdempotencyReceipt("k")).toBeUndefined();
  });

  it("STALE-ROW RECLAIM: an IN-window COMPLETED row is NOT swept (it dedupes)", () => {
    store = createStore(":memory:");
    store.recordIdempotency("k", receipt, T);
    // Claim with completedNotBefore = T (the row at T is IN window) → replay, not won.
    expect(claim("k", T + 100, T)).toBe("replay");
  });

  it("DEAD-CLAIM SWEEP: a claim older than CLAIM_TTL is swept and re-claimed; a LIVE claim is never swept", () => {
    store = createStore(":memory:");
    // A dangling crashed CLAIM stamped at T0.
    const T0 = T;
    expect(claim("dead", T0)).toBe("won"); // writes a NULL-receipt claim at T0
    // A later same-key claim whose claimNotBefore is AFTER T0 sweeps the dead claim.
    expect(claim("dead", T0 + 100, T, T0 + 1)).toBe("won");

    // A LIVE claim (claimNotBefore strictly before the claim's stamp) is never swept.
    expect(claim("live", T0)).toBe("won");
    expect(claim("live", T0 + 100, T, T0 - 1)).toBe("in_flight");
  });

  it("CLAIM_TTL_MS is strictly above the commit-timeout ceiling so a live claim is provably not swept", async () => {
    const { COMMIT_TIMEOUT_MS } = await import("../../src/clockify/rest/core.js");
    expect(CLAIM_TTL_MS).toBeGreaterThan(COMMIT_TIMEOUT_MS);
  });
});

describe("claim heartbeat keeps a long multi-call commit's claim from being swept (touchIdempotencyClaim)", () => {
  // A single createInvoice commit issues POST+GET+PUT+tax+N item POSTs; their
  // summed latency can exceed CLAIM_TTL_MS (only the per-call timeout bounds
  // each). Without a heartbeat, a re-confirm past CLAIM_TTL would sweep the
  // still-LIVE claim and double-commit. The heartbeat refreshes claimed_at.
  const T = 1_000_000;
  const WINDOW = 10 * 60 * 1000;
  const claim = (key: string, claimedAt: number, claimNotBefore: number) =>
    store!.claimIdempotency(key, claimedAt, T - WINDOW, claimNotBefore);

  it("CLAIM_HEARTBEAT_MS refreshes well before CLAIM_TTL_MS (margin for a delayed beat)", () => {
    expect(CLAIM_HEARTBEAT_MS).toBeLessThan(CLAIM_TTL_MS);
    expect(CLAIM_HEARTBEAT_MS * 2).toBeLessThan(CLAIM_TTL_MS);
  });

  it("a HEARTBEATED claim is NOT swept past CLAIM_TTL_MS — a re-confirm sees in_flight, never a duplicate", () => {
    store = createStore(":memory:");
    expect(claim("hb", T, T - 1)).toBe("won"); // long commit wins the claim at T0
    // It heartbeats partway through (within CLAIM_TTL), refreshing claimed_at.
    store.touchIdempotencyClaim("hb", T + CLAIM_TTL_MS - 60_000);
    // A re-confirm AFTER T0 + CLAIM_TTL_MS: the refreshed claim is still LIVE.
    const reconfirmAt = T + CLAIM_TTL_MS + 10_000;
    expect(claim("hb", reconfirmAt, reconfirmAt - CLAIM_TTL_MS)).toBe("in_flight");
  });

  it("WITHOUT a heartbeat the same in-flight claim WOULD be swept (the duplicate-invoice bug the heartbeat closes)", () => {
    store = createStore(":memory:");
    expect(claim("nohb", T, T - 1)).toBe("won");
    // No touch: the re-confirm past CLAIM_TTL sweeps the stale claim and RE-WINS →
    // a second host commit (the confirmed duplicate-invoice path).
    const reconfirmAt = T + CLAIM_TTL_MS + 10_000;
    expect(claim("nohb", reconfirmAt, reconfirmAt - CLAIM_TTL_MS)).toBe("won");
  });

  it("touchIdempotencyClaim never disturbs a COMPLETED row (guarded on receipt_json IS NULL)", () => {
    store = createStore(":memory:");
    expect(claim("done", T, T - 1)).toBe("won");
    store.fillIdempotency("done", receipt, T);
    store.touchIdempotencyClaim("done", T + 999_999); // no-op on a filled row
    expect(store.claimIdempotencyReceipt("done")?.action).toBe("clockify_invoices_create");
    expect(claim("done", T + 1, T)).toBe("replay"); // still a normal completed replay
  });
});

describe("store pruneExpired backstop for crashed claims", () => {
  const NOW = new Date("2026-06-06T00:00:00.000Z");
  it("sweeps orphaned NULL-receipt claims past CLAIM_TTL but keeps a live one", () => {
    store = createStore(":memory:", { now: () => NOW });
    const nowMs = NOW.getTime();
    // A crashed claim, stamped well past CLAIM_TTL (committed_at NULL — the old
    // committed_at-only prune NEVER matched these, proven by execution).
    store.claimIdempotency("crashed", nowMs - CLAIM_TTL_MS - 1, nowMs, nowMs - CLAIM_TTL_MS);
    // A live claim, stamped recently.
    store.claimIdempotency("live", nowMs - 1_000, nowMs, nowMs - CLAIM_TTL_MS);

    const counts = store.pruneExpired(NOW.toISOString());
    expect(counts.idempotencyKeys).toBe(1); // only the crashed claim
    expect(store.claimIdempotency("crashed", nowMs, nowMs, nowMs - CLAIM_TTL_MS)).toBe("won"); // gone → re-claimable
    expect(store.claimIdempotency("live", nowMs, nowMs, nowMs - CLAIM_TTL_MS)).toBe("in_flight"); // kept
  });
});
