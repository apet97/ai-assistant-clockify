import { describe, expect, it } from "vitest";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { type AdminPolicy, defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext } from "../../src/harness/action.js";

const NOW = new Date("2026-06-06T00:00:00.000Z");
function makeContext(fake: FakeWorkspace, policy: AdminPolicy = defaultAdminPolicy()): ActionContext {
  return { workspaceId: "ws-1", adminUserId: "admin-1", policy, clockify: fake.client, now: () => NOW };
}
const seed = () => ({ clients: [{ id: "c1", name: "Acme" }] });

describe("client actions", () => {
  it("clockify_clients_list lists clients (read-gated by work_structure)", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({ actionName: "clockify_clients_list", args: {}, context: makeContext(fake) });
    if (result.kind === "receipt" && result.receipt.ok) expect((result.receipt.data as any).count).toBe(1);
    else throw new Error("expected receipt");

    const off = defaultAdminPolicy();
    off.groups.work_structure = "off";
    const denied = await executeAction({ actionName: "clockify_clients_list", args: {}, context: makeContext(fake, off) });
    if (denied.kind === "receipt" && !denied.receipt.ok) expect(denied.receipt.code).toBe("policy_denied");
    else throw new Error("expected policy_denied");
  });

  it("clockify_clients_get fetches one client", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({ actionName: "clockify_clients_get", args: { id: "c1" }, context: makeContext(fake) });
    if (result.kind === "receipt" && result.receipt.ok) expect((result.receipt.data as any).entity).toMatchObject({ id: "c1" });
    else throw new Error("expected receipt");
  });

  it("clockify_clients_get resolves by exact name (not just id), clarifies on unknown", async () => {
    const fake = createFakeWorkspace(seed());
    const byName = await executeAction({ actionName: "clockify_clients_get", args: { name: "Acme" }, context: makeContext(fake) });
    if (byName.kind === "receipt" && byName.receipt.ok) expect((byName.receipt.data as any).entity).toMatchObject({ id: "c1" });
    else throw new Error(`expected a success receipt, got ${byName.kind}`);
    const ghost = await executeAction({ actionName: "clockify_clients_get", args: { name: "Ghost Co" }, context: makeContext(fake) });
    expect(ghost.kind).toBe("clarify");
  });

  it("clockify_clients_create creates a client (safe write)", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({ actionName: "clockify_clients_create", args: { name: "AIASSIST_SMOKE_c" }, context: makeContext(fake) });
    if (result.kind === "receipt" && result.receipt.ok) expect(result.receipt.changed?.created?.[0]).toMatchObject({ type: "client" });
    else throw new Error("expected receipt");
    expect(fake.counts.createClientBaseAtomic).toBe(1);
  });

  it("clockify_clients_create threads ccEmails and resolves currency by code (case-insensitive)", async () => {
    const fake = createFakeWorkspace({ currencies: [{ id: "cur-usd", code: "USD" }, { id: "cur-eur", code: "EUR" }] });
    const result = await executeAction({
      actionName: "clockify_clients_create",
      args: { name: "AIASSIST_SMOKE_c", ccEmails: ["billing@acme.com"], currency: "eur" },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error(`expected a receipt, got ${result.kind}`);
    const created = fake.state.clients.find((c) => c.name === "AIASSIST_SMOKE_c") as { ccEmails?: string[]; currencyId?: string } | undefined;
    expect(created?.ccEmails).toEqual(["billing@acme.com"]);
    expect(created?.currencyId).toBe("cur-eur");
  });

  it("clockify_clients_create clarifies on an unknown currency code (never creates)", async () => {
    const fake = createFakeWorkspace({ currencies: [{ id: "cur-usd", code: "USD" }] });
    const result = await executeAction({
      actionName: "clockify_clients_create",
      args: { name: "X", currency: "ZZZ" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    if (result.kind === "clarify") expect(result.message).toContain("USD");
    expect(fake.counts.createClientBaseAtomic ?? 0).toBe(0);
  });

  it("clockify_clients_create does not establish symbolic currency uniqueness from an incomplete list", async () => {
    const fake = createFakeWorkspace({
      currencies: [{ id: "cur-eur", code: "EUR" }],
      listTruncated: { listCurrencies: true },
    });
    const result = await executeAction({
      actionName: "clockify_clients_create",
      args: { name: "X", currency: "EUR" },
      context: makeContext(fake),
    });

    expect(result.kind).toBe("clarify");
    if (result.kind === "clarify") expect(result.message).toMatch(/incomplete.*exact currency id|exact currency id.*incomplete/i);
    expect(fake.counts.createClientBaseAtomic ?? 0).toBe(0);
  });

  it("clockify_clients_create accepts an exact currency id found in an incomplete list", async () => {
    const fake = createFakeWorkspace({
      currencies: [{ id: "cur-eur", code: "EUR" }],
      listTruncated: { listCurrencies: true },
    });
    const result = await executeAction({
      actionName: "clockify_clients_create",
      args: { name: "X", currency: "cur-eur" },
      context: makeContext(fake),
    });

    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error(`expected a receipt, got ${result.kind}`);
    expect(fake.state.clients.find((client) => client.name === "X")).toMatchObject({ currencyId: "cur-eur" });
  });

  it("clockify_clients_update previews then updates once on commit", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({ actionName: "clockify_clients_update", args: { id: "c1", name: "Acme Inc" }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("high_risk_write");
    expect(fake.counts.updateClient ?? 0).toBe(0);
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.updateClientAtomic).toBe(1);
  });

  it("clockify_clients_update renames by currentName — the resolved id is pinned into the operation", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_clients_update",
      args: { currentName: "acme", name: "Acme Corp" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.payload).toMatchObject({ id: "c1", patch: { name: "Acme Corp" } });
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.state.clients[0].name).toBe("Acme Corp");
  });

  it("clockify_clients_update threads ccEmails into the patch (typed + validated)", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_clients_update",
      args: { id: "c1", ccEmails: ["billing@acme.com"] },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    expect(preview.operation.payload).toMatchObject({ id: "c1", patch: { ccEmails: ["billing@acme.com"] } });
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
  });

  it("clockify_clients_update rejects a malformed ccEmails entry (invalid_args)", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({
      actionName: "clockify_clients_update",
      args: { id: "c1", ccEmails: ["not-an-email"] },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || result.receipt.ok) throw new Error("expected an error receipt");
    expect(result.receipt.code).toBe("invalid_args");
  });

  it("clockify_clients_update resolves currency by code into the patch (clarifies on unknown)", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "c1", name: "Acme" }], currencies: [{ id: "cur-gbp", code: "GBP" }] });
    const preview = await executeAction({
      actionName: "clockify_clients_update",
      args: { id: "c1", currency: "GBP" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    expect(preview.operation.payload).toMatchObject({ id: "c1", patch: { currencyId: "cur-gbp" } });

    const bad = await executeAction({
      actionName: "clockify_clients_update",
      args: { id: "c1", currency: "ZZZ" },
      context: makeContext(fake),
    });
    expect(bad.kind).toBe("clarify");
  });

  it("clockify_clients_update clarifies (never previews a doomed commit) on an unknown name", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({
      actionName: "clockify_clients_update",
      args: { currentName: "Acme Inc", name: "X" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.updateClient ?? 0).toBe(0);
  });

  it("clockify_clients_delete resolves a client by name (or a name in the id slot) and pins the id", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_clients_delete",
      args: { name: "Acme" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect((preview.operation.payload as { id: string }).id).toBe("c1");

    const inIdSlot = await executeAction({
      actionName: "clockify_clients_delete",
      args: { id: "Acme" },
      context: makeContext(fake),
    });
    if (inIdSlot.kind !== "preview") throw new Error("expected a preview");
    expect((inIdSlot.operation.payload as { id: string }).id).toBe("c1");
  });

  it("clockify_clients_delete resolves an ARCHIVED client by name — deleting an archived client is valid (live item 305)", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "c9", name: "Old Client", archived: true }] });
    const preview = await executeAction({
      actionName: "clockify_clients_delete",
      args: { name: "Old Client" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    expect((preview.operation.payload as { id: string }).id).toBe("c9");
  });

  it("clockify_clients_delete clarifies on no / ambiguous name match", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "c1", name: "Acme" }, { id: "c2", name: "Acme" }] });
    const ambiguous = await executeAction({
      actionName: "clockify_clients_delete",
      args: { name: "Acme" },
      context: makeContext(fake),
    });
    expect(ambiguous.kind).toBe("clarify");
    const none = await executeAction({
      actionName: "clockify_clients_delete",
      args: { name: "Nope" },
      context: makeContext(fake),
    });
    expect(none.kind).toBe("clarify");
    expect(fake.counts.deleteClient ?? 0).toBe(0);
  });

  it("clockify_clients_delete previews destructive then archive-then-deletes once", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({ actionName: "clockify_clients_delete", args: { id: "c1", name: "Acme" }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("destructive");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.deleteClientAtomic).toBe(1);
    expect(fake.state.clients.find((c) => c.id === "c1")).toBeUndefined();
  });
});
