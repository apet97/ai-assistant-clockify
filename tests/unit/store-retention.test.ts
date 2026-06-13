import { describe, expect, it } from "vitest";
import { createStore, IDEMPOTENCY_RETENTION_MS, type TestStore } from "../../src/db/store.js";
import { IDEMPOTENCY_WINDOW_MS } from "../../src/routes/api.js";
import { successReceipt } from "../../src/harness/receipts.js";

/**
 * Retention pruning for the OPERATIONAL tables only. audit_events (the audit
 * log) and chat_messages (durable history) are product features and must NEVER
 * be pruned — pinned below with a far-future clock.
 */
const NOW = new Date("2026-06-06T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();

function confirmation(id: string, sessionId: string, status: "pending" | "used" | "cancelled", createdAt: string, expiresAt: string) {
  return {
    id,
    sessionId,
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    status,
    risk: ["high_risk_write" as const],
    preview: {},
    operation: {},
    operationHash: "h",
    nonceHash: "n",
    expiresAt,
    createdAt,
  };
}

describe("store.pruneExpired", () => {
  it("prunes settled confirmations older than 30d and long-expired pendings; keeps recent + live ones", () => {
    const store = createStore(":memory:", { encryptionKey: "k", now: () => NOW });
    // pending_confirmations FK-references a real chat session.
    const s = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" }).id;
    store.savePendingConfirmation(confirmation("old-used", s, "used", iso(-31 * DAY_MS), iso(-31 * DAY_MS)));
    store.savePendingConfirmation(confirmation("new-used", s, "used", iso(-1 * DAY_MS), iso(-1 * DAY_MS)));
    store.savePendingConfirmation(confirmation("stale-pending", s, "pending", iso(-40 * DAY_MS), iso(-39 * DAY_MS)));
    store.savePendingConfirmation(confirmation("live-pending", s, "pending", iso(-60_000), iso(5 * 60_000)));

    const counts = store.pruneExpired(NOW.toISOString());
    expect(counts.pendingConfirmations).toBe(2);
    expect(store.getPendingConfirmation("old-used")).toBeUndefined();
    expect(store.getPendingConfirmation("new-used")).toBeDefined();
    expect(store.getPendingConfirmation("stale-pending")).toBeUndefined();
    expect(store.getPendingConfirmation("live-pending")).toBeDefined();
    expect(store.countPendingConfirmations(s, NOW.toISOString())).toBe(1);
    store.close();
  });

  it("prunes idempotency keys past retention (and retention stays ≥ the dedupe window)", () => {
    expect(IDEMPOTENCY_RETENTION_MS).toBeGreaterThan(IDEMPOTENCY_WINDOW_MS);
    const store = createStore(":memory:", { encryptionKey: "k", now: () => NOW });
    const receipt = successReceipt({ action: "x" });
    store.recordIdempotency("old", receipt, NOW.getTime() - 2 * 60 * 60 * 1000);
    store.recordIdempotency("fresh", receipt, NOW.getTime() - 5 * 60 * 1000);

    const counts = store.pruneExpired(NOW.toISOString());
    expect(counts.idempotencyKeys).toBe(1);
    // The fresh key still dedupes inside the window.
    expect(store.lookupIdempotency("fresh", NOW.getTime() - IDEMPOTENCY_WINDOW_MS)).toBeDefined();
    store.close();
  });

  it("prunes UNDONE undo records older than 30d but never an available one", () => {
    const past = { value: new Date(NOW.getTime() - 31 * DAY_MS) };
    const store = createStore(":memory:", { encryptionKey: "k", now: () => past.value });
    const base = { sessionId: "s1", workspaceId: "ws-1", adminUserId: "admin-1", actionName: "x", reversal: [] };
    const undoneId = store.recordUndoable(base);
    store.markUndone(undoneId); // stamped 31d ago via the injected clock
    const availableId = store.recordUndoable(base); // created 31d ago, still available

    const counts = store.pruneExpired(NOW.toISOString());
    expect(counts.undoRecords).toBe(1);
    expect(store.getUndoRecord(undoneId)).toBeUndefined();
    expect(store.getUndoRecord(availableId)).toBeDefined();
    store.close();
  });

  it("records + lists turn telemetry (since-bounded) and prunes rows past 30d", () => {
    const past = { value: new Date(NOW.getTime() - 31 * DAY_MS) };
    const store = createStore(":memory:", { encryptionKey: "k", now: () => past.value });
    const base = { sessionId: "s1", workspaceId: "ws-1", adminUserId: "admin-1", kind: "chat" as const };
    store.recordTurnTelemetry({ ...base, modelCalls: 3, promptTokens: 1200, completionTokens: 90, turnMs: 4000, modelMs: 3500 });
    past.value = NOW; // second row is fresh
    store.recordTurnTelemetry({ ...base, kind: "resume", modelCalls: 1, turnMs: 800, modelMs: 600 });

    const all = store.listTurnTelemetry("ws-1", "admin-1");
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ kind: "chat", modelCalls: 3, promptTokens: 1200 });
    expect(all[1]).toMatchObject({ kind: "resume", promptTokens: undefined }); // honest absence, not zero

    const bounded = store.listTurnTelemetry("ws-1", "admin-1", iso(-DAY_MS));
    expect(bounded).toHaveLength(1);

    const counts = store.pruneExpired(NOW.toISOString());
    expect(counts.turnTelemetry).toBe(1);
    expect(store.listTurnTelemetry("ws-1", "admin-1")).toHaveLength(1);
    store.close();
  });

  it("prune DELETEs use an index, not a full table scan (hourly + at-startup sweep cost ~O(rows-to-delete))", () => {
    const store = createStore(":memory:", { encryptionKey: "k", now: () => NOW }) as TestStore;
    const plan = store.explainPrunePlan();
    // Every retention DELETE must SEARCH/USING an index on its retention column,
    // never SCAN the whole table — turn_telemetry + idempotency_keys grow without
    // bound on a long-lived single instance, and the at-startup prune gates listen.
    expect(plan.pendingConfirmations).not.toMatch(/SCAN pending_confirmations/);
    expect(plan.idempotencyKeys).not.toMatch(/SCAN idempotency_keys/);
    expect(plan.undoRecords).not.toMatch(/SCAN undo_records/);
    expect(plan.turnTelemetry).not.toMatch(/SCAN turn_telemetry/);
    store.close();
  });

  it("NEVER touches audit_events or chat_messages, even with a far-future clock", () => {
    const store = createStore(":memory:", { encryptionKey: "k", now: () => NOW });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    store.addMessage({ sessionId: session.id, workspaceId: "ws-1", adminUserId: "admin-1", role: "user", content: "hi" });
    store.addAuditEvent({
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "clockify_tags_create",
      risk: ["safe_write"],
      receipt: successReceipt({ action: "clockify_tags_create" }),
    });

    const tenYears = new Date(NOW.getTime() + 3650 * DAY_MS).toISOString();
    store.pruneExpired(tenYears);
    expect(store.getRecentMessages(session.id, 10)).toHaveLength(1);
    expect(store.listActionOutcomes("ws-1", "admin-1")).toHaveLength(1);
    store.close();
  });
});
