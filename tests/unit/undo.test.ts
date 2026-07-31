import { describe, expect, it } from "vitest";
import { reverseCreationDurably, reversibleCreations, undoMutationPlan } from "../../src/harness/undo.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { DefinitiveWriteFailure } from "../../src/clockify/write-outcome.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { durableUndoHarness } from "../helpers/durable-undo.js";
import type { ActionContext } from "../../src/harness/catalog.js";
import type { WorkspaceClient } from "../../src/clockify/client.js";
import type { EntityRef, SuccessReceipt } from "../../src/harness/receipts.js";

/**
 * C4: there is ONE undo path and it is the durable one. `reverseCreation`, the
 * non-durable twin these tests used to drive, is deleted — production has
 * always gone through `reverseCreationDurably` (confirmation-service.ts:412).
 *
 * Retargeting exposed that the twin exercised a path production never takes:
 * it deleted through the GENERIC `ctx.clockify.deleteEntity`, while
 * `dispatchDelete` (undo.ts:116-132) routes every type to its TYPED atomic
 * delete. That is why the old `failDeleteIds` seed — a knob on the generic
 * `deleteEntity` only (fake/misc-risky.ts:40) — stops failing anything here;
 * the failure cases now inject on the typed method the real adapter calls.
 */

function ctx(client: WorkspaceClient, readOnlyGroup?: string): ActionContext {
  const policy = defaultAdminPolicy();
  if (readOnlyGroup) policy.groups[readOnlyGroup as keyof typeof policy.groups] = "read";
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy,
    clockify: client,
    now: () => new Date("2026-06-05T00:00:00.000Z"),
  };
}

/** Drive the production undo against the REAL store-backed operation journal. */
async function undo(base: ActionContext, refs: EntityRef[]) {
  const harness = durableUndoHarness(base, refs);
  try {
    return await reverseCreationDurably(harness.context, refs, harness.operationId, harness.plan);
  } finally {
    harness.close();
  }
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

describe("reverseCreationDurably — extended types", () => {
  it("undoes a group/holiday/assignment creation and respects each policy gate", async () => {
    const fake = createFakeWorkspace({
      groups: [{ id: "g1", name: "Devs", userIds: [] }],
      holidays: [{ id: "h1", name: "Xmas", startDate: "2026-12-25", endDate: "2026-12-25" }],
      assignments: [{ id: "a1", userId: "u1", projectId: "p1", start: "2026-06-01", end: "2026-06-05", hoursPerDay: 8 }],
    });
    const result = await undo(ctx(fake.client), [
      { type: "group", id: "g1" },
      { type: "holiday", id: "h1" },
      { type: "assignment", id: "a1" },
    ]);
    expect(result.status).toBe("undone");
    expect(result.receipt.ok).toBe(true);
    if (result.receipt.ok) {
      expect(result.receipt.warnings ?? []).toEqual([]);
      expect(result.receipt.changed?.deleted?.map((d) => d.type)).toEqual(["assignment", "holiday", "group"]);
    }

    // Policy gate per type: scheduling read-only denies an assignment undo,
    // BEFORE the operation journal is consulted (undo.ts:174-186).
    const denied = await undo(ctx(createFakeWorkspace().client, "scheduling"), [{ type: "assignment", id: "a9" }]);
    expect(denied.receipt.ok).toBe(false);
    expect(denied.status).toBe("failed");
  });
});

describe("reverseCreationDurably", () => {
  it("deletes the created entities in REVERSE order and reports them deleted", async () => {
    // A created-task ref carries its projectId — a task delete is project-scoped
    // on the wire (the real adapter/fake both reject a task delete without it).
    const fake = createFakeWorkspace({
      clients: [{ id: "c1", name: "Globex" }],
      projects: [{ id: "p1", name: "Phoenix" }],
      tasks: [{ id: "t1", name: "Login", projectId: "p1" }],
    });
    const refs: EntityRef[] = [
      { type: "client", id: "c1", name: "Globex" },
      { type: "project", id: "p1", name: "Phoenix" },
      { type: "task", id: "t1", name: "Login", projectId: "p1" },
    ];
    const result = await undo(ctx(fake.client), refs);
    expect(result.status).toBe("undone");
    expect(fake.state.deleted.map((d) => d.id)).toEqual(["t1", "p1", "c1"]);
    if (result.receipt.ok) {
      expect(result.receipt.changed?.deleted?.map((d) => d.id)).toEqual(["t1", "p1", "c1"]);
    }
  });

  it("plans a transition step before the delete for archive-first types", () => {
    // Projects/clients/tasks are archived (task: marked DONE) before deletion,
    // so each contributes TWO ordered primary steps. The durable executor
    // re-derives this plan and refuses to run if it disagrees
    // (undo.ts:190-194), so pinning its shape pins the contract.
    const plan = undoMutationPlan([
      { type: "tag", id: "g1" },
      { type: "project", id: "p1" },
    ]);
    expect(plan.steps.map((s) => s.id)).toEqual([
      "undo-0-project-transition",
      "undo-0-project-delete",
      "undo-1-tag-delete",
    ]);
    expect(plan.steps.every((s) => s.kind === "primary")).toBe(true);
  });

  it("reverses a created task within its project (projectId on the ref) and removes it", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "p1", name: "Apollo" }],
      tasks: [{ id: "t1", name: "Login", projectId: "p1" }],
    });
    const result = await undo(ctx(fake.client), [{ type: "task", id: "t1", name: "Login", projectId: "p1" }]);
    expect(result.status).toBe("undone");
    expect(fake.state.tasks.some((t) => t.id === "t1")).toBe(false); // really removed
    expect(fake.state.deleted.map((d) => d.id)).toEqual(["t1"]);
  });

  it("returns an honest FAILURE for a created task ref WITHOUT its projectId (never a silent 'Undone')", async () => {
    // A task delete needs the projectId; a ref that lost it can't be reversed.
    // It must come back ok:false (undo_failed) so the route 400s and the button
    // re-enables — not a false "Undone" over a task that's still live.
    const fake = createFakeWorkspace();
    const result = await undo(ctx(fake.client), [{ type: "task", id: "t1", name: "Login" }]);
    expect(result.receipt.ok).toBe(false);
    expect(result.status).toBe("failed");
    if (!result.receipt.ok) expect(result.receipt.code).toBe("undo_failed");
    expect(fake.state.deleted).toHaveLength(0);
  });

  it("denies the undo when write access to a created entity's group is disabled", async () => {
    const fake = createFakeWorkspace();
    const result = await undo(ctx(fake.client, "work_structure"), [{ type: "project", id: "p1" }]);
    expect(result.receipt.ok).toBe(false);
    if (!result.receipt.ok) expect(result.receipt.code).toBe("policy_denied");
    expect(fake.state.deleted).toHaveLength(0);
  });

  it("reports nothing-to-undo for empty refs", async () => {
    // Returns before the journal is consulted (undo.ts:167-173), so no
    // operation is started for it.
    const result = await reverseCreationDurably(
      ctx(createFakeWorkspace().client),
      [],
      "op-empty",
      undoMutationPlan([{ type: "tag", id: "unused" }]),
    );
    expect(result.receipt.ok).toBe(false);
    if (!result.receipt.ok) expect(result.receipt.code).toBe("not_undoable");
  });

  it("stops at a DEFINITIVE failure and reports the known effects as partial", async () => {
    // Reverse order runs the tag delete first (succeeds), then archives the
    // project (succeeds), then the project delete is definitively refused.
    // Known effects exist, so this is `partially_undone` with the project
    // RETAINED and named in `remaining` — never a silent success.
    const fake = createFakeWorkspace({
      projects: [{ id: "p1", name: "Phoenix" }],
      tags: [{ id: "g1", name: "Urgent" }],
    });
    const client: WorkspaceClient = {
      ...fake.client,
      deleteProjectAtomic: async () => {
        throw new DefinitiveWriteFailure("DELETE", "/projects/p1", "Clockify refused the delete", 400);
      },
    };
    const result = await undo(ctx(client), [
      { type: "project", id: "p1", name: "Phoenix" },
      { type: "tag", id: "g1", name: "Urgent" },
    ]);
    expect(result.status).toBe("partially_undone");
    expect(result.receipt.ok).toBe(true);
    if (result.receipt.ok) {
      expect(result.receipt.changed?.deleted?.map((d) => d.id)).toEqual(["g1"]);
      expect((result.receipt.warnings ?? []).some((w) => w.code === "undo_failed")).toBe(true);
    }
    expect(result.remaining.map((r) => r.id)).toEqual(["p1"]);
  });

  it("returns an honest FAILURE (not a silent 'Undone') when the FIRST step is definitively refused", async () => {
    // Nothing was removed, so the undo is a failure: the route returns 400 and
    // the UI re-enables the button instead of showing "Undone".
    const fake = createFakeWorkspace({
      projects: [{ id: "p1", name: "Phoenix" }],
      tags: [{ id: "g1", name: "Urgent" }],
    });
    const client: WorkspaceClient = {
      ...fake.client,
      deleteTagAtomic: async () => {
        throw new DefinitiveWriteFailure("DELETE", "/tags/g1", "Clockify refused the delete", 400);
      },
    };
    const result = await undo(ctx(client), [
      { type: "project", id: "p1", name: "Phoenix" },
      { type: "tag", id: "g1", name: "Urgent" },
    ]);
    expect(result.receipt.ok).toBe(false);
    expect(result.status).toBe("failed");
    if (!result.receipt.ok) expect(result.receipt.code).toBe("undo_failed");
    expect(fake.state.deleted).toHaveLength(0);
    expect(result.remaining.map((r) => r.id)).toEqual(["p1", "g1"]);
  });

  it("classifies an AMBIGUOUS dispatch failure as outcome_unknown, never as a definitive failure", async () => {
    // The twin could not express this at all: a transport-class error after
    // dispatch is not KNOWN to have failed, so it must never be reported as a
    // clean failure and must never be auto-retried.
    const fake = createFakeWorkspace({ tags: [{ id: "g1", name: "Urgent" }] });
    const client: WorkspaceClient = {
      ...fake.client,
      deleteTagAtomic: async () => {
        throw new Error("socket hang up");
      },
    };
    const result = await undo(ctx(client), [{ type: "tag", id: "g1", name: "Urgent" }]);
    expect(result.status).toBe("outcome_unknown");
    expect(result.receipt.ok).toBe(false);
    if (!result.receipt.ok) expect(result.receipt.code).toBe("commit_outcome_unknown");
    expect(result.remaining.map((r) => r.id)).toEqual(["g1"]);
  });
});
