import { afterEach, describe, expect, it } from "vitest";
import { createStore, type Store } from "../../src/db/store.js";
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
