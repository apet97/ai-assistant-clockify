import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createStore, IDEMPOTENCY_RETENTION_MS, type TestStore } from "../../src/db/store.js";
import { IDEMPOTENCY_WINDOW_MS } from "../../src/routes/chat-constants.js";
import { successReceipt } from "../../src/harness/receipts.js";
import { buildAllowIntentCapabilityV1 } from "../../src/harness/intent-capability.js";
import { createPendingConfirmation } from "../../src/harness/confirmations.js";

/** Retention pruning for operational rows, transcripts, audit, and artifacts. */
const NOW = new Date("2026-06-06T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();

function confirmation(id: string, sessionId: string, status: "pending" | "succeeded" | "cancelled", createdAt: string, expiresAt: string) {
  return {
    id,
    operationId: `op-${id}`,
    sessionId,
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    status,
    risk: ["high_risk_write" as const],
    preview: {},
    operation: {},
    operationHash: "h",
    targetFingerprints: [],
    actionFingerprint: "a",
    catalogHash: "c",
    nonceHash: "n",
    expiresAt,
    createdAt,
  };
}

describe("store.pruneExpired", () => {
  it("scrubs an already-expired confirmation saved through the public store", () => {
    const store = createStore(":memory:", { encryptionKey: "k", now: () => NOW });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });

    store.savePendingConfirmation({
      ...confirmation("already-expired", session.id, "pending", iso(-DAY_MS), iso(-60_000)),
      status: "expired",
      risk: ["destructive"],
      preview: { secretOperationalDetail: "preview" },
      operation: { secretOperationalDetail: "operation" },
      targetFingerprints: ["sensitive-target"],
      nonceHash: "sensitive-nonce",
      agentState: { secretOperationalDetail: "agent" },
    });

    expect(store.getPendingConfirmation("already-expired")).toMatchObject({
      status: "expired",
      risk: [],
      preview: {},
      operation: {},
      targetFingerprints: [],
      nonceHash: "",
      agentState: undefined,
    });
    store.close();
  });

  it("prunes settled confirmations older than 30d and long-expired pendings; keeps recent + live ones", async () => {
    const store = createStore(":memory:", { encryptionKey: "k", now: () => NOW });
    // pending_confirmations FK-references a real chat session.
    const s = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" }).id;
    store.savePendingConfirmation(confirmation("old-used", s, "succeeded", iso(-31 * DAY_MS), iso(-31 * DAY_MS)));
    store.savePendingConfirmation(confirmation("new-used", s, "succeeded", iso(-1 * DAY_MS), iso(-1 * DAY_MS)));
    store.savePendingConfirmation(confirmation("stale-pending", s, "pending", iso(-40 * DAY_MS), iso(-39 * DAY_MS)));
    store.savePendingConfirmation(confirmation("live-pending", s, "pending", iso(-60_000), iso(5 * 60_000)));

    const counts = await store.pruneExpired(NOW.toISOString());
    expect(counts.pendingConfirmations).toBe(2);
    expect(store.getPendingConfirmation("old-used")).toBeUndefined();
    expect(store.getPendingConfirmation("new-used")).toBeDefined();
    expect(store.getPendingConfirmation("stale-pending")).toBeUndefined();
    expect(store.getPendingConfirmation("live-pending")).toBeDefined();
    expect(store.countPendingConfirmations(s, NOW.toISOString())).toBe(1);
    store.close();
  });

  it("expires and scrubs every due confirmation in max-500 batches and counts the transitions", async () => {
    const store = createStore(":memory:", { encryptionKey: "k", now: () => NOW });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    for (let index = 0; index < 501; index += 1) {
      store.savePendingConfirmation({
        ...confirmation(
          `due-${index}`,
          session.id,
          "pending",
          iso(-DAY_MS),
          iso(-60_000),
        ),
        preview: { secretOperationalDetail: `preview-${index}` },
        operation: { secretOperationalDetail: `operation-${index}` },
        agentState: { secretOperationalDetail: `agent-${index}` },
      });
    }

    const counts = await store.pruneExpired(NOW.toISOString());

    expect(counts.expiredConfirmations).toBe(501);
    expect(counts.expiredTotal).toBe(501);
    expect(counts.deletedTotal).toBe(0);
    expect(counts.total).toBe(501);
    expect(counts.batches).toBeGreaterThanOrEqual(2);
    expect(counts.backlog).toBe(false);
    expect(store.getPendingConfirmation("due-500")).toMatchObject({
      status: "expired",
      operation: {},
      nonceHash: "",
      agentState: undefined,
    });
    store.close();
  });

  it("counts expiry transitions toward the 10,000-row pass cap and backlog", async () => {
    const store = createStore(":memory:", { encryptionKey: "k", now: () => NOW });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    for (let index = 0; index < 10_001; index += 1) {
      store.savePendingConfirmation(confirmation(
        `backlog-due-${index}`,
        session.id,
        "pending",
        iso(-DAY_MS),
        iso(-60_000),
      ));
    }

    const first = await store.pruneExpired(NOW.toISOString());
    expect(first.expiredConfirmations).toBe(10_000);
    expect(first.total).toBe(10_000);
    expect(first.backlog).toBe(true);

    const second = await store.pruneExpired(NOW.toISOString());
    expect(second.expiredConfirmations).toBe(1);
    expect(second.total).toBe(1);
    expect(second.backlog).toBe(false);
    store.close();
  }, 15_000);

  it("retains referenced intent capabilities, then deletes their literal/span JSON after references expire", async () => {
    const clock = { value: new Date(NOW.getTime() - 31 * DAY_MS) };
    const store = createStore(":memory:", { encryptionKey: "k", now: () => clock.value });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const authoredSource = "Create tag Žuto";
    const literal = {
      startByte: Buffer.byteLength("Create tag ", "utf8"),
      endByte: Buffer.byteLength(authoredSource, "utf8"),
      text: "Žuto",
    };
    const capability = buildAllowIntentCapabilityV1({
      authoredSource,
      catalogHash: "catalog",
      writeActions: [{
        actionName: "clockify_tags_create",
        sourceSpans: [literal],
        literalConstraints: [{ path: "name", value: "Žuto", sourceSpan: literal }],
      }],
    });
    const createCapability = (id: string, requestId: string) => store.createIntentCapability({
      id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      sessionId: session.id,
      requestId,
      authoredSource,
      capability,
    });
    const orphan = createCapability("capability-orphan", "request-orphan");
    const referenced = createCapability("capability-referenced", "request-referenced");

    clock.value = NOW;
    const operationId = "operation-capability-reference";
    const pending = createPendingConfirmation({
      id: "confirmation-capability-reference",
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      risk: ["high_risk_write"],
      preview: {},
      operation: { operationId, actionName: "clockify_tags_create" },
      sessionSecret: "secret",
      capabilityId: referenced.id,
      capabilityHash: referenced.capabilityHash,
      actionFingerprint: "action",
      catalogHash: "catalog",
      now: clock.value,
    }).record;
    store.savePendingConfirmation(pending);
    store.prepareOperationRun({
      id: operationId,
      requestId: referenced.requestId,
      confirmationId: pending.id,
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "clockify_tags_create",
      actionFingerprint: "action",
      catalogHash: "catalog",
      operationHash: "operation",
      capabilityId: referenced.id,
      capabilityHash: referenced.capabilityHash,
    });

    const first = await store.pruneExpired(NOW.toISOString());
    expect(first.intentCapabilities).toBe(1);
    expect(store.getIntentCapability(orphan.id, {
      workspaceId: "ws-1", adminUserId: "admin-1", sessionId: session.id,
      requestId: orphan.requestId, requestHash: orphan.requestHash, catalogHash: orphan.catalogHash,
    })).toBeUndefined();
    expect(store.getIntentCapabilityForOperation({
      operationId, workspaceId: "ws-1", adminUserId: "admin-1", sessionId: session.id,
      capabilityId: referenced.id, capabilityHash: referenced.capabilityHash,
    })).toEqual(referenced);

    clock.value = new Date(NOW.getTime() + 31 * DAY_MS);
    const eventual = await store.pruneExpired(clock.value.toISOString());
    expect(eventual.pendingConfirmations).toBe(1);
    expect(eventual.operationRuns).toBe(1);
    expect(eventual.intentCapabilities).toBe(1);
    expect(store.getIntentCapability(referenced.id, {
      workspaceId: "ws-1", adminUserId: "admin-1", sessionId: session.id,
      requestId: referenced.requestId, requestHash: referenced.requestHash, catalogHash: referenced.catalogHash,
    })).toBeUndefined();
    store.close();
  });

  it("prunes idempotency keys past retention (and retention stays ≥ the dedupe window)", async () => {
    expect(IDEMPOTENCY_RETENTION_MS).toBeGreaterThan(IDEMPOTENCY_WINDOW_MS);
    const store = createStore(":memory:", { encryptionKey: "k", now: () => NOW });
    const receipt = successReceipt({ action: "x" });
    const oldRef = store.recordActionResult({ workspaceId: "ws-1", adminUserId: "admin-1", actionName: "x", status: "succeeded", result: { kind: "receipt", receipt } });
    const freshRef = store.recordActionResult({ workspaceId: "ws-1", adminUserId: "admin-1", actionName: "x", status: "succeeded", result: { kind: "receipt", receipt } });
    store.recordIdempotency("old", "ws-1", "admin-1", oldRef, NOW.getTime() - 2 * 60 * 60 * 1000);
    store.recordIdempotency("fresh", "ws-1", "admin-1", freshRef, NOW.getTime() - 5 * 60 * 1000);

    const counts = await store.pruneExpired(NOW.toISOString());
    expect(counts.idempotencyKeys).toBe(1);
    // The fresh key still dedupes inside the window.
    expect(store.lookupIdempotency("fresh", "ws-1", "admin-1", NOW.getTime() - IDEMPOTENCY_WINDOW_MS)).toBeDefined();
    store.close();
  });

  it("prunes terminal undo records older than 30d and expires an old available one", async () => {
    const past = { value: new Date(NOW.getTime() - 31 * DAY_MS) };
    const store = createStore(":memory:", { encryptionKey: "k", now: () => past.value });
    const base = { sessionId: "s1", workspaceId: "ws-1", adminUserId: "admin-1", actionName: "x", reversal: [] };
    const undoneId = store.recordUndoable(base);
    store.markUndoExecuting(undoneId);
    store.settleUndo(undoneId, "undone", [], { ok: true });
    const availableId = store.recordUndoable(base); // created 31d ago, still available

    const counts = await store.pruneExpired(NOW.toISOString());
    expect(counts.undoRecords).toBe(2);
    expect(store.getUndoRecord(undoneId)).toBeUndefined();
    expect(store.getUndoRecord(availableId)).toBeUndefined();
    store.close();
  });

  it("scrubs reversal payloads when an available undo expires and counts the transition", async () => {
    const clock = { value: new Date(NOW.getTime() - DAY_MS) };
    const store = createStore(":memory:", { encryptionKey: "k", now: () => clock.value });
    const undoId = store.recordUndoable({
      sessionId: "s1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "clockify_tags_create",
      reversal: [{ type: "tag", id: "tag-sensitive", name: "Sensitive" }],
    });
    clock.value = NOW;

    const counts = await store.pruneExpired(NOW.toISOString());

    expect(counts.expiredUndoRecords).toBe(1);
    expect(counts.expiredTotal).toBe(1);
    expect(counts.deletedTotal).toBe(0);
    expect(store.getUndoRecord(undoId)).toMatchObject({
      status: "expired",
      reversal: [],
      remaining: [],
    });
    store.close();
  });

  it("expires and accounts for an undo exactly at its expiry boundary", async () => {
    const clock = { value: new Date(NOW.getTime() - 30 * 60 * 1000) };
    const store = createStore(":memory:", { encryptionKey: "k", now: () => clock.value });
    const undoId = store.recordUndoable({
      sessionId: "s1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "clockify_tags_create",
      reversal: [{ type: "tag", id: "tag-boundary", name: "Boundary" }],
    });
    clock.value = NOW;

    const counts = await store.pruneExpired(NOW.toISOString());

    expect(counts.expiredUndoRecords).toBe(1);
    expect(counts.expiredTotal).toBe(1);
    expect(counts.deletedTotal).toBe(0);
    expect(counts.total).toBe(1);
    expect(store.getUndoRecord(undoId)).toMatchObject({
      status: "expired",
      reversal: [],
      remaining: [],
    });
    store.close();
  });

  it("prunes an abandoned executing undo after the retention window", async () => {
    const clock = { value: new Date(NOW.getTime() - 31 * DAY_MS) };
    const store = createStore(":memory:", { encryptionKey: "k", now: () => clock.value });
    const undoId = store.recordUndoable({
      sessionId: "s1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "clockify_tags_create",
      reversal: [{ type: "tag", id: "tag-1" }],
    });
    expect(store.markUndoExecuting(undoId)).toBe(true);
    clock.value = NOW;

    const counts = await store.pruneExpired(NOW.toISOString());
    expect(counts.undoRecords).toBe(1);
    expect(store.getUndoRecord(undoId)).toBeUndefined();
    store.close();
  });

  it("records + lists turn telemetry (since-bounded) and prunes rows past 30d", async () => {
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

    const counts = await store.pruneExpired(NOW.toISOString());
    expect(counts.turnTelemetry).toBe(1);
    expect(store.listTurnTelemetry("ws-1", "admin-1")).toHaveLength(1);
    store.close();
  });

  it("hard-deletes expired binary artifacts", async () => {
    const clock = { value: new Date(NOW.getTime() - 2 * 60 * 60 * 1000) };
    const store = createStore(":memory:", { encryptionKey: "k", now: () => clock.value });
    const expired = store.createArtifact({
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      sessionId: "session-1",
      contentType: "application/pdf",
      filename: "old.pdf",
      bytes: new Uint8Array([1, 2, 3]),
    });
    clock.value = NOW;
    const live = store.createArtifact({
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      sessionId: "session-1",
      contentType: "application/pdf",
      filename: "live.pdf",
      bytes: new Uint8Array([4, 5, 6]),
    });

    const counts = await store.pruneExpired(NOW.toISOString());
    expect(counts.artifacts).toBe(1);
    expect(store.getArtifact(expired.id, "ws-1", "admin-1", "session-1")).toBeUndefined();
    expect(store.getArtifact(live.id, "ws-1", "admin-1", "session-1")).toBeDefined();
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
    // The chat/audit retention DELETEs (added for marketplace data-minimization)
    // delete on the bare created_at column — they need their own narrow index.
    expect(plan.chatMessages).not.toMatch(/SCAN chat_messages/);
    expect(plan.auditEvents).not.toMatch(/SCAN audit_events/);
    expect(plan.artifacts).not.toMatch(/SCAN artifacts/);
    expect(plan.intentCapabilities).not.toMatch(/SCAN intent_capabilities/);
    store.close();
  });

  it("prunes chat_messages + audit_events older than the default 90d window, keeps recent rows", async () => {
    // Data-retention (marketplace/GDPR): chat transcripts + the audit log are no
    // longer kept forever. Default window is 90 days — well above the recap (24h /
    // 30d max) and metrics (30d default) read windows, so those features are intact.
    const clock = { value: new Date(NOW.getTime() - 100 * DAY_MS) };
    const store = createStore(":memory:", { encryptionKey: "k", now: () => clock.value });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const audit = {
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "clockify_tags_create",
      risk: ["safe_write" as const],
      receipt: successReceipt({ action: "clockify_tags_create" }),
    };
    // Old rows (100d ago) — past the 90d window.
    store.addMessage({ sessionId: session.id, workspaceId: "ws-1", adminUserId: "admin-1", role: "user", content: "old" });
    store.addAuditEvent(audit);
    // Recent rows (today) — within the window.
    clock.value = NOW;
    store.addMessage({ sessionId: session.id, workspaceId: "ws-1", adminUserId: "admin-1", role: "user", content: "new" });
    store.addAuditEvent(audit);

    const counts = await store.pruneExpired(NOW.toISOString());
    expect(counts.chatMessages).toBe(1);
    expect(counts.auditEvents).toBe(1);
    expect(store.getRecentMessages(session.id, 10)).toHaveLength(1); // only "new" survives
    expect(store.listActionOutcomes("ws-1", "admin-1")).toHaveLength(1);
    store.close();
  });

  it("deletes a canonical action result only after its final durable reference expires", async () => {
    const clock = { value: new Date(NOW.getTime() - 100 * DAY_MS) };
    const store = createStore(":memory:", { encryptionKey: "k", now: () => clock.value });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const receipt = successReceipt({ action: "clockify_tags_create" });
    const ref = store.recordActionResult({
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      sessionId: session.id,
      actionName: "clockify_tags_create",
      status: "succeeded",
      result: { kind: "receipt", receipt },
    });
    store.addAuditEvent({
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      sessionId: session.id,
      actionName: "clockify_tags_create",
      risk: ["safe_write"],
      resultRef: ref,
    });
    clock.value = NOW;
    store.addMessage({
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      role: "assistant",
      content: "Created",
      resultLinks: [{ kind: "action_result", ref }],
    });

    await store.pruneExpired(NOW.toISOString());
    expect(store.getActionResult(ref.id)).toBeDefined();

    clock.value = new Date(NOW.getTime() + 100 * DAY_MS);
    await store.pruneExpired(clock.value.toISOString());
    expect(store.getActionResult(ref.id)).toBeUndefined();
    store.close();
  });

  it("caps one pass at 10,000 rows and reports backlog for a scheduled continuation", async () => {
    const clock = { value: new Date(NOW.getTime() - 100 * DAY_MS) };
    const store = createStore(":memory:", { encryptionKey: "k", now: () => clock.value });
    const audit = {
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "clockify_tags_create",
      risk: ["safe_write" as const],
      receipt: successReceipt({ action: "clockify_tags_create" }),
    };
    for (let index = 0; index < 10_025; index += 1) store.addAuditEvent(audit);
    clock.value = NOW;

    const first = await store.pruneExpired(NOW.toISOString());
    expect(first.total).toBe(10_000);
    expect(first.backlog).toBe(true);
    expect(first.batches).toBeGreaterThan(1);
    let auditEvents = first.auditEvents;
    let actionResults = first.actionResults;
    let pass = first;
    while (pass.backlog) {
      pass = await store.pruneExpired(NOW.toISOString());
      auditEvents += pass.auditEvents;
      actionResults += pass.actionResults;
    }
    expect(auditEvents).toBe(10_025);
    expect(actionResults).toBe(10_025);
    store.close();
  }, 15_000);

  it("honors a custom retentionDays window", async () => {
    // A 45d-old message is KEPT under the 90d default but PRUNED under a 30d override.
    const clock = { value: new Date(NOW.getTime() - 45 * DAY_MS) };
    const store = createStore(":memory:", { encryptionKey: "k", now: () => clock.value, retentionDays: 30 });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    store.addMessage({ sessionId: session.id, workspaceId: "ws-1", adminUserId: "admin-1", role: "user", content: "45d-old" });
    clock.value = NOW;
    store.addMessage({ sessionId: session.id, workspaceId: "ws-1", adminUserId: "admin-1", role: "user", content: "today" });

    const counts = await store.pruneExpired(NOW.toISOString());
    expect(counts.chatMessages).toBe(1); // 45d > 30d → pruned
    expect(store.getRecentMessages(session.id, 10)).toHaveLength(1);
    store.close();
  });

  it("persists bounded retention-run evidence including passive WAL checkpoint metrics", async () => {
    const path = join(tmpdir(), `ai-assistant-retention-${randomUUID()}.sqlite`);
    try {
      const store = createStore(path, { encryptionKey: "k", now: () => NOW }) as TestStore;
      await store.pruneExpired(NOW.toISOString());
      store.close();

      const reopened = createStore(path, { encryptionKey: "k", now: () => NOW }) as TestStore;
      const metrics = reopened.retentionMetricsForTest();
      expect(metrics).toHaveLength(1);
      expect(metrics[0]).toMatchObject({
        recordedAt: NOW.toISOString(),
        deletedCount: 0,
        expiredCount: 0,
        backlog: false,
      });
      expect(metrics[0]?.durationMs).toBeGreaterThanOrEqual(0);
      expect(metrics[0]?.walCheckpoint.mode).toBe("PASSIVE");
      expect(Number.isInteger(metrics[0]?.walCheckpoint.busy)).toBe(true);
      expect(Number.isInteger(metrics[0]?.walCheckpoint.log)).toBe(true);
      expect(Number.isInteger(metrics[0]?.walCheckpoint.checkpointed)).toBe(true);
      reopened.close();
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });
});
