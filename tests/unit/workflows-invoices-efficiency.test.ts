import { describe, expect, it } from "vitest";
import { executeAction } from "../../src/harness/actions.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext } from "../../src/harness/action.js";
import type { InvoiceDetail } from "../../src/clockify/ports/invoices.js";

const NOW = new Date("2026-06-06T00:00:00.000Z");
function makeContext(fake: FakeWorkspace): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy: defaultAdminPolicy(),
    clockify: fake.client,
    now: () => NOW,
  };
}

/** 20 invoices each carrying a typed line item — enough to exceed the ≤12 scan window. */
function manyTypedInvoices(): InvoiceDetail[] {
  return Array.from({ length: 20 }, (_, i) => ({
    id: `inv${i}`,
    number: `INV-${100 + i}`,
    clientId: "c1",
    currency: "USD" as const,
    status: "UNSENT" as const,
    items: [{ order: 0, description: "x", quantity: 1, unitPrice: 1000, itemType: "Consulting" }],
  }));
}

/**
 * Efficiency invariant (audit efficiency-01): a single invoice line-item preview
 * must not fetch the invoice LIST twice (resolveInvoiceRef + discoverItemTypes
 * each paginated it), and the bounded item-type detail scan must OVERLAP its
 * detail GETs rather than awaiting them one at a time.
 */
describe("invoice item preview efficiency", () => {
  it("items_add issues exactly one listInvoices and overlaps its detail GETs", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "c1", name: "Acme" }], invoices: manyTypedInvoices() });

    // Instrument concurrency: wrap listInvoiceItems so we can observe how many
    // detail GETs are in flight simultaneously. Each call yields to the event
    // loop before resolving, so sequential awaits would peak at 1.
    let inFlight = 0;
    let maxInFlight = 0;
    const realListItems = fake.client.listInvoiceItems.bind(fake.client);
    fake.client.listInvoiceItems = async (id: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await Promise.resolve();
        return await realListItems(id);
      } finally {
        inFlight -= 1;
      }
    };

    const preview = await executeAction({
      actionName: "clockify_invoices_items_add",
      args: { invoiceId: "INV-105", unitPrice: 100, itemType: "Consulting" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);

    // One list fetch — resolveInvoiceRef and discoverItemTypes share it.
    expect(fake.counts.listInvoices).toBe(1);
    // The bounded scan never touches more than the 12 most recent invoices.
    expect(fake.counts.listInvoiceItems ?? 0).toBeLessThanOrEqual(12);
    // The detail GETs overlap rather than running strictly one-at-a-time.
    expect(maxInFlight).toBeGreaterThan(1);
  });
});
