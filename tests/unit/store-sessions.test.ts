import { describe, expect, it } from "vitest";
import { createStore } from "../../src/db/store.js";

const ENC_KEY = "test-encryption-key-do-not-use-in-prod";

/**
 * store.listSessions returns ONLY the live (non-expired), owned
 * (workspace + admin), NON-EMPTY chat sessions, newest-first, each summarised by
 * { id, title, messageCount, lastMessageAt, createdAt } where the title is the
 * session's first USER message. Expired, empty, other-admin, and other-workspace
 * sessions are excluded. Scope ruling: live owned sessions only (plan 007 §3).
 */
describe("store.listSessions", () => {
  it("invalidates every live session for one workspace admin", () => {
    const store = createStore(":memory:", {
      encryptionKey: ENC_KEY,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const first = store.createSession({ workspaceId: "ws1", adminUserId: "adminA" });
    const second = store.createSession({ workspaceId: "ws1", adminUserId: "adminA" });
    const other = store.createSession({ workspaceId: "ws1", adminUserId: "adminB" });

    expect(store.invalidateAdminSessions("ws1", "adminA")).toBe(2);
    expect(store.getSession(first.id)).toBeUndefined();
    expect(store.getSession(second.id)).toBeUndefined();
    expect(store.getSession(other.id)).toBeDefined();
    store.close();
  });

  it("returns only live, owned, non-empty sessions, newest-first, with title=first user message", () => {
    // A controllable clock so message timestamps + session expiry are deterministic.
    let clockMs = Date.UTC(2026, 5, 14, 9, 0, 0); // 2026-06-14T09:00:00Z
    const store = createStore(":memory:", {
      encryptionKey: ENC_KEY,
      now: () => new Date(clockMs),
    });

    // --- Two non-empty LIVE sessions for (ws1, adminA), authored at different times.
    const first = store.createSession({ workspaceId: "ws1", adminUserId: "adminA" });
    store.addMessage({
      sessionId: first.id,
      workspaceId: "ws1",
      adminUserId: "adminA",
      role: "user",
      content: "first conversation title",
    });

    clockMs += 60 * 1000; // +1 min — the second conversation is more recent
    const second = store.createSession({ workspaceId: "ws1", adminUserId: "adminA" });
    // A leading assistant/system message must NOT become the title — first USER does.
    store.addMessage({
      sessionId: second.id,
      workspaceId: "ws1",
      adminUserId: "adminA",
      role: "assistant",
      content: "hello, how can I help?",
    });
    clockMs += 1000;
    store.addMessage({
      sessionId: second.id,
      workspaceId: "ws1",
      adminUserId: "adminA",
      role: "user",
      content: "second conversation title",
    });
    clockMs += 1000;
    store.addMessage({
      sessionId: second.id,
      workspaceId: "ws1",
      adminUserId: "adminA",
      role: "assistant",
      content: "on it",
    });

    // --- (a) an EMPTY live owned session (just minted, no messages) — excluded.
    store.createSession({ workspaceId: "ws1", adminUserId: "adminA" });

    // --- (b) an EXPIRED owned session WITH a message — excluded.
    const expired = store.createSession({
      workspaceId: "ws1",
      adminUserId: "adminA",
      ttlMs: -1000, // already past its expiry relative to the clock
    });
    store.addMessage({
      sessionId: expired.id,
      workspaceId: "ws1",
      adminUserId: "adminA",
      role: "user",
      content: "expired conversation",
    });

    // --- (c) a session for (ws1, adminB) with a message — excluded (other admin).
    const otherAdmin = store.createSession({ workspaceId: "ws1", adminUserId: "adminB" });
    store.addMessage({
      sessionId: otherAdmin.id,
      workspaceId: "ws1",
      adminUserId: "adminB",
      role: "user",
      content: "adminB conversation",
    });

    // --- (d) a session for (ws2, adminA) with a message — excluded (other workspace).
    const otherWs = store.createSession({ workspaceId: "ws2", adminUserId: "adminA" });
    store.addMessage({
      sessionId: otherWs.id,
      workspaceId: "ws2",
      adminUserId: "adminA",
      role: "user",
      content: "ws2 conversation",
    });

    const nowIso = new Date(clockMs).toISOString();
    const sessions = store.listSessions("ws1", "adminA", nowIso);

    // Exactly the two non-empty live owned sessions, newest-first (second before first).
    expect(sessions.map((s) => s.id)).toEqual([second.id, first.id]);

    const [newest, oldest] = sessions;
    expect(newest.title).toBe("second conversation title"); // first USER message, not the assistant greeting
    expect(newest.messageCount).toBe(3);
    expect(oldest.title).toBe("first conversation title");
    expect(oldest.messageCount).toBe(1);
    expect(newest.createdAt).toBe(second.createdAt);
    expect(oldest.createdAt).toBe(first.createdAt);
    // lastMessageAt orders the list and is newer for the more recent conversation.
    expect(new Date(newest.lastMessageAt).getTime()).toBeGreaterThan(
      new Date(oldest.lastMessageAt).getTime(),
    );

    store.close();
  });

  it("returns an empty list for a workspace+admin with no live non-empty sessions", () => {
    const store = createStore(":memory:", { encryptionKey: ENC_KEY });
    const empty = store.createSession({ workspaceId: "ws1", adminUserId: "adminA" });
    // Empty session present but no messages → still nothing to list.
    expect(empty.id).toBeTruthy();
    expect(store.listSessions("ws1", "adminA", new Date().toISOString())).toEqual([]);
    store.close();
  });
});
