import { describe, expect, it } from "vitest";
import {
  cancelPending,
  confirmPending,
  createPendingConfirmation,
  hashOperation,
  rotatePendingNonce,
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

describe("rotatePendingNonce (session restore)", () => {
  const now = new Date("2026-06-05T00:00:00.000Z");
  const base = { sessionId: "sess-1", workspaceId: "ws-1", adminUserId: "admin-1", sessionSecret: SECRET, now };

  it("issues a NEW one-use nonce: the old plaintext stops working, the new one confirms; TTL byte-unchanged", () => {
    const created = makePending(now);
    const rotated = rotatePendingNonce({ record: created.record, ...base });
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    expect(rotated.nonce).not.toBe(created.nonce);
    expect(rotated.record.expiresAt).toBe(created.record.expiresAt); // never extended
    expect(rotated.record.nonceHash).not.toBe(created.record.nonceHash);

    // The OLD nonce must be dead against the rotated record.
    const stale = confirmPending({ record: rotated.record, ...base, nonce: created.nonce });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("invalid_confirmation");

    // The NEW nonce confirms.
    const fresh = confirmPending({ record: rotated.record, ...base, nonce: rotated.nonce });
    expect(fresh.ok).toBe(true);
  });

  it("refuses non-pending, expired, foreign-session, and tampered records (same gate order as confirm)", () => {
    const used = makePending(now);
    used.record.status = "used";
    const r1 = rotatePendingNonce({ record: used.record, ...base });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.code).toBe("not_pending");

    const foreign = makePending(now);
    const r2 = rotatePendingNonce({ record: foreign.record, ...base, sessionId: "sess-other" });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe("forbidden");

    const old = makePending(new Date(now.getTime() - 10 * 60_000));
    const r3 = rotatePendingNonce({ record: old.record, ...base });
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.code).toBe("expired");

    const tampered = makePending(now);
    tampered.record.operation = { action: "clockify_delete_entity", entityType: "project", id: "EVIL" };
    const r4 = rotatePendingNonce({ record: tampered.record, ...base });
    expect(r4.ok).toBe(false);
    if (!r4.ok) expect(r4.code).toBe("operation_mismatch");
  });
});
