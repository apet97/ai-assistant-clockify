import { describe, expect, it } from "vitest";
import { executeAction, commitConfirmedOperation } from "../../src/harness/actions.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import type { IdempotencyLedger } from "../../src/harness/idempotency.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext, ConfirmableOperation } from "../../src/harness/catalog.js";
import type { SuccessReceipt } from "../../src/harness/receipts.js";

function memoryLedger(): IdempotencyLedger {
  const map = new Map<string, SuccessReceipt>();
  return { lookup: (k) => map.get(k), record: (k, r) => void map.set(k, r) };
}

function ctxWith(fake: FakeWorkspace, ledger?: IdempotencyLedger): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
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

  it("dedupes by SEMANTIC intent — the auto-generated number/dates don't defeat it", async () => {
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

    expect(fake.counts.createInvoice).toBe(1); // still deduped — number/dates are excluded from the key
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

  it("without a ledger in context, behaves exactly as before (no dedup)", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "c-qwen", name: "qwen" }] });
    const ctx = ctxWith(fake); // no ledger
    const op = await previewInvoice(ctx, "qwen");
    await commitConfirmedOperation(ctx, op);
    await commitConfirmedOperation(ctx, op);
    expect(fake.counts.createInvoice).toBe(2); // unchanged legacy behavior
  });
});
