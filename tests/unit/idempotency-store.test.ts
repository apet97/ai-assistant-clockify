import { afterEach, describe, expect, it } from "vitest";
import { createStore, CLAIM_TTL_MS, IDEMPOTENCY_RETENTION_MS, type Store } from "../../src/db/store.js";
import { CLAIM_HEARTBEAT_MS } from "../../src/harness/actions.js";
import type { SuccessReceipt } from "../../src/harness/receipts.js";
import { createPendingConfirmation } from "../../src/harness/confirmations.js";

const receipt: SuccessReceipt = { ok: true, action: "clockify_invoices_create", entity: "invoice" };
const WS = "ws-1";
const ADMIN = "admin-1";

let store: Store | undefined;
afterEach(() => store?.close());

const resultRef = (target: Store, value = receipt) => target.recordActionResult({
  workspaceId: WS,
  adminUserId: ADMIN,
  actionName: value.action,
  status: "succeeded",
  result: { kind: "receipt", receipt: value },
});

const record = (target: Store, key: string, committedAt: number, workspaceId = WS, adminUserId = ADMIN): void => {
  target.recordIdempotency(key, workspaceId, adminUserId, resultRef(target), committedAt);
};

describe("store idempotency ledger", () => {
  it("returns a recorded receipt only within the window", () => {
    store = createStore(":memory:");
    const T = 1_000_000;
    record(store, "k1", T);

    // committed at T; a lookup whose window starts at or before T finds it
    expect(store.lookupIdempotency("k1", WS, ADMIN, T)?.action).toBe("clockify_invoices_create");
    expect(store.lookupIdempotency("k1", WS, ADMIN, T - 5_000)).toBeDefined();
    // a window that starts AFTER T (older than the window) misses it
    expect(store.lookupIdempotency("k1", WS, ADMIN, T + 1)).toBeUndefined();
    // an unknown key misses
    expect(store.lookupIdempotency("nope", WS, ADMIN, 0)).toBeUndefined();
  });

  it("upserts: re-recording the same key refreshes its timestamp", () => {
    store = createStore(":memory:");
    record(store, "k2", 1_000);
    expect(store.lookupIdempotency("k2", WS, ADMIN, 2_000)).toBeUndefined(); // stale at the later window
    record(store, "k2", 3_000); // refreshed
    expect(store.lookupIdempotency("k2", WS, ADMIN, 2_000)).toBeDefined();
  });

  it("isolates identical keys across workspace and admin scopes", () => {
    store = createStore(":memory:");
    record(store, "same", 1_000, WS, ADMIN);
    record(store, "same", 2_000, "ws-2", ADMIN);
    record(store, "same", 3_000, WS, "admin-2");

    expect(store.lookupIdempotency("same", WS, ADMIN, 0)).toBeDefined();
    expect(store.lookupIdempotency("same", "ws-2", ADMIN, 0)).toBeDefined();
    expect(store.lookupIdempotency("same", WS, "admin-2", 0)).toBeDefined();
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
    store!.claimIdempotency(key, WS, ADMIN, claimedAt, completedNotBefore, claimNotBefore);

  it("three-state machine: won → in_flight → replay → (release) → won", () => {
    store = createStore(":memory:");
    // First claim wins; the row is CLAIMED (receipt NULL).
    expect(claim("k")).toBe("won");
    // A concurrent claim while the winner is in flight sees the live claim.
    expect(claim("k")).toBe("in_flight");
    // lookupIdempotency must NOT return an in-flight claim as a completed receipt.
    expect(store.lookupIdempotency("k", WS, ADMIN, T)).toBeUndefined();
    // The winner fills the claim with its receipt.
    store.fillIdempotency("k", WS, ADMIN, resultRef(store), T);
    // Now a same-key claim within window is a replay, and the receipt is readable.
    expect(claim("k")).toBe("replay");
    expect(store.claimIdempotencyReceipt("k", WS, ADMIN)?.action).toBe("clockify_invoices_create");
    expect(store.lookupIdempotency("k", WS, ADMIN, T)?.action).toBe("clockify_invoices_create");
  });

  it("release frees a still-NULL claim so a fresh claim wins again (failed-commit retry)", () => {
    store = createStore(":memory:");
    expect(claim("k")).toBe("won");
    store.releaseIdempotency("k", WS, ADMIN); // winner's commit failed → release the claim
    expect(claim("k")).toBe("won"); // a legitimate retry re-claims and commits for real
  });

  it("release can NEVER drop a COMPLETED row", () => {
    store = createStore(":memory:");
    expect(claim("k")).toBe("won");
    store.fillIdempotency("k", WS, ADMIN, resultRef(store), T);
    store.releaseIdempotency("k", WS, ADMIN); // stray release after fill must be a no-op
    expect(store.claimIdempotencyReceipt("k", WS, ADMIN)?.action).toBe("clockify_invoices_create");
  });

  it("STALE-ROW RECLAIM: an out-of-window COMPLETED row is swept, not treated as a blocking conflict", () => {
    store = createStore(":memory:");
    // A completed row at T.
    record(store, "k", T);
    expect(store.claimIdempotencyReceipt("k", WS, ADMIN)?.action).toBe("clockify_invoices_create");
    // Claim with completedNotBefore = T + 1 → the row at T is now OUT of window.
    // The claim's stale-sweep deletes it and the fresh claim wins.
    expect(claim("k", T + 100, T + 1)).toBe("won");
    // The new claim row is a NULL-receipt CLAIM, not the stale completed receipt.
    expect(store.claimIdempotencyReceipt("k", WS, ADMIN)).toBeUndefined();
  });

  it("STALE-ROW RECLAIM: an IN-window COMPLETED row is NOT swept (it dedupes)", () => {
    store = createStore(":memory:");
    record(store, "k", T);
    // Claim with completedNotBefore = T (the row at T is IN window) → replay, not won.
    expect(claim("k", T + 100, T)).toBe("replay");
  });

  it("DEAD-CLAIM: a crash-orphaned claim within the dedup window is 'stale_unknown' (never silently re-won); past the window it re-claims; a LIVE claim is in_flight", () => {
    store = createStore(":memory:");
    // A dangling crashed CLAIM stamped at T0 (NULL receipt, no heartbeat).
    const T0 = T;
    expect(claim("dead", T0)).toBe("won"); // writes a NULL-receipt claim at T0
    // Past CLAIM_TTL (claimNotBefore after T0) but STILL within the dedup window
    // (completedNotBefore <= T0): the crash's host-side outcome is unknown, so it
    // must NOT be silently re-won — that would double-commit a money write whose
    // commit died between the host write and fill. [crash-before-fill residual]
    expect(claim("dead", T0 + 100, T0, T0 + 1)).toBe("stale_unknown");
    // The orphaned claim is left untouched — still a NULL-receipt claim, not re-won.
    expect(store.claimIdempotencyReceipt("dead", WS, ADMIN)).toBeUndefined();
    // Past the dedup window (completedNotBefore after T0): the intent no longer
    // dedupes, so the orphaned claim is swept and a deliberate re-issue wins.
    expect(claim("dead", T0 + 100, T0 + 1, T0 + 1)).toBe("won");

    // A LIVE claim (claimNotBefore strictly before the claim's stamp) is in_flight.
    expect(claim("live", T0)).toBe("won");
    expect(claim("live", T0 + 100, T, T0 - 1)).toBe("in_flight");
  });

  it("CLAIM_TTL_MS is strictly above the commit-timeout ceiling so a live claim is provably not swept", async () => {
    const { COMMIT_TIMEOUT_MS } = await import("../../src/clockify/rest/core.js");
    expect(CLAIM_TTL_MS).toBeGreaterThan(COMMIT_TIMEOUT_MS);
  });

  it("binds a won claim to its confirmation so settlement completes both rows atomically", () => {
    store = createStore(":memory:", { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: WS, adminUserId: ADMIN });
    const created = createPendingConfirmation({
      sessionId: session.id,
      workspaceId: WS,
      adminUserId: ADMIN,
      risk: ["high_risk_write"],
      preview: { summary: "Create invoice" },
      operation: {
        operationId: "op-idempotent-confirmation",
        actionName: "clockify_invoices_create",
        featureGroup: "invoices",
        risks: ["high_risk_write"],
        payload: { clientId: "client-1" },
      },
      sessionSecret: "secret",
    });
    store.savePendingConfirmation(created.record);
    expect(store.markConfirmationExecuting(created.record.id)).toBe(true);
    expect(claim("bound-key")).toBe("won");

    type BoundStore = Store & {
      bindConfirmationIdempotencyKey?: (confirmationId: string, key: string) => void;
    };
    const bind = (store as BoundStore).bindConfirmationIdempotencyKey;
    expect(bind).toBeTypeOf("function");
    if (!bind) return;
    bind(created.record.id, "bound-key");
    store.settleConfirmation(created.record.id, "succeeded", receipt.action, receipt);

    expect(claim("bound-key", T + 1, T)).toBe("replay");
    expect(store.claimIdempotencyReceipt("bound-key", WS, ADMIN)).toEqual(receipt);
  });
});

describe("claim heartbeat keeps a long multi-call commit's claim from being swept (touchIdempotencyClaim)", () => {
  // A single createInvoice commit issues POST+GET+PUT+tax+N item POSTs; their
  // summed latency can exceed CLAIM_TTL_MS (only the per-call timeout bounds
  // each). The heartbeat refreshes claimed_at so a long but LIVE commit stays
  // classified as in_flight. It is the LIVE-vs-crashed discriminator: a beating
  // claim is in_flight; a claim that stopped beating (a crash) ages past
  // CLAIM_TTL and becomes stale_unknown (crash-before-fill) — never a silent
  // re-win/double-commit.
  const T = 1_000_000;
  const WINDOW = 10 * 60 * 1000;
  const claim = (key: string, claimedAt: number, claimNotBefore: number) =>
    store!.claimIdempotency(key, WS, ADMIN, claimedAt, T - WINDOW, claimNotBefore);

  it("CLAIM_HEARTBEAT_MS refreshes well before CLAIM_TTL_MS (margin for a delayed beat)", () => {
    expect(CLAIM_HEARTBEAT_MS).toBeLessThan(CLAIM_TTL_MS);
    expect(CLAIM_HEARTBEAT_MS * 2).toBeLessThan(CLAIM_TTL_MS);
  });

  it("a HEARTBEATED claim is NOT swept past CLAIM_TTL_MS — a re-confirm sees in_flight, never a duplicate", () => {
    store = createStore(":memory:");
    expect(claim("hb", T, T - 1)).toBe("won"); // long commit wins the claim at T0
    // It heartbeats partway through (within CLAIM_TTL), refreshing claimed_at.
    store.touchIdempotencyClaim("hb", WS, ADMIN, T + CLAIM_TTL_MS - 60_000);
    // A re-confirm AFTER T0 + CLAIM_TTL_MS: the refreshed claim is still LIVE.
    const reconfirmAt = T + CLAIM_TTL_MS + 10_000;
    expect(claim("hb", reconfirmAt, reconfirmAt - CLAIM_TTL_MS)).toBe("in_flight");
  });

  it("WITHOUT a heartbeat (an un-refreshed claim) a re-confirm past CLAIM_TTL is 'stale_unknown', NOT a silent re-win", () => {
    store = createStore(":memory:");
    expect(claim("nohb", T, T - 1)).toBe("won");
    // No touch: the re-confirm past CLAIM_TTL finds the un-refreshed claim still
    // inside the dedup window. Pre-fix this RE-WON and double-committed (the
    // confirmed duplicate-invoice path); now the outcome is unknown, so it is
    // stale_unknown and the caller must not re-run it. [crash-before-fill]
    const reconfirmAt = T + CLAIM_TTL_MS + 10_000;
    expect(claim("nohb", reconfirmAt, reconfirmAt - CLAIM_TTL_MS)).toBe("stale_unknown");
  });

  it("touchIdempotencyClaim never disturbs a COMPLETED row", () => {
    store = createStore(":memory:");
    expect(claim("done", T, T - 1)).toBe("won");
    store.fillIdempotency("done", WS, ADMIN, resultRef(store), T);
    store.touchIdempotencyClaim("done", WS, ADMIN, T + 999_999); // no-op on a filled row
    expect(store.claimIdempotencyReceipt("done", WS, ADMIN)?.action).toBe("clockify_invoices_create");
    expect(claim("done", T + 1, T)).toBe("replay"); // still a normal completed replay
  });
});

describe("store pruneExpired backstop for crashed claims", () => {
  const NOW = new Date("2026-06-06T00:00:00.000Z");
  it("sweeps an orphaned NULL claim past the RETENTION window but KEEPS one still inside it (so a re-claim is stale_unknown, never a silent re-win)", async () => {
    store = createStore(":memory:", { now: () => NOW });
    const nowMs = NOW.getTime();
    const win = nowMs - IDEMPOTENCY_RETENTION_MS;
    const ttl = nowMs - CLAIM_TTL_MS;
    // A crashed claim older than the FULL retention window — safe to reclaim now.
    store.claimIdempotency("old", WS, ADMIN, nowMs - IDEMPOTENCY_RETENTION_MS - 1, win, ttl);
    // A crashed claim past CLAIM_TTL but STILL inside the retention/dedup window:
    // pruneExpired must KEEP it — sweeping at CLAIM_TTL would reopen the
    // crash-before-fill duplicate window from this hourly prune.
    store.claimIdempotency("recent-crash", WS, ADMIN, nowMs - CLAIM_TTL_MS - 1, win, ttl);

    const counts = await store.pruneExpired(NOW.toISOString());
    expect(counts.idempotencyKeys).toBe(1); // only the past-retention claim
    // The past-retention claim is gone → a fresh claim wins (recovery is bounded).
    expect(store.claimIdempotency("old", WS, ADMIN, nowMs, win, ttl)).toBe("won");
    // The within-window crash is still there → a re-claim is stale_unknown.
    expect(store.claimIdempotency("recent-crash", WS, ADMIN, nowMs, win, ttl)).toBe("stale_unknown");
  });
});
