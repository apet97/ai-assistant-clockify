import { describe, expect, it, vi } from "vitest";
import { executeAction, commitConfirmedOperation } from "../../src/harness/actions.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import type { IdempotencyLedger } from "../../src/harness/idempotency.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext, AtomicIdempotencyLedger, ConfirmableOperation } from "../../src/harness/catalog.js";
import type { SuccessReceipt } from "../../src/harness/receipts.js";
import { AmbiguousWriteOutcome } from "../../src/clockify/write-outcome.js";

function memoryLedger(): IdempotencyLedger {
  const map = new Map<string, SuccessReceipt>();
  return { lookup: (k) => map.get(k), record: (k, r) => void map.set(k, r) };
}

function ctxWith(
  fake: FakeWorkspace,
  ledger?: IdempotencyLedger,
  scope?: { workspaceId?: string; adminUserId?: string },
): ActionContext {
  return {
    workspaceId: scope?.workspaceId ?? "ws-1",
    adminUserId: scope?.adminUserId ?? "admin-1",
    policy: defaultAdminPolicy(),
    clockify: fake.client,
    now: () => new Date("2026-06-05T00:00:00.000Z"),
    idempotency: ledger,
  };
}

async function previewInvoice(ctx: ActionContext, clientName: string): Promise<ConfirmableOperation> {
  const result = await executeAction({
    actionName: "clockify_invoices_create",
    args: { clientName, items: [{ description: "charge", quantity: 1, amount: 1000 }] },
    context: ctx,
  });
  if (result.kind !== "preview") throw new Error("expected a preview");
  return result.operation;
}

describe("idempotent commits (Phase 5)", () => {
  it("keeps the operation claim after an ambiguous write so it cannot be retried automatically", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "c-qwen", name: "qwen" }] });
    const clockify = new Proxy(fake.client, {
      get(target, prop, receiver) {
        if (prop === "createInvoice") {
          return async () => {
            throw new AmbiguousWriteOutcome("POST", "/workspaces/ws-1/invoices", "socket closed");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    let claimed = false;
    const release = vi.fn();
    const ledger: AtomicIdempotencyLedger = {
      lookup: () => undefined,
      record: () => undefined,
      claim: () => {
        if (claimed) return "in_flight";
        claimed = true;
        return "won";
      },
      lookupCompleted: () => undefined,
      fill: vi.fn(),
      release,
    };
    const ctx: ActionContext = { ...ctxWith(fake, ledger), clockify };
    const op = await previewInvoice(ctx, "qwen");

    const first = await commitConfirmedOperation(ctx, op);
    const second = await commitConfirmedOperation(ctx, op);

    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.code).toBe("commit_outcome_unknown");
    expect(release).not.toHaveBeenCalled();
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("commit_in_progress");
  });

  it("does not create a duplicate invoice when the same intent is confirmed twice", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "c-qwen", name: "qwen" }] });
    const ledger = memoryLedger();
    const ctx = ctxWith(fake, ledger);
    const op = await previewInvoice(ctx, "qwen");

    const r1 = await commitConfirmedOperation(ctx, op);
    const r2 = await commitConfirmedOperation(ctx, op);

    expect(r1.ok && r2.ok).toBe(true);
    expect(fake.counts.createInvoice).toBe(1); // the second confirm did NOT create a second invoice
    if (r2.ok) expect((r2.warnings ?? []).some((w) => w.code === "idempotent_replay")).toBe(true);
  });

  it("dedupes one stored operation even if volatile invoice fields are reconstructed differently", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "c-qwen", name: "qwen" }] });
    const ledger = memoryLedger();
    const ctx = ctxWith(fake, ledger);
    const op1 = await previewInvoice(ctx, "qwen");
    // a second preview of the same request gets a different number + dates...
    const payload1 = op1.payload as { input: Record<string, unknown>; items: unknown };
    const op2: ConfirmableOperation = {
      ...op1,
      payload: {
        ...payload1,
        input: { ...payload1.input, number: "INV-TOTALLY-DIFFERENT", issuedDate: "2099-01-01T00:00:00.000Z" },
      },
    };

    await commitConfirmedOperation(ctx, op1);
    await commitConfirmedOperation(ctx, op2);

    expect(fake.counts.createInvoice).toBe(1); // same operation identity, so still one dispatch
  });

  it("permits intentionally identical invoices from independent operation ids", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "c-qwen", name: "qwen" }] });
    const ledger = memoryLedger();
    const ctx = ctxWith(fake, ledger);
    const first = await previewInvoice(ctx, "qwen");
    const second = await previewInvoice(ctx, "qwen");

    await commitConfirmedOperation(ctx, first);
    await commitConfirmedOperation(ctx, second);

    expect(fake.counts.createInvoice).toBe(2);
  });

  it("creates separate invoices for different clients", async () => {
    const fake = createFakeWorkspace({
      clients: [
        { id: "c-qwen", name: "qwen" },
        { id: "c-acme", name: "acme" },
      ],
    });
    const ledger = memoryLedger();
    const ctx = ctxWith(fake, ledger);
    await commitConfirmedOperation(ctx, await previewInvoice(ctx, "qwen"));
    await commitConfirmedOperation(ctx, await previewInvoice(ctx, "acme"));
    expect(fake.counts.createInvoice).toBe(2);
  });

  it("does NOT replay across admins — the ledger is shared but the scope key is per-admin", async () => {
    // One workspace, one shared ledger. The 10-min dedup window is keyed on
    // (workspace, admin, action, semantic): admin A's prior receipt must never
    // leak into admin B's chat, so B's identical intent creates its OWN invoice.
    const fake = createFakeWorkspace({ clients: [{ id: "c-qwen", name: "qwen" }] });
    const ledger = memoryLedger();
    const ctxA = ctxWith(fake, ledger, { adminUserId: "admin-1" });
    const ctxB = ctxWith(fake, ledger, { adminUserId: "admin-2" });

    const rA = await commitConfirmedOperation(ctxA, await previewInvoice(ctxA, "qwen"));
    const rB = await commitConfirmedOperation(ctxB, await previewInvoice(ctxB, "qwen"));

    expect(rA.ok && rB.ok).toBe(true);
    expect(fake.counts.createInvoice).toBe(2); // each admin got their own invoice
    if (rB.ok) expect((rB.warnings ?? []).some((w) => w.code === "idempotent_replay")).toBe(false);
  });

  it("does NOT replay across workspaces — the scope key is per-workspace", async () => {
    // Same admin, same intent, same shared ledger, but two different workspaces.
    const fake = createFakeWorkspace({ clients: [{ id: "c-qwen", name: "qwen" }] });
    const ledger = memoryLedger();
    const ctx1 = ctxWith(fake, ledger, { workspaceId: "ws-1" });
    const ctx2 = ctxWith(fake, ledger, { workspaceId: "ws-2" });

    const r1 = await commitConfirmedOperation(ctx1, await previewInvoice(ctx1, "qwen"));
    const r2 = await commitConfirmedOperation(ctx2, await previewInvoice(ctx2, "qwen"));

    expect(r1.ok && r2.ok).toBe(true);
    expect(fake.counts.createInvoice).toBe(2); // each workspace got its own invoice
    if (r2.ok) expect((r2.warnings ?? []).some((w) => w.code === "idempotent_replay")).toBe(false);
  });

  it("without a ledger in context, behaves exactly as before (no dedup)", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "c-qwen", name: "qwen" }] });
    const ctx = ctxWith(fake); // no ledger
    const op = await previewInvoice(ctx, "qwen");
    await commitConfirmedOperation(ctx, op);
    await commitConfirmedOperation(ctx, op);
    expect(fake.counts.createInvoice).toBe(2); // unchanged legacy behavior
  });

  it("a FAILED commit is not recorded — the retry actually executes and creates the entity exactly once", async () => {
    // A transiently-failing first commit must NOT poison the dedup window:
    // re-confirming the same intent has to run for real, not replay the stale
    // failure as "already completed — no duplicate was created" for an invoice
    // that never existed. Pins the `receipt.ok` guard at actions.ts:146 (only
    // SUCCESSFUL commits are recorded, per idempotency.ts:15-16).
    const fake = createFakeWorkspace({ clients: [{ id: "c-qwen", name: "qwen" }] });
    let createCalls = 0;
    const realCreateInvoice = fake.client.createInvoice.bind(fake.client);
    // Wrap the client so createInvoice throws on its FIRST call only, then works.
    const flakyClient = new Proxy(fake.client, {
      get(target, prop, receiver) {
        if (prop === "createInvoice") {
          return (...args: Parameters<typeof realCreateInvoice>) => {
            createCalls += 1;
            if (createCalls === 1) throw new Error("transient host failure");
            return realCreateInvoice(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    // A spy ledger so we can assert WHAT got recorded, not just the net effect:
    // a failed receipt must never enter the ledger (else the retry would replay it).
    const map = new Map<string, SuccessReceipt>();
    const recorded: SuccessReceipt[] = [];
    const ledger: IdempotencyLedger = {
      lookup: (k) => map.get(k),
      record: (k, r) => {
        recorded.push(r);
        map.set(k, r);
      },
    };
    const ctx: ActionContext = { ...ctxWith(fake, ledger), clockify: flakyClient };
    const op = await previewInvoice(ctx, "qwen");

    const r1 = await commitConfirmedOperation(ctx, op); // first commit fails
    expect(r1.ok).toBe(false); // the failure is surfaced honestly, not swallowed
    expect(recorded).toHaveLength(0); // the failed attempt was NOT written to the ledger

    const r2 = await commitConfirmedOperation(ctx, op); // retry must run for real

    expect(r2.ok).toBe(true); // the retry succeeded — the failure didn't poison the ledger
    expect(createCalls).toBe(2); // both confirms reached the host (first threw, second created)
    expect(fake.counts.createInvoice).toBe(1); // exactly one invoice exists
    // Only the successful retry was recorded, and it is a real commit — NOT a replay.
    expect(recorded).toHaveLength(1);
    expect(recorded.every((r) => r.ok)).toBe(true);
    if (r2.ok) expect((r2.warnings ?? []).some((w) => w.code === "idempotent_replay")).toBe(false);
  });
});
