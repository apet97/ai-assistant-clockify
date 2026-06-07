import { describe, expect, it } from "vitest";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { type AdminPolicy, defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext } from "../../src/harness/action.js";

const NOW = new Date("2026-06-06T00:00:00.000Z");
function makeContext(fake: FakeWorkspace, policy: AdminPolicy = defaultAdminPolicy()): ActionContext {
  return { workspaceId: "ws-1", adminUserId: "admin-1", policy, clockify: fake.client, now: () => NOW };
}
const seed = () => ({
  customFields: [{ id: "cf1", name: "Priority", type: "TXT", status: "VISIBLE" }],
});

describe("custom field actions", () => {
  it("clockify_custom_fields_list lists fields and is read-gated", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({ actionName: "clockify_custom_fields_list", args: {}, context: makeContext(fake) });
    if (result.kind === "receipt" && result.receipt.ok) expect((result.receipt.data as any).count).toBe(1);
    else throw new Error("expected receipt");

    const off = defaultAdminPolicy();
    off.groups.custom_fields = "off";
    const denied = await executeAction({ actionName: "clockify_custom_fields_list", args: {}, context: makeContext(fake, off) });
    if (denied.kind === "receipt" && !denied.receipt.ok) expect(denied.receipt.code).toBe("policy_denied");
    else throw new Error("expected policy_denied");
  });

  it("clockify_custom_fields_get fetches one field", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({ actionName: "clockify_custom_fields_get", args: { id: "cf1" }, context: makeContext(fake) });
    if (result.kind === "receipt" && result.receipt.ok) expect((result.receipt.data as any).entity).toMatchObject({ id: "cf1", type: "TXT" });
    else throw new Error("expected receipt");
  });

  it("clockify_custom_fields_create previews high_risk_write then creates once", async () => {
    const fake = createFakeWorkspace();
    const preview = await executeAction({
      actionName: "clockify_custom_fields_create",
      args: { name: "Severity", fieldType: "TXT" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("high_risk_write");
    expect(fake.counts.createCustomField ?? 0).toBe(0);
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.createCustomField).toBe(1);
    expect(fake.state.customFields.find((c) => c.name === "Severity")).toBeDefined();
  });

  it("clockify_custom_fields_create rejects a dropdown without allowedValues (invalid_args, no preview)", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_custom_fields_create",
      args: { name: "Priority", fieldType: "DROPDOWN_SINGLE" }, // missing allowedValues
      context: makeContext(fake),
    });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt" && !result.receipt.ok) expect(result.receipt.code).toBe("invalid_args");
    else throw new Error("expected invalid_args");
  });

  it("clockify_custom_fields_create accepts a dropdown WITH allowedValues", async () => {
    const fake = createFakeWorkspace();
    const preview = await executeAction({
      actionName: "clockify_custom_fields_create",
      args: { name: "Priority", fieldType: "DROPDOWN_SINGLE", allowedValues: ["Hi", "Lo"] },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.payload).toMatchObject({ input: { allowedValues: ["Hi", "Lo"] } });
  });

  it("clockify_custom_fields_update previews then updates once", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_custom_fields_update",
      args: { id: "cf1", name: "Priority Level" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("high_risk_write");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.updateCustomField).toBe(1);
    expect(fake.state.customFields[0].name).toBe("Priority Level");
  });

  it("clockify_custom_fields_delete previews destructive then deletes once", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({ actionName: "clockify_custom_fields_delete", args: { id: "cf1", name: "Priority" }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("destructive");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.deleteCustomField).toBe(1);
    expect(fake.state.customFields.find((c) => c.id === "cf1")).toBeUndefined();
  });

  it("clockify_custom_fields_set_value_project previews high_risk_write then sets once", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_custom_fields_set_value_project",
      args: { projectId: "p1", fieldId: "cf1", value: "High" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("high_risk_write");
    expect(preview.operation.featureGroup).toBe("custom_fields");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.setProjectCustomFieldValue).toBe(1);
  });

  it("clockify_custom_fields_set_value_entry previews high_risk_write then sets once", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_custom_fields_set_value_entry",
      args: { entryId: "e1", fieldId: "cf1", value: "High" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("high_risk_write");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.setEntryCustomFieldValue).toBe(1);
  });
});
