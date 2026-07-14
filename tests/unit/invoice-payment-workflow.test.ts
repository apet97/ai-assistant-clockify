import { describe, expect, it } from "vitest";
import { createStore } from "../../src/db/store.js";
import { executeAction, commitConfirmedOperation } from "../../src/harness/actions.js";
import { actionFingerprint, catalogHash } from "../../src/harness/catalog.js";
import type { ActionContext } from "../../src/harness/action.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace, type FakeWorkspaceSeed } from "../helpers/fake-clockify.js";
import type { MutationStepJournal } from "../../src/harness/mutation-contract.js";

function seed(extra: FakeWorkspaceSeed = {}): FakeWorkspaceSeed {
  return {
    invoices: [{ id: "inv1", number: "INV-1", currency: "USD", status: "UNSENT", items: [] }],
    ...extra,
  };
}

function context(fake: FakeWorkspace): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy: defaultAdminPolicy(),
    clockify: fake.client,
    now: () => new Date("2026-06-06T00:00:00.000Z"),
  };
}

async function run(
  fake: FakeWorkspace,
  beforeCommit?: () => void,
  wrapJournal: (journal: MutationStepJournal) => MutationStepJournal = (journal) => journal,
) {
  const result = await executeAction({
    actionName: "clockify_invoices_payments_create",
    args: { invoiceId: "inv1", amount: 50, paymentDate: "2026-06-06", note: "deposit" },
    context: context(fake),
  });
  if (result.kind !== "preview") throw new Error("expected preview");
  const store = createStore(":memory:");
  store.prepareOperationRun({
    id: result.operation.operationId,
    sessionId: "session",
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    actionName: result.operation.actionName,
    actionFingerprint: actionFingerprint(result.operation.actionName)!,
    catalogHash: catalogHash(),
    operationHash: "hash",
    operation: result.operation,
    mutationPlan: result.operation.mutationPlan,
  });
  store.markOperationExecuting(result.operation.operationId);
  beforeCommit?.();
  const receipt = await commitConfirmedOperation({
    ...context(fake),
    mutationJournal: wrapJournal(store.mutationStepJournal(result.operation.operationId)),
  }, result.operation);
  return { receipt, operation: result.operation, store };
}

describe("durable invoice payment recording", () => {
  it("keeps a known POST success successful when the follow-up read fails", async () => {
    const fake = createFakeWorkspace(seed({ failPaymentReadAfterPost: true }));
    const { receipt, operation, store } = await run(fake);
    expect(receipt).toMatchObject({ ok: true, warnings: [{ code: "payment_id_unknown" }] });
    expect(store.listOperationSteps(operation.operationId)).toMatchObject([{ status: "succeeded" }]);
    store.close();
  });

  it("authoritatively reconciles a socket-close-after-apply POST and terminalizes the step", async () => {
    const fake = createFakeWorkspace(seed({
      invoiceFaults: { createInvoicePaymentAtomic: { outcome: "ambiguous", applyBeforeThrow: true } },
    }));
    const { receipt, operation, store } = await run(fake);
    expect(receipt).toMatchObject({ ok: true, changed: { created: [{ type: "payment" }] } });
    expect(store.listOperationSteps(operation.operationId)).toMatchObject([{
      status: "succeeded",
      detail: { authoritativeReconciliation: true },
    }]);
    expect(store.getOperationRun(operation.operationId)?.reconciliation).toMatchObject({ authoritative: true });
    store.close();
  });

  it.each([
    { applyBeforeThrow: false, failure: "record" as const },
    { applyBeforeThrow: true, failure: "record" as const },
    { applyBeforeThrow: true, failure: "settle" as const },
  ])(
    "keeps payment unknown and nonretryable when reconciliation $failure persistence fails (apply=$applyBeforeThrow)",
    async ({ applyBeforeThrow, failure }) => {
      const fake = createFakeWorkspace(seed({
        invoiceFaults: { createInvoicePaymentAtomic: { outcome: "ambiguous", applyBeforeThrow } },
      }));
      let faultCalls = 0;
      const { receipt, operation, store } = await run(fake, undefined, (journal) => ({
          ...journal,
          ...(failure === "record"
            ? { recordReconciliation: () => { faultCalls += 1; throw new Error("record unavailable"); } }
            : { settleReconciledStep: () => { faultCalls += 1; throw new Error("settle unavailable"); } }),
        }));

      expect(receipt).toMatchObject({
        ok: false,
        code: "commit_outcome_unknown",
        recovery: { retryable: false },
      });
      expect(store.listOperationSteps(operation.operationId)[0]).toMatchObject({
        status: "outcome_unknown",
      });
      expect(faultCalls).toBe(1);
      store.close();
    },
  );

  it("leaves an ambiguous unmatched POST unknown and nonretryable", async () => {
    const fake = createFakeWorkspace(seed({
      invoiceFaults: { createInvoicePaymentAtomic: { outcome: "ambiguous" } },
    }));
    const { receipt, operation, store } = await run(fake);
    expect(receipt).toMatchObject({ ok: false, code: "commit_outcome_unknown", recovery: { retryable: false } });
    expect(store.listOperationSteps(operation.operationId)).toMatchObject([{ status: "outcome_unknown" }]);
    store.close();
  });

  it.each([
    { applyBeforeThrow: false, expectedOk: false, expectedStatus: "outcome_unknown" },
    { applyBeforeThrow: true, expectedOk: true, expectedStatus: "succeeded" },
  ])(
    "refreshes and durably binds the payment baseline immediately before dispatch (apply=$applyBeforeThrow)",
    async ({ applyBeforeThrow, expectedOk, expectedStatus }) => {
      const fake = createFakeWorkspace(seed({
        invoiceFaults: { createInvoicePaymentAtomic: { outcome: "ambiguous", applyBeforeThrow } },
      }));
      const { receipt, operation, store } = await run(fake, () => {
        fake.state.invoicePayments.inv1 = [{
          id: "inserted-between-preview-and-confirm",
          amount: 5000,
          paymentDate: "2026-06-06T00:00:00.000Z",
          note: "deposit",
        }];
      });

      expect(receipt.ok).toBe(expectedOk);
      expect(store.listOperationSteps(operation.operationId)[0]).toMatchObject({
        status: expectedStatus,
        detail: {
          preDispatch: {
            strategy: "invoice_payment_baseline",
            ids: ["inserted-between-preview-and-confirm"],
          },
        },
      });
      store.close();
    },
  );

  it.each(["truncated", "read_failed"] as const)(
    "does not dispatch a payment when the immediate baseline is %s",
    async (failure) => {
      const fake = createFakeWorkspace(seed());
      const listPayments = fake.client.listInvoicePayments;
      const { receipt, operation, store } = await run(fake, () => {
        fake.client.listInvoicePayments = failure === "truncated"
          ? async (...args) => ({ ...(await listPayments(...args)), truncated: true })
          : async () => { throw new Error("baseline read failed"); };
      });

      expect(receipt).toMatchObject({ ok: false, code: "payment_baseline_unavailable" });
      expect(fake.counts.createInvoicePaymentAtomic ?? 0).toBe(0);
      expect(store.listOperationSteps(operation.operationId)).toEqual([]);
      store.close();
    },
  );

  it.each([
    {
      label: "multiple exact post-list matches",
      extra: {
        concurrentInvoicePayments: [{
          id: "concurrent",
          amount: 5000,
          paymentDate: "2026-06-06T00:00:00.000Z",
          note: "deposit",
        }],
      } satisfies FakeWorkspaceSeed,
      truncateAfterPreview: false,
    },
    {
      label: "a truncated post-list",
      extra: {} satisfies FakeWorkspaceSeed,
      truncateAfterPreview: true,
    },
  ])("keeps an ambiguous applied POST unknown for $label", async ({ extra, truncateAfterPreview }) => {
    const fake = createFakeWorkspace(seed({
      ...extra,
      invoiceFaults: { createInvoicePaymentAtomic: { outcome: "ambiguous", applyBeforeThrow: true } },
    }));
    const listPayments = fake.client.listInvoicePayments;
    const { receipt, operation, store } = await run(fake, () => {
      if (truncateAfterPreview) {
        let readsAfterPreview = 0;
        fake.client.listInvoicePayments = async (...args) => {
          readsAfterPreview += 1;
          return {
            ...(await listPayments(...args)),
            truncated: readsAfterPreview > 1,
          };
        };
      }
    });
    expect(receipt).toMatchObject({ ok: false, code: "commit_outcome_unknown" });
    expect(store.listOperationSteps(operation.operationId)).toMatchObject([{ status: "outcome_unknown" }]);
    expect(store.getOperationRun(operation.operationId)?.reconciliation).toMatchObject({
      authoritative: false,
    });
    store.close();
  });

  it("does not expose an id for concurrent exact matches after a known successful POST", async () => {
    const fake = createFakeWorkspace(seed({
      concurrentInvoicePayments: [{ id: "concurrent", amount: 5000, paymentDate: "2026-06-06", note: "deposit" }],
    }));
    const { receipt, store } = await run(fake);
    expect(receipt).toMatchObject({ ok: true, warnings: [{ code: "payment_id_unknown" }] });
    if (!receipt.ok) throw new Error("expected success");
    expect(receipt.changed?.created ?? []).toEqual([]);
    store.close();
  });
});
