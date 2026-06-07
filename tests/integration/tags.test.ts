import { describe, expect, it } from "vitest";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { type AdminPolicy, defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext } from "../../src/harness/action.js";

const NOW = new Date("2026-06-06T00:00:00.000Z");
function makeContext(fake: FakeWorkspace, policy: AdminPolicy = defaultAdminPolicy()): ActionContext {
  return { workspaceId: "ws-1", adminUserId: "admin-1", policy, clockify: fake.client, now: () => NOW };
}
const seed = () => ({ tags: [{ id: "t1", name: "Deep Work" }] });

describe("tag actions", () => {
  it("clockify_tags_list lists tags (read-gated)", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({ actionName: "clockify_tags_list", args: {}, context: makeContext(fake) });
    if (result.kind === "receipt" && result.receipt.ok) expect((result.receipt.data as any).count).toBe(1);
    else throw new Error("expected receipt");

    const off = defaultAdminPolicy();
    off.groups.work_structure = "off";
    const denied = await executeAction({ actionName: "clockify_tags_list", args: {}, context: makeContext(fake, off) });
    if (denied.kind === "receipt" && !denied.receipt.ok) expect(denied.receipt.code).toBe("policy_denied");
    else throw new Error("expected policy_denied");
  });

  it("clockify_tags_get fetches one tag", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({ actionName: "clockify_tags_get", args: { id: "t1" }, context: makeContext(fake) });
    if (result.kind === "receipt" && result.receipt.ok) expect((result.receipt.data as any).entity).toMatchObject({ id: "t1" });
    else throw new Error("expected receipt");
  });

  it("clockify_tags_create creates a tag (safe write)", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({ actionName: "clockify_tags_create", args: { name: "AIASSIST_SMOKE_t" }, context: makeContext(fake) });
    if (result.kind === "receipt" && result.receipt.ok) expect(result.receipt.changed?.created?.[0]).toMatchObject({ type: "tag" });
    else throw new Error("expected receipt");
    expect(fake.counts.createTag).toBe(1);
  });

  it("clockify_tags_update previews then updates once on commit", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({ actionName: "clockify_tags_update", args: { id: "t1", name: "Focus" }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("high_risk_write");
    expect(fake.counts.updateTag ?? 0).toBe(0);
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.updateTag).toBe(1);
  });

  it("clockify_tags_delete previews destructive then deletes once", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({ actionName: "clockify_tags_delete", args: { id: "t1", name: "Deep Work" }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("destructive");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.deleteTag).toBe(1);
    expect(fake.state.tags.find((t) => t.id === "t1")).toBeUndefined();
  });
});
