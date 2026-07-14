import { describe, expect, it } from "vitest";
import { createStore } from "../../src/db/store.js";

describe("short-lived artifacts", () => {
  it("binds bytes to workspace, admin, session and expires them after 60 minutes", () => {
    let now = new Date("2026-07-14T10:00:00.000Z");
    const store = createStore(":memory:", { now: () => now });
    const session = store.createSession({ workspaceId: "ws1", adminUserId: "a1" });
    const created = store.createArtifact({
      workspaceId: "ws1",
      adminUserId: "a1",
      sessionId: session.id,
      contentType: "application/pdf",
      filename: "invoice.pdf",
      bytes: new Uint8Array([1, 2, 3]),
    });

    expect(store.getArtifact(created.id, "ws1", "a1", session.id)?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(store.getArtifact(created.id, "ws1", "other", session.id)).toBeUndefined();
    now = new Date("2026-07-14T11:00:00.001Z");
    expect(store.getArtifact(created.id, "ws1", "a1", session.id)).toBeUndefined();
    store.close();
  });

  it("refuses an artifact over the one-megabyte hard limit", () => {
    const store = createStore(":memory:");
    expect(() => store.createArtifact({
      workspaceId: "ws1",
      adminUserId: "a1",
      sessionId: "s1",
      contentType: "application/pdf",
      filename: "big.pdf",
      bytes: new Uint8Array(1_000_001),
    })).toThrow(/artifact_too_large/);
    store.close();
  });
});
