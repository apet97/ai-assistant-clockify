import { afterEach, describe, expect, it, vi } from "vitest";
import { executeAction, commitConfirmedOperation, CLAIM_HEARTBEAT_MS } from "../../src/harness/actions.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createStore, CLAIM_TTL_MS, type Store } from "../../src/db/store.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import { getAction, type ActionContext, type ConfirmableOperation } from "../../src/harness/catalog.js";
import { idempotencyScopeKey } from "../../src/harness/idempotency.js";
import { IDEMPOTENCY_WINDOW_MS } from "../../src/routes/chat-constants.js";
import { isPartialCommitResult, type AtomicIdempotencyLedger, type CommitResult } from "../../src/harness/action.js";
import type { WorkspaceClient } from "../../src/clockify/client.js";
import type { SuccessReceipt } from "../../src/harness/receipts.js";

/**
 * r1-concurrency-races-01 — the headline race. TWO concurrent confirms of ONE
 * semantic intent must reach the host EXACTLY ONCE. The atomic claim is taken
 * BEFORE the commit await; the loser sees the live claim (in_flight) or the
 * filled receipt (replay) — never a second host call.
 */

const NOW = new Date("2026-06-05T00:00:00.000Z");
const WS = "ws-1";
const ADMIN = "admin-1";

function resultRef(store: Store, result: CommitResult) {
  const receipt = isPartialCommitResult(result) ? result.receipt : result;
  return store.recordActionResult({
    workspaceId: WS,
    adminUserId: ADMIN,
    actionName: receipt.action,
    status: isPartialCommitResult(result) ? "partial" : receipt.ok ? "succeeded" : "definitive_failed",
    result: isPartialCommitResult(result) ? result : { kind: "receipt", receipt },
  });
}

/** A store-backed atomic ledger, wired exactly like routes/api.ts. */
function atomicLedger(store: Store): AtomicIdempotencyLedger {
  const WINDOW = 10 * 60 * 1000;
  const t = () => NOW.getTime();
  return {
    lookup: (k) => store.lookupIdempotency(k, WS, ADMIN, t() - WINDOW),
    record: (k, r) => store.recordIdempotency(k, WS, ADMIN, resultRef(store, r), t()),
    claim: (k) => store.claimIdempotency(k, WS, ADMIN, t(), t() - WINDOW, t() - CLAIM_TTL_MS),
    lookupCompleted: (k) => store.claimIdempotencyReceipt(k, WS, ADMIN),
    fill: (k, r) => store.fillIdempotency(k, WS, ADMIN, resultRef(store, r), t()),
    release: (k) => store.releaseIdempotency(k, WS, ADMIN),
  };
}

function ctxWith(fake: FakeWorkspace, ledger: AtomicIdempotencyLedger, client?: WorkspaceClient): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy: defaultAdminPolicy(),
    clockify: client ?? fake.client,
    now: () => NOW,
    idempotency: ledger,
  };
}

async function previewInvoice(ctx: ActionContext, clientName: string): Promise<ConfirmableOperation> {
  const result = await executeAction({
    actionName: "clockify_invoices_create",
    args: { clientName, items: [{ description: "charge", quantity: 1, amount: 1000 }] },
    context: ctx,
  });
  if (result.kind !== "preview") throw new Error("expected a preview");
  return result.operation;
}

/** Wrap createInvoice so the next call blocks on a manually-resolved promise. */
function deferredCreateInvoice(fake: FakeWorkspace): {
  client: WorkspaceClient;
  resolve: () => void;
  reject: (e: unknown) => void;
  calls: () => number;
} {
  const real = fake.client.createInvoice.bind(fake.client);
  let gate!: { resolve: (v?: unknown) => void; reject: (e?: unknown) => void };
  const barrier = new Promise((resolve, reject) => {
    gate = { resolve, reject };
  });
  let calls = 0;
  const client = new Proxy(fake.client, {
    get(target, prop, receiver) {
      if (prop === "createInvoice") {
        return async (...args: Parameters<typeof real>) => {
          calls += 1;
          await barrier; // block until the test resolves the gate
          return real(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { client, resolve: () => gate.resolve(), reject: (e) => gate.reject(e), calls: () => calls };
}

let store: Store | undefined;
afterEach(() => store?.close());

describe("concurrent confirm race (r1-concurrency-races-01)", () => {
  it("two concurrent confirms of the same intent call the host EXACTLY ONCE", async () => {
    store = createStore(":memory:");
    const ledger = atomicLedger(store);
    const fake = createFakeWorkspace({ clients: [{ id: "c-qwen", name: "qwen" }] });
    const deferred = deferredCreateInvoice(fake);
    const ctx = ctxWith(fake, ledger, deferred.client);
    const op = await previewInvoice(ctx, "qwen");

    // Fire both confirms before resolving the in-flight commit.
    const both = Promise.all([
      commitConfirmedOperation(ctx, op),
      commitConfirmedOperation(ctx, op),
    ]);
    // Give the loser a tick to take the in_flight branch, then resolve the winner.
    await new Promise((r) => setTimeout(r, 10));
    deferred.resolve();
    const [r1, r2] = await both;

    expect(deferred.calls()).toBe(1); // the host was reached EXACTLY ONCE
    expect(fake.counts.createInvoice).toBe(1);

    // Exactly one real ok-commit (no replay warning); the other is EITHER a
    // markReplayed receipt OR a benign commit_in_progress error — never a 2nd ok.
    const okCommits = [r1, r2].filter(
      (r) => r.ok && !(r.warnings ?? []).some((w) => w.code === "idempotent_replay"),
    );
    expect(okCommits).toHaveLength(1);
    const other = [r1, r2].find((r) => r !== okCommits[0]);
    expect(other).toBeDefined();
    const otherIsReplay = other!.ok && (other!.warnings ?? []).some((w) => w.code === "idempotent_replay");
    const otherIsInFlight = !other!.ok && (other as { code?: string }).code === "commit_in_progress";
    expect(otherIsReplay || otherIsInFlight).toBe(true);
  });

  it("IN-FLIGHT LOSER: returns commit_in_progress (honest copy, no host call); a later confirm replays", async () => {
    store = createStore(":memory:");
    const ledger = atomicLedger(store);
    const fake = createFakeWorkspace({ clients: [{ id: "c-qwen", name: "qwen" }] });
    const deferred = deferredCreateInvoice(fake);
    const ctx = ctxWith(fake, ledger, deferred.client);
    const op = await previewInvoice(ctx, "qwen");

    const winner = commitConfirmedOperation(ctx, op); // takes the claim, blocks on the gate
    await new Promise((r) => setTimeout(r, 10));
    // A concurrent same-key confirm while the winner is in flight.
    const loser = await commitConfirmedOperation(ctx, op);
    expect(loser.ok).toBe(false);
    expect((loser as { code?: string }).code).toBe("commit_in_progress");
    expect((loser as { message?: string }).message).not.toMatch(/completed|done/i);
    expect(deferred.calls()).toBe(1); // the loser did NOT reach the host

    deferred.resolve();
    expect((await winner).ok).toBe(true);

    // A THIRD same-key confirm after the winner finished is a replay.
    const third = await commitConfirmedOperation(ctx, op);
    expect(third.ok).toBe(true);
    if (third.ok) expect((third.warnings ?? []).some((w) => w.code === "idempotent_replay")).toBe(true);
    expect(fake.counts.createInvoice).toBe(1);
  });

  it("FAILED-COMMIT RELEASE: a failed winner frees the claim so a fresh confirm commits for real", async () => {
    store = createStore(":memory:");
    const ledger = atomicLedger(store);
    const fake = createFakeWorkspace({ clients: [{ id: "c-qwen", name: "qwen" }] });
    const deferred = deferredCreateInvoice(fake);
    const ctx = ctxWith(fake, ledger, deferred.client);
    const op = await previewInvoice(ctx, "qwen");

    const winner = commitConfirmedOperation(ctx, op);
    await new Promise((r) => setTimeout(r, 10));
    deferred.reject(new Error("transient host failure"));
    const r1 = await winner;
    expect(r1.ok).toBe(false); // surfaced honestly

    // The claim must be released — a fresh confirm (now succeeding) commits for real.
    const ctx2 = ctxWith(fake, ledger); // real (non-deferred) client succeeds
    const r2 = await commitConfirmedOperation(ctx2, await previewInvoice(ctx2, "qwen"));
    expect(r2.ok).toBe(true);
    if (r2.ok) expect((r2.warnings ?? []).some((w) => w.code === "idempotent_replay")).toBe(false);
    expect(fake.counts.createInvoice).toBe(1); // exactly one invoice (the failure created none)
  });

  it("HEARTBEAT WIRING: a long in-flight commit refreshes its claim via ledger.touch (so it is never swept mid-flight)", async () => {
    // A multi-call commit (createInvoice = POST+GET+PUT+tax+N items) can run past
    // CLAIM_TTL_MS; without a heartbeat its still-LIVE claim would be swept and a
    // re-confirm would double-commit. commitConfirmedOperation must touch the
    // claim on CLAIM_HEARTBEAT_MS while the commit is in flight, and stop after.
    vi.useFakeTimers();
    try {
      store = createStore(":memory:");
      const touched: string[] = [];
      const ledger: AtomicIdempotencyLedger = { ...atomicLedger(store), touch: (k) => touched.push(k) };
      const fake = createFakeWorkspace({ clients: [{ id: "c-qwen", name: "qwen" }] });
      const deferred = deferredCreateInvoice(fake);
      const ctx = ctxWith(fake, ledger, deferred.client);
      const op = await previewInvoice(ctx, "qwen");

      const commit = commitConfirmedOperation(ctx, op); // claims, then blocks on the gate
      await vi.advanceTimersByTimeAsync(CLAIM_HEARTBEAT_MS * 2 + 1_000); // ~2 beats in flight
      expect(touched.length).toBeGreaterThanOrEqual(2); // the live claim is being refreshed

      deferred.resolve();
      expect((await commit).ok).toBe(true);

      const afterCommit = touched.length;
      await vi.advanceTimersByTimeAsync(CLAIM_HEARTBEAT_MS * 3); // interval was cleared in finally
      expect(touched.length).toBe(afterCommit); // no further beats after the commit settles
    } finally {
      vi.useRealTimers();
    }
  });

  it("PRE-COMMIT FAIL-CLOSED: a claim() that throws (transient SQLITE_BUSY) returns commit_unavailable and never reaches the host", async () => {
    // The atomic claim is taken BEFORE the commit await. If that synchronous DB
    // write throws (the retention prune / erase-workspace holding the /data lock
    // past busy_timeout), commitConfirmedOperation MUST fail CLOSED — no host call
    // happened yet, so it returns a clean retryable receipt, never a 500, and the
    // commit closure must NOT run. (Documented "Never throws".)
    store = createStore(":memory:");
    const fake = createFakeWorkspace({ clients: [{ id: "c-qwen", name: "qwen" }] });
    // A deferred host wrapper lets us assert the host was never even invoked: if
    // the commit closure ran, deferred.calls() would be 1 (and it would hang on the
    // unresolved barrier). A throwing claim must short-circuit before that.
    const deferred = deferredCreateInvoice(fake);
    // Preview with a healthy ledger so the operation is well-formed...
    const previewCtx = ctxWith(fake, atomicLedger(store), deferred.client);
    const op = await previewInvoice(previewCtx, "qwen");
    // ...then commit with a ledger whose claim() throws (everything else intact).
    const throwing: AtomicIdempotencyLedger = {
      ...atomicLedger(store),
      claim: () => {
        throw new Error("SQLITE_BUSY: database is locked");
      },
    };
    const commitCtx = ctxWith(fake, throwing, deferred.client);

    const receipt = await commitConfirmedOperation(commitCtx, op);

    // Fail CLOSED: a clean, retryable error receipt — not a throw, not an ok.
    expect(receipt.ok).toBe(false);
    expect((receipt as { code?: string }).code).toBe("commit_unavailable");
    expect((receipt as { recovery?: { retryable?: boolean } }).recovery?.retryable).toBe(true);
    // The important half: the commit closure was NEVER invoked — the host was not
    // touched. The fake only registers a count key once a method runs, so an
    // untouched host leaves createInvoice unrecorded (the deferred wrapper is the
    // primary witness: its barrier would still be pending had the closure run).
    expect(deferred.calls()).toBe(0);
    expect(fake.counts.createInvoice ?? 0).toBe(0);
  });
});

/**
 * crash-before-fill residual — the only remaining money-integrity gap. The claim
 * is taken, the host write happens, then fillIdempotency runs. If the PROCESS
 * CRASHES in the sub-ms gap between the host write and the fill, the claim row is
 * left NULL. The heartbeat does NOT help — that's a crash, not a slow commit. The
 * fix: a crash-orphaned claim within the idempotency window is reported
 * `stale_unknown` (outcome unknown — verify in Clockify), NEVER silently re-won.
 * Only past the window (a deliberate re-issue, same as normal idempotency) does it
 * re-claim. Cannot be made fully airtight without Clockify create-idempotency.
 */
describe("crash-before-fill residual (a crash between the host write and fill must not silently double-commit)", () => {
  // A mutable-clock atomic ledger, wired exactly like routes/api.ts. `fill` is
  // toggled off for the crashing confirm to simulate a process death in the gap
  // between the host write and fillIdempotency (the claim row is left NULL).
  function clockLedger(s: Store, clock: { ms: number }, fillOn: boolean): AtomicIdempotencyLedger {
    const WINDOW = 10 * 60 * 1000;
    return {
      lookup: (k) => s.lookupIdempotency(k, WS, ADMIN, clock.ms - WINDOW),
      record: (k, r) => s.recordIdempotency(k, WS, ADMIN, resultRef(s, r), clock.ms),
      claim: (k) => s.claimIdempotency(k, WS, ADMIN, clock.ms, clock.ms - WINDOW, clock.ms - CLAIM_TTL_MS),
      lookupCompleted: (k) => s.claimIdempotencyReceipt(k, WS, ADMIN),
      fill: fillOn ? (k, r) => s.fillIdempotency(k, WS, ADMIN, resultRef(s, r), clock.ms) : () => undefined,
      release: (k) => s.releaseIdempotency(k, WS, ADMIN),
    };
  }
  function clockCtx(fake: FakeWorkspace, clock: { ms: number }, ledger: AtomicIdempotencyLedger): ActionContext {
    return {
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      policy: defaultAdminPolicy(),
      clockify: fake.client,
      now: () => new Date(clock.ms),
      idempotency: ledger,
    };
  }

  it("a crash-orphaned claim is NOT silently re-committed within the window — outcome unknown, host hit EXACTLY ONCE", async () => {
    store = createStore(":memory:");
    const clock = { ms: NOW.getTime() };
    const fake = createFakeWorkspace({ clients: [{ id: "c-qwen", name: "qwen" }] });
    const op = await previewInvoice(clockCtx(fake, clock, clockLedger(store, clock, true)), "qwen");

    // The host write succeeds, but the process CRASHES before fillIdempotency runs
    // (fill is a no-op) — the claim row is left NULL at NOW.
    const crashed = await commitConfirmedOperation(clockCtx(fake, clock, clockLedger(store, clock, false)), op);
    expect(crashed.ok).toBe(true);
    expect(fake.counts.createInvoice).toBe(1);

    // 6 minutes later: past CLAIM_TTL (5m), still inside the IDEMPOTENCY_WINDOW (10m).
    clock.ms = NOW.getTime() + 6 * 60 * 1000;

    // Re-confirm the SAME intent. The crash outcome is unknown, so it must NOT be
    // silently re-committed — the host stays at exactly one call.
    const reconfirm = await commitConfirmedOperation(clockCtx(fake, clock, clockLedger(store, clock, true)), op);
    expect(fake.counts.createInvoice).toBe(1);
    expect(reconfirm.ok).toBe(false);
    if (!reconfirm.ok) expect(reconfirm.code).toBe("commit_outcome_unknown");
  });

  it("past the idempotency window a crash-orphaned claim no longer blocks — a deliberate re-issue commits (recovery is bounded, not permanent)", async () => {
    store = createStore(":memory:");
    const clock = { ms: NOW.getTime() };
    const fake = createFakeWorkspace({ clients: [{ id: "c-qwen", name: "qwen" }] });
    const op = await previewInvoice(clockCtx(fake, clock, clockLedger(store, clock, true)), "qwen");
    await commitConfirmedOperation(clockCtx(fake, clock, clockLedger(store, clock, false)), op); // crash → NULL claim
    expect(fake.counts.createInvoice).toBe(1);

    // 11 minutes later: PAST the dedup window — a re-confirm is a deliberate new
    // intent (same as re-issuing any invoice past the window) and commits.
    clock.ms = NOW.getTime() + 11 * 60 * 1000;
    const reissue = await commitConfirmedOperation(clockCtx(fake, clock, clockLedger(store, clock, true)), op);
    expect(reissue.ok).toBe(true);
    expect(fake.counts.createInvoice).toBe(2);
  });
});

/**
 * F4 — commit_outcome_unknown END-TO-END via a SEEDED stale claim (fake timers).
 * The unit test (tests/unit/idempotency-store.test.ts) proves claimIdempotency
 * returns "stale_unknown" for a crash-orphaned NULL claim past CLAIM_TTL_MS but
 * still inside the dedup window; this drives that exact state through the real
 * commitConfirmedOperation RECEIPT path (the route/receipt wiring the unit test
 * doesn't reach) and asserts the calm "verify in Clockify" receipt with NO host
 * write. The timer advance is DERIVED from the exported constants (CLAIM_TTL_MS,
 * IDEMPOTENCY_WINDOW_MS) — never hard-coded — so it tracks any future retune.
 */
describe("commit_outcome_unknown end-to-end (a seeded stale claim drives the confirm path)", () => {
  /** A store-backed atomic ledger whose clock is the (fake) SYSTEM clock — wired
   *  exactly like routes/chat-pipeline.ts (now().getTime() - {WINDOW,CLAIM_TTL}),
   *  so advancing vi's fake timers ages the claim past CLAIM_TTL_MS. */
  function liveClockLedger(s: Store): AtomicIdempotencyLedger {
    const t = () => Date.now();
    return {
      lookup: (k) => s.lookupIdempotency(k, WS, ADMIN, t() - IDEMPOTENCY_WINDOW_MS),
      record: (k, r) => s.recordIdempotency(k, WS, ADMIN, resultRef(s, r), t()),
      claim: (k) => s.claimIdempotency(k, WS, ADMIN, t(), t() - IDEMPOTENCY_WINDOW_MS, t() - CLAIM_TTL_MS),
      lookupCompleted: (k) => s.claimIdempotencyReceipt(k, WS, ADMIN),
      fill: (k, r) => s.fillIdempotency(k, WS, ADMIN, resultRef(s, r), t()),
      release: (k) => s.releaseIdempotency(k, WS, ADMIN),
    };
  }

  it("a confirm whose claim is crash-orphaned past CLAIM_TTL but in-window yields commit_outcome_unknown with NO host write", async () => {
    // The advance must be strictly between CLAIM_TTL_MS (claim is now "dead") and
    // IDEMPOTENCY_WINDOW_MS (intent still dedupes). The midpoint satisfies both for
    // any CLAIM_TTL_MS < IDEMPOTENCY_WINDOW_MS — derived, never hard-coded.
    expect(CLAIM_TTL_MS).toBeLessThan(IDEMPOTENCY_WINDOW_MS);
    const advanceMs = Math.floor((CLAIM_TTL_MS + IDEMPOTENCY_WINDOW_MS) / 2);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      store = createStore(":memory:");
      const ledger = liveClockLedger(store);
      const fake = createFakeWorkspace({ clients: [{ id: "c-qwen", name: "qwen" }] });
      const ctx = ctxWith(fake, ledger);
      const op = await previewInvoice(ctx, "qwen");

      // Seed the crash-orphaned claim DIRECTLY in the store at NOW: a NULL-receipt
      // claim is exactly the row a process crash between the host write and `fill`
      // leaves. The scoped key is computed the same way commitConfirmedOperation
      // does, so the seed and the confirm collide on the SAME ledger row.
      const action = getAction("clockify_invoices_create");
      const semantic = action?.idempotencyKey?.(op);
      expect(semantic).toBeDefined();
      const scopedKey = idempotencyScopeKey(ctx.workspaceId, ctx.adminUserId, op, semantic!);
      expect(ledger.claim(scopedKey)).toBe("won"); // writes the NULL claim at NOW

      // Age the claim past CLAIM_TTL_MS (now "dead") but stay inside the dedup
      // window — the crash's host-side outcome is UNKNOWN, never silently re-won.
      await vi.advanceTimersByTimeAsync(advanceMs);

      const receipt = await commitConfirmedOperation(ctx, op);

      expect(receipt.ok).toBe(false);
      expect((receipt as { code?: string }).code).toBe("commit_outcome_unknown");
      // The host was NEVER reached: the seed never committed and stale_unknown
      // short-circuits BEFORE the commit — so there is no (duplicate) host write.
      expect(fake.counts.createInvoice ?? 0).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
