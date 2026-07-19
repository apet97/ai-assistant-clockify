import { describe, expect, it } from "vitest";
import { createFakeWorkspace, type FakeWorkspaceSeed } from "../helpers/fake-clockify.js";

describe("fake Clockify seed isolation", () => {
  it("keeps the original seed byte-identical across repeated mutable workspaces", () => {
    const seed: FakeWorkspaceSeed = {
      approvals: [{
        id: "ap1",
        userId: "u1",
        userName: "Ada",
        state: "PENDING",
        periodStart: "2026-06-01",
      }],
      projectMemberships: { p1: [{ userId: "u1", role: "MEMBER" }] },
    };
    const original = JSON.stringify(seed);

    for (let repeat = 0; repeat < 3; repeat += 1) {
      const workspace = createFakeWorkspace(seed);
      expect(workspace.state.approvals[0]?.state).toBe("PENDING");
      expect(workspace.state.projectMemberships.p1?.[0]).toEqual({ userId: "u1", role: "MEMBER" });

      workspace.state.approvals[0]!.state = "APPROVED";
      workspace.state.projectMemberships.p1![0]!.role = "ADMIN";

      expect(JSON.stringify(seed)).toBe(original);
    }
  });

  it("gives concurrent independent workspaces the same deterministic first id", async () => {
    const left = createFakeWorkspace();
    const right = createFakeWorkspace();
    const [leftTag, rightTag] = await Promise.all([
      left.client.createTag({ name: "Left" }),
      right.client.createTag({ name: "Right" }),
    ]);

    expect(leftTag.id).toBe("tag-1");
    expect(rightTag.id).toBe("tag-1");
  });
});
