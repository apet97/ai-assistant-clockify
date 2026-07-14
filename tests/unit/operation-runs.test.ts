import { describe, expect, it } from "vitest";
import { createStore } from "../../src/db/store.js";

describe("durable operation runs", () => {
  it("journals prepared -> executing -> outcome_unknown without losing the canonical result", () => {
    const store = createStore(":memory:");
    const id = store.prepareOperationRun({
      requestId: "r1",
      sessionId: "s1",
      workspaceId: "w1",
      adminUserId: "a1",
      actionName: "clockify_tags_create",
      actionFingerprint: "af",
      catalogHash: "ch",
      operationHash: "oh",
    });
    expect(store.getOperationRun(id)?.status).toBe("prepared");
    store.markOperationExecuting(id);
    expect(store.getOperationRun(id)?.status).toBe("executing");
    store.settleOperationRun(id, "outcome_unknown", "result-1");
    expect(store.getOperationRun(id)).toMatchObject({ status: "outcome_unknown", actionResultId: "result-1" });
    store.close();
  });
});
