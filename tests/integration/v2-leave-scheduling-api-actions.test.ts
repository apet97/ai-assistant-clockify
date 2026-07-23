import { describe, expect, it } from "vitest";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { getAction } from "../../src/harness/catalog.js";
import {
  TIME_OFF_POLICY_SCOPE_GROUP_BATCH_MAX,
  TIME_OFF_POLICY_SCOPE_USER_BATCH_MAX,
} from "../../src/harness/safety-limits.js";

const TIME_OFF_POLICY_API_ACTIONS = [
  "clockify_time_off_policies_list",
  "clockify_time_off_policies_get",
  "clockify_time_off_policies_create",
  "clockify_time_off_policies_update",
  "clockify_time_off_policies_archive",
] as const;

describe("v2 time off policy API actions", () => {
  it("exposes bounded policy CRUD actions on MODEL_API", () => {
    const modelNames = new Set(MODEL_API_ACTION_CATALOG.actions.map((action) => action.name));
    for (const name of TIME_OFF_POLICY_API_ACTIONS) {
      expect(modelNames.has(name), name).toBe(true);
      expect(getAction(name)?.apiExposure).toBe("api");
    }
    const create = getAction("clockify_time_off_policies_create");
    const update = getAction("clockify_time_off_policies_update");
    expect(create?.materialFields?.find((field) => field.kind === "array_item" && field.containerPath === "/userIds")?.maxItems)
      .toBe(TIME_OFF_POLICY_SCOPE_USER_BATCH_MAX);
    expect(create?.materialFields?.find((field) => field.kind === "array_item" && field.containerPath === "/userGroupIds")?.maxItems)
      .toBe(TIME_OFF_POLICY_SCOPE_GROUP_BATCH_MAX);
    expect(update?.materialFields?.find((field) => field.kind === "array_item" && field.containerPath === "/userIds")?.maxItems)
      .toBe(TIME_OFF_POLICY_SCOPE_USER_BATCH_MAX);
    expect(getAction("clockify_time_off_requests_get")?.apiExposure).toBe("composite");
  });
});
