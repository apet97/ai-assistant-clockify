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

  it("clockify_clients_create creates a client (safe write)", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({ actionName: "clockify_clients_create", args: { name: "AIASSIST_SMOKE_c" }, context: makeContext(fake) });
    if (result.kind === "receipt" && result.receipt.ok) expect(result.receipt.changed?.created?.[0]).toMatchObject({ type: "client" });
    else throw new Error("expected receipt");
    expect(fake.counts.createClient).toBe(1);
  });

  it("clockify_clients_update previews then updates once on commit", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({ actionName: "clockify_clients_update", args: { id: "c1", name: "Acme Inc" }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("high_risk_write");
    expect(fake.counts.updateClient ?? 0).toBe(0);
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.updateClient).toBe(1);
  });

  it("clockify_clients_delete previews destructive then archive-then-deletes once", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({ actionName: "clockify_clients_delete", args: { id: "c1", name: "Acme" }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("destructive");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.deleteClient).toBe(1);
    expect(fake.state.clients.find((c) => c.id === "c1")).toBeUndefined();
  });
});
