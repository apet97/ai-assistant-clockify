import type { WorkspaceClient } from "../../../src/clockify/client.js";
import type { CustomFieldSummary } from "../../../src/clockify/ports/custom-fields.js";
import type { FakeContext } from "./state.js";

export function makeFakeCustomFields({ state, bump, nextId }: FakeContext): Pick<
  WorkspaceClient,
  | "listCustomFields"
  | "getCustomField"
  | "createCustomField"
  | "updateCustomField"
  | "deleteCustomField"
  | "setProjectCustomFieldValue"
  | "setEntryCustomFieldValue"
> {
  return {
    async listCustomFields() {
      bump("listCustomFields");
      return state.customFields;
    },
    async getCustomField(id) {
      bump("getCustomField");
      return state.customFields.find((c) => c.id === id) ?? null;
    },
    async createCustomField(input) {
      bump("createCustomField");
      const field: CustomFieldSummary = {
        id: nextId("cf"),
        name: input.name,
        type: input.type,
        status: input.status ?? "VISIBLE",
        required: input.required,
        allowedValues: input.allowedValues,
      };
      state.customFields.push(field);
      return { id: field.id, name: field.name };
    },
    async updateCustomField(id, patch) {
      bump("updateCustomField");
      const index = state.customFields.findIndex((c) => c.id === id);
      const base: CustomFieldSummary = index >= 0 ? state.customFields[index] : { id, name: id };
      const updated: CustomFieldSummary = {
        ...base,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.type !== undefined ? { type: patch.type } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.required !== undefined ? { required: patch.required } : {}),
        ...(patch.allowedValues !== undefined ? { allowedValues: patch.allowedValues } : {}),
      };
      if (index >= 0) state.customFields[index] = updated;
      else state.customFields.push(updated);
      return { id, name: updated.name };
    },
    async deleteCustomField(id) {
      bump("deleteCustomField");
      state.customFields = state.customFields.filter((c) => c.id !== id);
      state.deleted.push({ entityType: "custom_field", id });
    },
    async setProjectCustomFieldValue(projectId, fieldId, value) {
      bump("setProjectCustomFieldValue");
      void projectId;
      void fieldId;
      void value;
    },
    async setEntryCustomFieldValue(entryId, fieldId, value) {
      bump("setEntryCustomFieldValue");
      void entryId;
      void fieldId;
      void value;
    },
  };
}
