import { describe, expect, it } from "vitest";
import { commitBatch } from "../../src/harness/actions.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext } from "../../src/harness/action.js";
import type { ConfirmableOperation } from "../../src/harness/action.js";

function makeContext(fake: FakeWorkspace): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy: defaultAdminPolicy(),
    clockify: fake.client,
    now: () => new Date("2026-06-05T00:00:00.000Z"),
  };
}

function deleteOp(entityType: string, id: string): ConfirmableOperation {
  return {
    actionName: "clockify_delete_entity",
    featureGroup: "work_structure",
    risks: ["destructive"],
    payload: { entityType, id },
  };
}

describe("confirm all (batch)", () => {
  it("executes the exact stored batch sequentially", async () => {
    const fake = createFakeWorkspace();
    const operations = [deleteOp("project", "p1"), deleteOp("tag", "t1")];
    const batch = await commitBatch(makeContext(fake), operations);
    expect(batch.ok).toBe(true);
    expect(batch.results.map((r) => r.status)).toEqual(["succeeded", "succeeded"]);
    expect(fake.counts.deleteEntity).toBe(2);
    expect(fake.state.deleted.map((d) => d.id)).toEqual(["p1", "t1"]);
  });

  it("reports partial failure without hiding it", async () => {
    const fake = createFakeWorkspace({ failDeleteIds: ["boom"] });
    const operations = [deleteOp("project", "p1"), deleteOp("project", "boom")];
    const batch = await commitBatch(makeContext(fake), operations);
    expect(batch.ok).toBe(false);
    expect(batch.results[0].status).toBe("succeeded");
    expect(batch.results[1].status).toBe("failed");
    // both were attempted; only the good one mutated state
    expect(fake.counts.deleteEntity).toBe(2);
    expect(fake.state.deleted.map((d) => d.id)).toEqual(["p1"]);
  });
});
