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

  it("treats group/holiday/assignment creations as reversible (their delete ports exist)", () => {
    const refs = reversibleCreations(
      receiptWith([
        { type: "group", id: "g1" },
        { type: "holiday", id: "h1" },
        { type: "assignment", id: "a1" },
        // The time-off request delete needs the POLICY id, which the ref
        // doesn't carry — deliberately NOT reversible.
        { type: "time_off_request", id: "r1" },
      ]),
    );
    expect(refs.map((r) => r.type)).toEqual(["group", "holiday", "assignment"]);
  });
});

describe("reverseCreation — extended types", () => {
  it("undoes a group/holiday/assignment creation via the generic delete and respects each policy gate", async () => {
    const fake = createFakeWorkspace({
      groups: [{ id: "g1", name: "Devs", userIds: [] }],
      holidays: [{ id: "h1", name: "Xmas", startDate: "2026-12-25", endDate: "2026-12-25" }],
      assignments: [{ id: "a1", userId: "u1", projectId: "p1", start: "2026-06-01", end: "2026-06-05", hoursPerDay: 8 }],
    });
    const receipt = await reverseCreation(ctx(fake), [
      { type: "group", id: "g1" },
      { type: "holiday", id: "h1" },
      { type: "assignment", id: "a1" },
    ]);
    expect(receipt.ok).toBe(true);
    if (receipt.ok) {
      expect(receipt.warnings ?? []).toEqual([]);
      expect(receipt.changed?.deleted?.map((d) => d.type)).toEqual(["assignment", "holiday", "group"]);
    }

    // Policy gate per type: scheduling read-only denies an assignment undo.
    const denied = await reverseCreation(ctx(createFakeWorkspace(), "scheduling"), [{ type: "assignment", id: "a9" }]);
    expect(denied.ok).toBe(false);
  });
});

describe("reverseCreation", () => {
  it("deletes the created entities in REVERSE order and reports them deleted", async () => {
    const fake = createFakeWorkspace();
    // A created-task ref carries its projectId — a task delete is project-scoped
    // on the wire (the real adapter/fake both reject a task delete without it).
    const refs = [
      { type: "client", id: "c1", name: "Globex" },
      { type: "project", id: "p1", name: "Phoenix" },
      { type: "task", id: "t1", name: "Login", projectId: "p1" },
    ];
    const receipt = await reverseCreation(ctx(fake), refs);
    expect(receipt.ok).toBe(true);
    expect(fake.state.deleted.map((d) => d.id)).toEqual(["t1", "p1", "c1"]);
    if (receipt.ok) expect(receipt.changed?.deleted?.map((d) => d.id)).toEqual(["t1", "p1", "c1"]);
  });

  it("reverses a created task within its project (projectId on the ref) and removes it", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "p1", name: "Apollo" }],
      tasks: [{ id: "t1", name: "Login", projectId: "p1" }],
    });
    const receipt = await reverseCreation(ctx(fake), [{ type: "task", id: "t1", name: "Login", projectId: "p1" }]);
    expect(receipt.ok).toBe(true);
    expect(fake.state.tasks.some((t) => t.id === "t1")).toBe(false); // really removed
    expect(fake.state.deleted.map((d) => d.id)).toEqual(["t1"]);
  });

  it("returns an honest FAILURE for a created task ref WITHOUT its projectId (never a silent 'Undone')", async () => {
    // A task delete needs the projectId; a ref that lost it can't be reversed.
    // It must come back ok:false (undo_failed) so the route 400s and the button
    // re-enables — not a false "Undone" over a task that's still live.
    const fake = createFakeWorkspace();
    const receipt = await reverseCreation(ctx(fake), [{ type: "task", id: "t1", name: "Login" }]);
    expect(receipt.ok).toBe(false);
    if (!receipt.ok) expect(receipt.code).toBe("undo_failed");
    expect(fake.state.deleted).toHaveLength(0);
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

  it("returns an honest FAILURE (not a silent 'Undone') when EVERY delete fails", async () => {
    // The host rejected every delete (addon policy already passed) — the entities
    // persist, so the undo is a failure. It must come back ok:false so the route
    // returns 400 and the UI re-enables the button instead of showing "Undone".
    const fake = createFakeWorkspace({ failDeleteIds: ["p1", "g1"] });
    const receipt = await reverseCreation(ctx(fake), [
      { type: "project", id: "p1", name: "Phoenix" },
      { type: "tag", id: "g1", name: "Urgent" },
    ]);
    expect(receipt.ok).toBe(false);
    if (!receipt.ok) expect(receipt.code).toBe("undo_failed");
  });
});
