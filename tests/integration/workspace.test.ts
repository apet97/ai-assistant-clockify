import { describe, expect, it } from "vitest";
import { executeAction } from "../../src/harness/actions.js";
import { type AdminPolicy, defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext } from "../../src/harness/action.js";

const NOW = new Date("2026-06-06T00:00:00.000Z");
function makeContext(fake: FakeWorkspace, policy: AdminPolicy = defaultAdminPolicy()): ActionContext {
  return { workspaceId: "ws-1", adminUserId: "admin-1", policy, clockify: fake.client, now: () => NOW };
}

describe("workspace & template actions", () => {
  it("workspace_get is read-gated (workspace_settings)", async () => {
    const fake = createFakeWorkspace();
    const ok = await executeAction({ actionName: "clockify_workspace_get", args: {}, context: makeContext(fake) });
    if (ok.kind === "receipt" && ok.receipt.ok) expect((ok.receipt.data as any).workspace).toMatchObject({ id: "ws-1" });
    else throw new Error("expected receipt");
    const off = defaultAdminPolicy();
    off.groups.workspace_settings = "off";
    const denied = await executeAction({ actionName: "clockify_workspace_get", args: {}, context: makeContext(fake, off) });
    if (denied.kind === "receipt" && !denied.receipt.ok) expect(denied.receipt.code).toBe("policy_denied");
    else throw new Error("expected policy_denied");
  });

  it("templates_list + templates_get read (work_structure)", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "t1", name: "Sprint template" }] });
    const list = await executeAction({ actionName: "clockify_templates_list", args: {}, context: makeContext(fake) });
    if (list.kind === "receipt" && list.receipt.ok) expect((list.receipt.data as any).count).toBe(1);
    else throw new Error("expected receipt");
    const get = await executeAction({ actionName: "clockify_templates_get", args: { id: "t1" }, context: makeContext(fake) });
    if (get.kind === "receipt" && get.receipt.ok) expect((get.receipt.data as any).entity).toMatchObject({ id: "t1" });
    else throw new Error("expected receipt");

    const off = defaultAdminPolicy();
    off.groups.work_structure = "off";
    const denied = await executeAction({ actionName: "clockify_templates_list", args: {}, context: makeContext(fake, off) });
    if (denied.kind === "receipt" && !denied.receipt.ok) expect(denied.receipt.code).toBe("policy_denied");
    else throw new Error("expected policy_denied");
  });
});
