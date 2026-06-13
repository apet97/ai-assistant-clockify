import { afterEach, describe, expect, it } from "vitest";
import { executeAction, commitConfirmedOperation } from "../../src/harness/actions.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createStore, CLAIM_TTL_MS, type Store } from "../../src/db/store.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext, ConfirmableOperation } from "../../src/harness/catalog.js";
import type { AtomicIdempotencyLedger } from "../../src/harness/action.js";
import type { WorkspaceClient } from "../../src/clockify/client.js";

/**
 * r1-concurrency-races-01 — the headline race. TWO concurrent confirms of ONE
 * semantic intent must reach the host EXACTLY ONCE. The atomic claim is taken
 * BEFORE the commit await; the loser sees the live claim (in_flight) or the
 * filled receipt (replay) — never a second host call.
 */

const NOW = new Date("2026-06-05T00:00:00.000Z");

/** A store-backed atomic ledger, wired exactly like routes/api.ts. */
function atomicLedger(store: Store): AtomicIdempotencyLedger {
  const WINDOW = 10 * 60 * 1000;
  const t = () => NOW.getTime();
  return {
    lookup: (k) => store.lookupIdempotency(k, t() - WINDOW),
    record: (k, r) => store.recordIdempotency(k, r, t()),
    claim: (k) => store.claimIdempotency(k, t(), t() - WINDOW, t() - CLAIM_TTL_MS),
    lookupCompleted: (k) => store.claimIdempotencyReceipt(k),
    fill: (k, r) => store.fillIdempotency(k, r, t()),
    release: (k) => store.releaseIdempotency(k),
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
});
