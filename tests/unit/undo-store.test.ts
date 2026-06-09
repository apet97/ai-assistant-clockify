import { afterEach, describe, expect, it } from "vitest";
import { createStore, type Store } from "../../src/db/store.js";

let store: Store | undefined;
afterEach(() => store?.close());

const base = {
  sessionId: "s-1",
  workspaceId: "ws-1",
  adminUserId: "admin-1",
  actionName: "clockify_create_work_package",
  reversal: [{ type: "project", id: "p1", name: "Phoenix" }],
};

describe("store undo records", () => {
  it("records an undoable action and reads it back as available", () => {
    store = createStore(":memory:");
    const id = store.recordUndoable(base);
    const rec = store.getUndoRecord(id);
    expect(rec?.status).toBe("available");
    expect(rec?.reversal).toEqual(base.reversal);
    expect(rec?.actionName).toBe("clockify_create_work_package");
  });

  it("markUndone is one-use (atomic available → undone)", () => {
    store = createStore(":memory:");
    const id = store.recordUndoable(base);
    expect(store.markUndone(id)).toBe(true);
    expect(store.getUndoRecord(id)?.status).toBe("undone");
    expect(store.markUndone(id)).toBe(false); // already undone — cannot replay
  });

  it("returns undefined for an unknown id", () => {
    store = createStore(":memory:");
    expect(store.getUndoRecord("nope")).toBeUndefined();
    expect(store.markUndone("nope")).toBe(false);
  });
});
