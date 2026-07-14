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
  it("expires an unused undo after 30 minutes", () => {
    let now = new Date("2026-07-14T10:00:00.000Z");
    store = createStore(":memory:", { now: () => now });
    const id = store.recordUndoable(base);
    now = new Date("2026-07-14T10:30:00.001Z");
    expect(store.getUndoRecord(id)?.status).toBe("expired");
    expect(store.markUndoExecuting(id)).toBe(false);
  });

  it("records an undoable action and reads it back as available", () => {
    store = createStore(":memory:");
    const id = store.recordUndoable(base);
    const rec = store.getUndoRecord(id);
    expect(rec?.status).toBe("available");
    expect(rec?.reversal).toEqual(base.reversal);
    expect(rec?.actionName).toBe("clockify_create_work_package");
  });

  it("claims available → executing once, then settles as undone", () => {
    store = createStore(":memory:");
    const id = store.recordUndoable(base);
    expect(store.markUndoExecuting(id)).toBe(true);
    expect(store.getUndoRecord(id)?.status).toBe("executing");
    store.settleUndo(id, "undone", [], { ok: true });
    expect(store.getUndoRecord(id)?.status).toBe("undone");
    expect(store.markUndoExecuting(id)).toBe(false);
  });

  it("returns undefined for an unknown id", () => {
    store = createStore(":memory:");
    expect(store.getUndoRecord("nope")).toBeUndefined();
    expect(store.markUndoExecuting("nope")).toBe(false);
  });
});
