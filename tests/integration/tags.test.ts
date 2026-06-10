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

  it("clockify_tags_update RENAMES by currentName — resolves it to the id server-side (the planner habitually listed instead because update used to require an id)", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_tags_update",
      args: { currentName: "deep work", name: "Focus" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    // the resolved id is pinned into the confirmable operation
    expect(preview.operation.payload).toMatchObject({ id: "t1", patch: { name: "Focus" } });
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.state.tags[0].name).toBe("Focus");
  });

  it("clockify_tags_update clarifies (never guesses) when the currentName matches nothing", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({
      actionName: "clockify_tags_update",
      args: { currentName: "nope", name: "Focus" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.updateTag ?? 0).toBe(0);
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

  it("clockify_tags_delete resolves a tag by name when no id is given, then deletes once", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({ actionName: "clockify_tags_delete", args: { name: "Deep Work" }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    // The resolved id must be pinned into the operation payload, not left to chat.
    expect((preview.operation.payload as { id: string }).id).toBe("t1");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.deleteTag).toBe(1);
    expect(fake.state.tags.find((t) => t.id === "t1")).toBeUndefined();
  });

  it("clockify_tags_delete asks to clarify (not invalid_args) when the name matches no tag", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({ actionName: "clockify_tags_delete", args: { name: "Nope" }, context: makeContext(fake) });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.deleteTag ?? 0).toBe(0);
  });

  it("clockify_tags_delete asks to clarify with options when the name is ambiguous", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "Focus" }, { id: "t2", name: "Focus" }] });
    const result = await executeAction({ actionName: "clockify_tags_delete", args: { name: "Focus" }, context: makeContext(fake) });
    expect(result.kind).toBe("clarify");
    if (result.kind === "clarify") expect(result.options?.length).toBe(2);
    expect(fake.counts.deleteTag ?? 0).toBe(0);
  });

  it("clockify_tags_delete resolves a NAME passed in the id slot (the audit-log failure shape)", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({ actionName: "clockify_tags_delete", args: { id: "Deep Work" }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect((preview.operation.payload as { id: string }).id).toBe("t1");
  });

  it("clockify_tags_delete rejects a call with neither id nor name", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({ actionName: "clockify_tags_delete", args: {}, context: makeContext(fake) });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt" && !result.receipt.ok) expect(result.receipt.code).toBe("invalid_args");
    else throw new Error("expected an invalid_args error receipt");
  });
});
