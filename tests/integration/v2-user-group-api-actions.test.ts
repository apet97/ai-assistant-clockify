import { describe, expect, it } from "vitest";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { getAction } from "../../src/harness/catalog.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import type { ActionContext } from "../../src/harness/action.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";

const NOW = new Date("2026-06-06T00:00:00.000Z");

const USER_API_ACTIONS = [
  "clockify_users_invite",
  "clockify_users_deactivate",
  "clockify_users_role_update",
] as const;

const GROUP_API_ACTIONS = [
  "clockify_groups_create",
  "clockify_groups_update",
  "clockify_groups_delete",
  "clockify_groups_remove_user",
  "clockify_groups_add_member",
] as const;

const INTERNAL_ONLY_GROUP_ACTIONS = [
  "clockify_groups_add_user",
  "clockify_groups_get",
] as const;

function makeContext(fake: FakeWorkspace): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy: defaultAdminPolicy(),
    clockify: fake.client,
    now: () => NOW,
  };
}

describe("v2 user and group API actions", () => {
  it("exposes atomic user invite, deactivate, and role actions on MODEL_API", () => {
    const modelNames = new Set(MODEL_API_ACTION_CATALOG.actions.map((action) => action.name));
    for (const name of USER_API_ACTIONS) {
      expect(modelNames.has(name), name).toBe(true);
      expect(getAction(name)?.apiExposure).toBe("api");
    }
  });

  it("exposes atomic group CRUD and membership actions on MODEL_API", () => {
    const modelNames = new Set(MODEL_API_ACTION_CATALOG.actions.map((action) => action.name));
    for (const name of GROUP_API_ACTIONS) {
      expect(modelNames.has(name), name).toBe(true);
      expect(getAction(name)?.apiExposure).toBe("api");
    }
    for (const name of INTERNAL_ONLY_GROUP_ACTIONS) {
      expect(modelNames.has(name), name).toBe(false);
      expect(getAction(name)?.apiExposure).not.toBe("api");
    }
  });

  it("add_member commits with one membership POST for a single user", async () => {
    const fake = createFakeWorkspace({
      groups: [{ id: "g1", name: "Ops", userIds: [] }],
      users: [{ id: "u2", name: "Bob", email: "bob@example.com", status: "ACTIVE" }],
    });
    const preview = await executeAction({
      actionName: "clockify_groups_add_member",
      args: { groupId: "g1", userId: "u2" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected preview");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.addUserToGroupAtomic).toBe(1);
  });
});
