import { describe, expect, it } from "vitest";
import {
  cancelPending,
  confirmPending,
  createPendingConfirmation,
  hashOperation,
  type PendingConfirmationRecord,
} from "../../src/harness/confirmations.js";

const SECRET = "session-secret";

function makePending(now: Date, overrides: Partial<Parameters<typeof createPendingConfirmation>[0]> = {}) {
  return createPendingConfirmation({
    sessionId: "sess-1",
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    risk: ["destructive"],
    preview: { label: "Delete project Acme" },
    operation: { action: "clockify_delete_entity", entityType: "project", id: "p1" },
    sessionSecret: SECRET,
    now,
    ...overrides,
  });
}

describe("confirmations", () => {
  it("stores the operation hash and a one-use nonce", () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const created = makePending(now);
    expect(created.record.status).toBe("pending");
    expect(created.record.operationHash).toBe(
      hashOperation({ action: "clockify_delete_entity", entityType: "project", id: "p1" }),
    );
    expect(created.nonce).toBeTruthy();
    // raw nonce is never stored — only its hash
    expect(created.record.nonceHash).not.toContain(created.nonce);
  });

  it("confirms with the right admin/session/nonce and marks it used", () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const created = makePending(now);
    const result = confirmPending({
      record: created.record,
      sessionId: "sess-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      nonce: created.nonce,
      sessionSecret: SECRET,
      now,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.status).toBe("used");
      expect(result.record.usedAt).toBeTruthy();
    }
  });

  it("rejects a wrong admin", () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const created = makePending(now);
    const result = confirmPending({
      record: created.record,
      sessionId: "sess-1",
      workspaceId: "ws-1",
      adminUserId: "attacker",
      nonce: created.nonce,
      sessionSecret: SECRET,
      now,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a wrong workspace", () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const created = makePending(now);
    const result = confirmPending({
      record: created.record,
      sessionId: "sess-1",
      workspaceId: "ws-2",
      adminUserId: "admin-1",
      nonce: created.nonce,
      sessionSecret: SECRET,
      now,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a wrong nonce", () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const created = makePending(now);
    const result = confirmPending({
      record: created.record,
      sessionId: "sess-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      nonce: "not-the-nonce",
      sessionSecret: SECRET,
      now,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an expired preview", () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const created = makePending(now, { ttlMs: 5 * 60 * 1000 });
    const later = new Date(now.getTime() + 6 * 60 * 1000);
    const result = confirmPending({
      record: created.record,
      sessionId: "sess-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      nonce: created.nonce,
      sessionSecret: SECRET,
      now: later,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("expired");
  });

  it("cannot be confirmed twice", () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const created = makePending(now);
    const first = confirmPending({
      record: created.record,
      sessionId: "sess-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      nonce: created.nonce,
      sessionSecret: SECRET,
      now,
    });
    expect(first.ok).toBe(true);
    const usedRecord: PendingConfirmationRecord = first.ok ? first.record : created.record;
    const second = confirmPending({
      record: usedRecord,
      sessionId: "sess-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      nonce: created.nonce,
      sessionSecret: SECRET,
      now,
    });
    expect(second.ok).toBe(false);
  });

  it("cancel marks the preview cancelled", () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const created = makePending(now);
    const result = cancelPending({
      record: created.record,
      sessionId: "sess-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      now,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.status).toBe("cancelled");
  });

  it("cannot confirm a cancelled preview", () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const created = makePending(now);
    const cancelled = cancelPending({
      record: created.record,
      sessionId: "sess-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      now,
    });
    const record = cancelled.ok ? cancelled.record : created.record;
    const result = confirmPending({
      record,
      sessionId: "sess-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      nonce: created.nonce,
      sessionSecret: SECRET,
      now,
    });
    expect(result.ok).toBe(false);
  });
});
