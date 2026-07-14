import { describe, expect, it } from "vitest";
import { createStore } from "../../src/db/store.js";

describe("durable turn runs", () => {
  it("claims a request id once, replays the same intent, and rejects conflicting reuse", () => {
    const store = createStore(":memory:");
    const scope = { requestId: "98f6a2ca-c53c-45da-9f13-c9a789bb6f35", sessionId: "s1", workspaceId: "w1", adminUserId: "a1" };

    expect(store.claimTurnRun({ ...scope, intentHash: "same" })).toEqual({ state: "won" });
    expect(store.claimTurnRun({ ...scope, intentHash: "same" })).toEqual({ state: "in_flight" });
    store.finishTurnRun(scope.sessionId, scope.requestId, "succeeded", { ok: true, reply: { text: "done" }, results: [] });
    expect(store.claimTurnRun({ ...scope, intentHash: "same" })).toMatchObject({ state: "replay", response: { ok: true } });
    expect(store.claimTurnRun({ ...scope, intentHash: "different" })).toEqual({ state: "conflict" });
    store.close();
  });
});
