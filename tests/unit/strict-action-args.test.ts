import { describe, expect, it } from "vitest";
import { executeAction } from "../../src/harness/actions.js";
import type { ActionContext } from "../../src/harness/action.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";

function makeContext(fake: FakeWorkspace): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy: defaultAdminPolicy(),
    clockify: fake.client,
  };
}

describe("strict action arguments", () => {
  it("rejects unknown top-level fields before Zod strips them", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_tags_create",
      args: { name: "Known", surpriseWrite: true },
      context: makeContext(fake),
    });

    expect(result).toMatchObject({
      kind: "receipt",
      receipt: { ok: false, code: "invalid_args" },
    });
    if (result.kind === "receipt" && !result.receipt.ok) {
      expect(result.receipt.message).toContain("surpriseWrite");
    }
    expect(fake.counts.createTag ?? 0).toBe(0);
  });

  it("rejects unknown nested fields", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_create_work_package",
      args: { project: { name: "Apollo", hidden: "mutation" } },
      context: makeContext(fake),
    });

    expect(result).toMatchObject({ kind: "receipt", receipt: { ok: false, code: "invalid_args" } });
    if (result.kind === "receipt" && !result.receipt.ok) {
      expect(result.receipt.message).toContain("project.hidden");
    }
    expect(fake.counts.createProject ?? 0).toBe(0);
  });

  it("accepts only compatibility aliases declared by the action", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_create_work_package",
      args: { projectName: "Apollo" },
      context: makeContext(fake),
    });

    expect(result).toMatchObject({ kind: "receipt", receipt: { ok: true } });
  });
});
