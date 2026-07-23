import { describe, expect, it } from "vitest";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { getAction } from "../../src/harness/catalog.js";
import { CUSTOM_FIELD_ALLOWED_VALUES_MAX, CUSTOM_FIELD_VALUE_ARRAY_MAX } from "../../src/harness/safety-limits.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import type { ActionContext } from "../../src/harness/action.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";

const NOW = new Date("2026-06-06T00:00:00.000Z");

const CUSTOM_FIELD_API_WRITES = [
  "clockify_custom_fields_create",
  "clockify_custom_fields_update",
  "clockify_custom_fields_set_value_project",
  "clockify_custom_fields_set_value_entry",
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

describe("v2 custom field API actions", () => {
  it("exposes bounded write actions on MODEL_API", () => {
    const modelNames = new Set(MODEL_API_ACTION_CATALOG.actions.map((action) => action.name));
    for (const name of CUSTOM_FIELD_API_WRITES) {
      expect(modelNames.has(name), name).toBe(true);
      expect(getAction(name)?.apiExposure).toBe("api");
    }
    expect(getAction("clockify_custom_fields_get")?.apiExposure).not.toBe("api");
  });

  it("bounds allowedValues on create", () => {
    const action = getAction("clockify_custom_fields_create");
    const arrayField = action?.materialFields?.find(
      (field) => field.kind === "array_item" && field.containerPath === "/allowedValues",
    );
    expect(arrayField?.kind === "array_item" ? arrayField.maxItems : undefined).toBe(CUSTOM_FIELD_ALLOWED_VALUES_MAX);
  });

  it("create executes for api_key auth with bounded dropdown values", async () => {
    const fake = createFakeWorkspace();
    const preview = await executeAction({
      actionName: "clockify_custom_fields_create",
      args: {
        name: "Priority",
        fieldType: "DROPDOWN_SINGLE",
        allowedValues: ["High", "Low"],
      },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected preview");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.createCustomFieldAtomic).toBe(1);
  });

  it("set_value_project accepts bounded multi-select values", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "p1", name: "Website" }],
      customFields: [{ id: "cf1", name: "Tags", type: "DROPDOWN_MULTIPLE" }],
    });
    const values = Array.from({ length: CUSTOM_FIELD_VALUE_ARRAY_MAX }, (_, index) => `v${index}`);
    const preview = await executeAction({
      actionName: "clockify_custom_fields_set_value_project",
      args: { projectId: "p1", fieldId: "cf1", value: values },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected preview");
    await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(fake.counts.setProjectCustomFieldValueAtomic).toBe(1);
  });
});
