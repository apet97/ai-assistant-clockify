import { afterEach, describe, expect, it } from "vitest";
import { createStore, type Store, type TestStore } from "../../src/db/store.js";
import { createPendingConfirmation } from "../../src/harness/confirmations.js";
import { buildMetrics } from "../../src/metrics/metrics.js";

let store: Store | undefined;
afterEach(() => store?.close());

function seed(s: Store): void {
  s.addAuditEvent({
    workspaceId: "ws-1",
    adminUserId: "a-1",
    actionName: "clockify_tags_create",
    risk: ["safe_write"],
    receipt: { ok: true, action: "clockify_tags_create" },
  });
  s.addAuditEvent({
    workspaceId: "ws-1",
    adminUserId: "a-1",
    actionName: "clockify_invoices_create",
    risk: ["billing"],
    receipt: { ok: false, action: "clockify_invoices_create", code: "invalid_args", message: "bad" },
  });
  // a different admin / workspace must NOT bleed into the scope
  s.addAuditEvent({
    workspaceId: "ws-1",
    adminUserId: "other-admin",
    actionName: "clockify_status",
    risk: ["read"],
    receipt: { ok: true, action: "clockify_status" },
  });
}

describe("store.listActionOutcomes", () => {
  it("returns parsed {actionName, ok, code} scoped to the workspace + admin", () => {
    store = createStore(":memory:");
    seed(store);
    const out = store.listActionOutcomes("ws-1", "a-1");
    expect(out.length).toBe(2); // not the other admin's event
    expect(out).toContainEqual({ actionName: "clockify_tags_create", ok: true });
    expect(out.find((o) => o.actionName === "clockify_invoices_create")).toEqual({
      actionName: "clockify_invoices_create",
      ok: false,
      code: "invalid_args",
    });
  });

  it("honors the `since` lower bound", () => {
    store = createStore(":memory:");
    seed(store);
    expect(store.listActionOutcomes("ws-1", "a-1", "2999-01-01T00:00:00.000Z")).toEqual([]);
    expect(store.listActionOutcomes("ws-1", "a-1", "2000-01-01T00:00:00.000Z").length).toBe(2);
  });
});

describe("store.listActionOutcomes (efficiency: index seek + scalar extract)", () => {
  it("returns identical outcomes when a large receipt is present (characterization)", () => {
    store = createStore(":memory:");
    const s = store;
    s.addAuditEvent({
      workspaceId: "ws-1",
      adminUserId: "a-1",
      actionName: "clockify_tags_create",
      risk: ["safe_write"],
      // A deliberately large receipt: the method only needs ok/code, so the full
      // document must never be JSON.parse'd into JS for these two scalars.
      receipt: { ok: true, action: "clockify_tags_create", bloat: "x".repeat(50_000) },
    });
    s.addAuditEvent({
      workspaceId: "ws-1",
      adminUserId: "a-1",
      actionName: "clockify_invoices_create",
      risk: ["billing"],
      receipt: {
        ok: false,
        action: "clockify_invoices_create",
        code: "invalid_args",
        message: "y".repeat(50_000),
      },
    });
    const out = s.listActionOutcomes("ws-1", "a-1");
    expect(out).toContainEqual({ actionName: "clockify_tags_create", ok: true });
    expect(out).toContainEqual({
      actionName: "clockify_invoices_create",
      ok: false,
      code: "invalid_args",
    });
  });

  it("the since-bounded action-outcomes query plans an index range seek on created_at", () => {
    store = createStore(":memory:");
    const plan = (store as TestStore)
      .explainActionOutcomesPlan("ws-1", "a-1", "2026-06-11T00:00:00.000Z")
      .join("\n");
    // The OR-guarded form `(? IS NULL OR created_at >= ?)` defeats the optimizer:
    // it seeks only (workspace_id=? AND admin_user_id=?). The index range column
    // must be live when a `since` is supplied.
    expect(plan).toMatch(/idx_audit_events_workspace_admin_created/);
    expect(plan).toMatch(/created_at>\?/);
  });

  it("the unbounded action-outcomes query needs no since param at all", () => {
    store = createStore(":memory:");
    const plan = (store as TestStore).explainActionOutcomesPlan("ws-1", "a-1").join("\n");
    // No created_at predicate when unbounded — but still index-scoped to ws+admin.
    expect(plan).toMatch(/idx_audit_events_workspace_admin_created/);
    expect(plan).not.toMatch(/created_at/);
  });
});

describe("store.listConfirmationOutcomes (expired derivation)", () => {
  it("reports a pending preview past its TTL as expired, not pending", () => {
    // Drive the store clock so the saved row is genuinely past its 5-min TTL.
    let clock = new Date("2026-06-11T00:00:00.000Z");
    store = createStore(":memory:", { now: () => clock });

    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "a-1" });
    const { record } = createPendingConfirmation({
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "a-1",
      risk: ["safe_write"],
      preview: { kind: "create" },
      operation: { action: "clockify_tags_create" },
      sessionSecret: "secret",
      now: clock,
      ttlMs: 5 * 60 * 1000,
    });
    store.savePendingConfirmation(record);

    // Advance past the TTL: the row is still status='pending' in the DB.
    clock = new Date("2026-06-11T01:00:00.000Z");

    const statuses = store.listConfirmationOutcomes("ws-1", "a-1");
    const metrics = buildMetrics([], statuses, clock.toISOString());

    expect(metrics.confirmations.expired).toBe(1);
    expect(metrics.confirmations.pending).toBe(0);
    // It must NOT be miscounted as confirmed/cancelled/failed either.
    expect(metrics.confirmations.previewed).toBe(1);
    expect(metrics.confirmations.confirmed).toBe(0);
  });
});
