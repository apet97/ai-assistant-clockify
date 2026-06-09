import { describe, expect, it } from "vitest";
import { reverseCreation, reversibleCreations } from "../../src/harness/undo.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext } from "../../src/harness/catalog.js";
import type { SuccessReceipt } from "../../src/harness/receipts.js";

function ctx(fake: FakeWorkspace, readOnlyGroup?: string): ActionContext {
  const policy = defaultAdminPolicy();
  if (readOnlyGroup) policy.groups[readOnlyGroup as keyof typeof policy.groups] = "read";
  return { workspaceId: "ws-1", adminUserId: "admin-1", policy, clockify: fake.client, now: () => new Date("2026-06-05T00:00:00.000Z") };
}

const receiptWith = (created: { type: string; id: string; name?: string }[]): SuccessReceipt => ({
  ok: true,
  action: "clockify_create_work_package",
  changed: { created },
});

describe("reversibleCreations", () => {
  it("keeps only the created entities whose type can be deleted", () => {
    const refs = reversibleCreations(
      receiptWith([
        { type: "project", id: "p1" },
        { type: "time_entry", id: "e1" },
        { type: "work_package", id: "wp" }, // not a real deletable entity
        { type: "user", id: "u1" }, // deliberately excluded (too high-stakes)
      ]),
    );
    expect(refs.map((r) => r.type)).toEqual(["project", "time_entry"]);
  });

  it("returns [] for a receipt with no creates", () => {
    expect(reversibleCreations({ ok: true, action: "x" })).toEqual([]);
  });
});

describe("reverseCreation", () => {
  it("deletes the created entities in REVERSE order and reports them deleted", async () => {
    const fake = createFakeWorkspace();
    const refs = [
      { type: "client", id: "c1", name: "Globex" },
      { type: "project", id: "p1", name: "Phoenix" },
      { type: "task", id: "t1", name: "Login" },
    ];
    const receipt = await reverseCreation(ctx(fake), refs);
    expect(receipt.ok).toBe(true);
    expect(fake.state.deleted.map((d) => d.id)).toEqual(["t1", "p1", "c1"]);
    if (receipt.ok) expect(receipt.changed?.deleted?.map((d) => d.id)).toEqual(["t1", "p1", "c1"]);
  });

  it("denies the undo when write access to a created entity's group is disabled", async () => {
    const fake = createFakeWorkspace();
    const receipt = await reverseCreation(ctx(fake, "work_structure"), [{ type: "project", id: "p1" }]);
    expect(receipt.ok).toBe(false);
    if (!receipt.ok) expect(receipt.code).toBe("policy_denied");
    expect(fake.state.deleted).toHaveLength(0);
  });

  it("reports nothing-to-undo for empty refs", async () => {
    const receipt = await reverseCreation(ctx(createFakeWorkspace()), []);
    expect(receipt.ok).toBe(false);
    if (!receipt.ok) expect(receipt.code).toBe("not_undoable");
  });

  it("surfaces a partial failure as a warning and still removes the rest", async () => {
    const fake = createFakeWorkspace({ failDeleteIds: ["p1"] });
    const receipt = await reverseCreation(ctx(fake), [
      { type: "project", id: "p1", name: "Phoenix" },
      { type: "tag", id: "g1", name: "Urgent" },
    ]);
    expect(receipt.ok).toBe(true);
    if (receipt.ok) {
      expect(receipt.changed?.deleted?.map((d) => d.id)).toEqual(["g1"]); // tag removed (reverse order)
      expect((receipt.warnings ?? []).some((w) => w.code === "undo_failed")).toBe(true);
    }
  });
});
