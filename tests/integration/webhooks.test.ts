import { describe, expect, it } from "vitest";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { type AdminPolicy, defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext } from "../../src/harness/action.js";

const NOW = new Date("2026-06-06T00:00:00.000Z");
function makeContext(fake: FakeWorkspace, policy: AdminPolicy = defaultAdminPolicy()): ActionContext {
  return { workspaceId: "ws-1", adminUserId: "admin-1", policy, clockify: fake.client, now: () => NOW };
}
const seed = () => ({ webhooks: [{ id: "w1", name: "Hook", url: "https://x.example/h", webhookEvent: "NEW_TIME_ENTRY" }] });

describe("webhook actions", () => {
  it("webhooks_list is read-gated", async () => {
    const fake = createFakeWorkspace(seed());
    const ok = await executeAction({ actionName: "clockify_webhooks_list", args: {}, context: makeContext(fake) });
    if (ok.kind === "receipt" && ok.receipt.ok) expect((ok.receipt.data as any).count).toBe(1);
    else throw new Error("expected receipt");
    const off = defaultAdminPolicy();
    off.groups.webhooks = "off";
    const denied = await executeAction({ actionName: "clockify_webhooks_list", args: {}, context: makeContext(fake, off) });
    if (denied.kind === "receipt" && !denied.receipt.ok) expect(denied.receipt.code).toBe("policy_denied");
    else throw new Error("expected policy_denied");
  });

  it("webhooks_get + events + logs read", async () => {
    const fake = createFakeWorkspace(seed());
    const get = await executeAction({ actionName: "clockify_webhooks_get", args: { id: "w1" }, context: makeContext(fake) });
    if (get.kind === "receipt" && get.receipt.ok) expect((get.receipt.data as any).entity).toMatchObject({ id: "w1" });
    else throw new Error("expected receipt");
    const events = await executeAction({ actionName: "clockify_webhooks_events", args: {}, context: makeContext(fake) });
    if (events.kind === "receipt" && events.receipt.ok) expect((events.receipt.data as any).count).toBeGreaterThan(0);
    else throw new Error("expected receipt");
    const logs = await executeAction({ actionName: "clockify_webhooks_logs", args: { id: "w1" }, context: makeContext(fake) });
    if (logs.kind === "receipt" && logs.receipt.ok) expect(logs.receipt.ok).toBe(true);
    else throw new Error("expected receipt");
  });

  it("webhook WRITES clarify with the platform restriction at PREVIEW on the add-on auth class (live item 248) — never a doomed confirm", async () => {
    const fake = createFakeWorkspace({ webhooks: [{ id: "w1", name: "Hook" }] });
    fake.client.authClass = "addon";
    const create = await executeAction({
      actionName: "clockify_webhooks_create",
      args: { name: "Hook", url: "https://example.com/hook", webhookEvent: "NEW_TIME_ENTRY" },
      context: makeContext(fake),
    });
    expect(create.kind).toBe("clarify");
    if (create.kind === "clarify") expect(create.message).toContain("does not allow add-ons");
    expect(fake.counts.createWebhook ?? 0).toBe(0);

    const update = await executeAction({
      actionName: "clockify_webhooks_update",
      args: { id: "w1", name: "Renamed" },
      context: makeContext(fake),
    });
    expect(update.kind).toBe("clarify");
    const del = await executeAction({
      actionName: "clockify_webhooks_delete",
      args: { id: "w1" },
      context: makeContext(fake),
    });
    expect(del.kind).toBe("clarify");
    expect(fake.counts.updateWebhook ?? 0).toBe(0);
    expect(fake.counts.deleteWebhook ?? 0).toBe(0);
  });

  it("webhooks_create previews external_side_effect, rejects non-HTTPS, then creates", async () => {
    const fake = createFakeWorkspace();
    const bad = await executeAction({ actionName: "clockify_webhooks_create", args: { name: "Hook", url: "http://x.example/h", webhookEvent: "NEW_TIME_ENTRY" }, context: makeContext(fake) });
    if (bad.kind === "receipt" && !bad.receipt.ok) expect(bad.receipt.code).toBe("invalid_args"); // non-HTTPS rejected
    else throw new Error("expected invalid_args");

    const loop = await executeAction({ actionName: "clockify_webhooks_create", args: { name: "Hook", url: "https://localhost/h", webhookEvent: "NEW_TIME_ENTRY" }, context: makeContext(fake) });
    if (loop.kind === "receipt" && !loop.receipt.ok) expect(loop.receipt.code).toBe("invalid_args"); // loopback rejected
    else throw new Error("expected invalid_args");

    const preview = await executeAction({ actionName: "clockify_webhooks_create", args: { name: "AIASSIST_SMOKE_wh", url: "https://x.example/h", webhookEvent: "NEW_TIME_ENTRY" }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("external_side_effect");
    // secret rule: no authToken anywhere in the stored operation payload
    expect(JSON.stringify(preview.operation.payload)).not.toMatch(/authToken/i);
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.createWebhook).toBe(1);
  });

  it("webhooks_update previews then updates; webhooks_delete previews destructive then deletes", async () => {
    const fake = createFakeWorkspace(seed());
    const upreview = await executeAction({ actionName: "clockify_webhooks_update", args: { id: "w1", name: "Renamed" }, context: makeContext(fake) });
    if (upreview.kind !== "preview") throw new Error("expected a preview");
    expect(upreview.operation.risks).toContain("external_side_effect");
    await commitConfirmedOperation(makeContext(fake), upreview.operation);
    expect(fake.state.webhooks[0].name).toBe("Renamed");

    const dpreview = await executeAction({ actionName: "clockify_webhooks_delete", args: { id: "w1", name: "Hook" }, context: makeContext(fake) });
    if (dpreview.kind !== "preview") throw new Error("expected a preview");
    expect(dpreview.operation.risks).toEqual(expect.arrayContaining(["destructive", "external_side_effect"]));
    await commitConfirmedOperation(makeContext(fake), dpreview.operation);
    expect(fake.counts.deleteWebhook).toBe(1);
    expect(fake.state.webhooks.find((w) => w.id === "w1")).toBeUndefined();
  });
});
