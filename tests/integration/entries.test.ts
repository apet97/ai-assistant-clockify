import { describe, expect, it } from "vitest";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { type AdminPolicy, defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext } from "../../src/harness/action.js";

const NOW = new Date("2026-06-06T00:00:00.000Z");

function makeContext(fake: FakeWorkspace, policy: AdminPolicy = defaultAdminPolicy()): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy,
    clockify: fake.client,
    now: () => NOW,
  };
}

const seedEntries = () => ({
  entries: [
    { id: "e1", description: "A", start: "2026-06-05T09:00:00Z", end: "2026-06-05T10:00:00Z", projectId: "p1" },
    { id: "e2", description: "B", start: "2026-06-05T11:00:00Z", end: "2026-06-05T12:00:00Z", projectId: "p2" },
  ],
});

describe("time-entry actions — reads", () => {
  it("clockify_entries_list lists the caller's entries and filters by project", async () => {
    const fake = createFakeWorkspace(seedEntries());
    const all = await executeAction({ actionName: "clockify_entries_list", args: {}, context: makeContext(fake) });
    if (all.kind === "receipt" && all.receipt.ok) {
      expect((all.receipt.data as any).count).toBe(2);
    } else throw new Error("expected receipt");

    const filtered = await executeAction({
      actionName: "clockify_entries_list",
      args: { projectId: "p1" },
      context: makeContext(fake),
    });
    if (filtered.kind === "receipt" && filtered.receipt.ok) {
      expect((filtered.receipt.data as any).count).toBe(1);
    } else throw new Error("expected receipt");
  });

  it("clockify_entries_list resolves RELATIVE start/end to UTC instants (live: ?start=today hit the wire 12×)", async () => {
    // NOW is 2026-06-06; the seeded entries are on 2026-06-05.
    const fake = createFakeWorkspace(seedEntries());
    const yesterday = await executeAction({
      actionName: "clockify_entries_list",
      args: { start: "yesterday", end: "yesterday" },
      context: makeContext(fake),
    });
    if (yesterday.kind !== "receipt" || !yesterday.receipt.ok) throw new Error("expected a success receipt");
    const data = yesterday.receipt.data as { count: number; window?: { start?: string; end?: string } };
    expect(data.count).toBe(2);
    // The resolved window is surfaced (and is what went to the wire).
    expect(data.window).toEqual({ start: "2026-06-05T00:00:00.000Z", end: "2026-06-05T23:59:59.999Z" });

    const today = await executeAction({
      actionName: "clockify_entries_list",
      args: { start: "today" },
      context: makeContext(fake),
    });
    if (today.kind !== "receipt" || !today.receipt.ok) throw new Error("expected a success receipt");
    expect((today.receipt.data as { count: number }).count).toBe(0);
  });

  it("clockify_entries_list clarifies on an unparseable date instead of sending it", async () => {
    const fake = createFakeWorkspace(seedEntries());
    const result = await executeAction({
      actionName: "clockify_entries_list",
      args: { start: "the other day" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.getEntries ?? 0).toBe(0);
  });

  it("clockify_entries_list is read-gated by time_tracking", async () => {
    const fake = createFakeWorkspace(seedEntries());
    const off = defaultAdminPolicy();
    off.groups.time_tracking = "off";
    const denied = await executeAction({ actionName: "clockify_entries_list", args: {}, context: makeContext(fake, off) });
    if (denied.kind === "receipt" && !denied.receipt.ok) {
      expect(denied.receipt.code).toBe("policy_denied");
    } else throw new Error("expected policy_denied");
  });

  it("clockify_entries_get fetches one entry by id", async () => {
    const fake = createFakeWorkspace(seedEntries());
    const result = await executeAction({
      actionName: "clockify_entries_get",
      args: { id: "e1" },
      context: makeContext(fake),
    });
    if (result.kind === "receipt" && result.receipt.ok) {
      expect((result.receipt.data as any).entry).toMatchObject({ id: "e1", description: "A" });
    } else throw new Error("expected receipt");
  });
});

describe("time-entry actions — risky writes", () => {
  it("clockify_entries_delete previews destructive, then deletes once on commit", async () => {
    const fake = createFakeWorkspace(seedEntries());
    const preview = await executeAction({
      actionName: "clockify_entries_delete",
      args: { id: "e1" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("destructive");
    expect(preview.operation.featureGroup).toBe("time_tracking");
    expect(fake.counts.deleteEntity ?? 0).toBe(0);

    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.deleteEntity).toBe(1);
    expect(fake.state.deleted).toContainEqual({ entityType: "time_entry", id: "e1" });
  });

  it("clockify_entries_mark_invoiced previews bulk+billing, then marks once on commit", async () => {
    const fake = createFakeWorkspace(seedEntries());
    const preview = await executeAction({
      actionName: "clockify_entries_mark_invoiced",
      args: { ids: ["e1", "e2"], invoiced: true },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toEqual(expect.arrayContaining(["bulk", "billing"]));
    expect(preview.operation.featureGroup).toBe("invoices");
    expect(fake.counts.markEntriesInvoiced ?? 0).toBe(0);

    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.markEntriesInvoiced).toBe(1);
  });

  it("clockify_entries_mark_invoiced is policy-gated by invoices (re-checked at commit)", async () => {
    const fake = createFakeWorkspace(seedEntries());
    const preview = await executeAction({
      actionName: "clockify_entries_mark_invoiced",
      args: { ids: ["e1"], invoiced: true },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    const off = defaultAdminPolicy();
    off.groups.invoices = "off";
    const receipt = await commitConfirmedOperation(makeContext(fake, off), preview.operation);
    expect(receipt.ok).toBe(false);
    if (!receipt.ok) expect(receipt.code).toBe("policy_denied");
    expect(fake.counts.markEntriesInvoiced ?? 0).toBe(0);
  });

  it("re-running the delete proposal (no confirmation) never mutates", async () => {
    const fake = createFakeWorkspace(seedEntries());
    await executeAction({ actionName: "clockify_entries_delete", args: { id: "e1" }, context: makeContext(fake) });
    await executeAction({ actionName: "clockify_entries_mark_invoiced", args: { ids: ["e1"], invoiced: true }, context: makeContext(fake) });
    expect(fake.counts.deleteEntity ?? 0).toBe(0);
    expect(fake.counts.markEntriesInvoiced ?? 0).toBe(0);
  });
});
