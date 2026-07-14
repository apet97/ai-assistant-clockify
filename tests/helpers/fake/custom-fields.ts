import type { WorkspaceClient } from "../../../src/clockify/client.js";
import type { CustomFieldSummary } from "../../../src/clockify/ports/custom-fields.js";
import { fakeListResult, type FakeContext } from "./state.js";

export function makeFakeCustomFields({ state, seed, bump, nextId }: FakeContext): Pick<
  WorkspaceClient,
  | "listCustomFields"
  | "getCustomField"
  | "createCustomField"
  | "createCustomFieldAtomic"
  | "updateCustomField"
  | "prepareCustomFieldUpdate"
  | "updateCustomFieldAtomic"
  | "deleteCustomField"
  | "deleteCustomFieldAtomic"
  | "setProjectCustomFieldValue"
  | "setProjectCustomFieldValueAtomic"
  | "setEntryCustomFieldValue"
  | "prepareEntryCustomFieldValue"
  | "getEntryCustomFieldMutationState"
  | "setEntryCustomFieldValueAtomic"
> {
  return {
    async listCustomFields() {
      bump("listCustomFields");
      return fakeListResult(seed, "listCustomFields", state.customFields);
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
    async createCustomFieldAtomic(input) {
      bump("createCustomFieldAtomic");
      const field: CustomFieldSummary = { id: nextId("cf"), name: input.name, type: input.type, status: input.status ?? "VISIBLE", ...(input.required !== undefined ? { required: input.required } : {}), ...(input.allowedValues !== undefined ? { allowedValues: input.allowedValues } : {}) };
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
    async prepareCustomFieldUpdate(id, patch) {
      bump("prepareCustomFieldUpdate");
      const field = state.customFields.find((row) => row.id === id);
      if (!field?.type) throw new Error("custom_field_not_found");
      return { ...field, ...patch, type: patch.type ?? field.type as any };
    },
    async updateCustomFieldAtomic(id, body) {
      bump("updateCustomFieldAtomic");
      const index = state.customFields.findIndex((row) => row.id === id);
      if (index < 0) throw new Error("custom_field_not_found");
      state.customFields[index] = { ...state.customFields[index]!, ...body, id };
      return { id, name: state.customFields[index]!.name };
    },
    async deleteCustomField(id) {
      bump("deleteCustomField");
      state.customFields = state.customFields.filter((c) => c.id !== id);
      state.deleted.push({ entityType: "custom_field", id });
    },
    async deleteCustomFieldAtomic(id) {
      bump("deleteCustomFieldAtomic");
      state.customFields = state.customFields.filter((field) => field.id !== id);
      state.deleted.push({ entityType: "custom_field", id });
    },
    async setProjectCustomFieldValue(projectId, fieldId, value) {
      bump("setProjectCustomFieldValue");
      void projectId;
      void fieldId;
      void value;
    },
    async setProjectCustomFieldValueAtomic(projectId, fieldId, value) {
      bump("setProjectCustomFieldValueAtomic");
      void projectId; void fieldId; void value;
    },
    async setEntryCustomFieldValue(entryId, fieldId, value) {
      bump("setEntryCustomFieldValue");
      void entryId;
      void fieldId;
      void value;
    },
    async prepareEntryCustomFieldValue(entryId, fieldId, value) {
      bump("prepareEntryCustomFieldValue");
      const entry = state.timeEntries.find((row) => row.id === entryId);
      if (!entry) throw new Error("entry_not_found");
      const source = structuredClone(entry as unknown as Record<string, unknown>);
      const current = Array.isArray(source.customFieldValues) ? source.customFieldValues as Array<Record<string, unknown>> : [];
      const without = current.filter((field) => (field.customFieldId ?? field.customFieldDefinitionId ?? field.id) !== fieldId);
      return { source, body: { ...entry, start: entry.start, customFieldValues: [...without, { customFieldId: fieldId, value }] } };
    },
    async getEntryCustomFieldMutationState(entryId) {
      bump("getEntryCustomFieldMutationState");
      const entry = state.timeEntries.find((row) => row.id === entryId);
      return entry ? structuredClone(entry as unknown as Record<string, unknown>) : null;
    },
    async setEntryCustomFieldValueAtomic(entryId, prepared) {
      bump("setEntryCustomFieldValueAtomic");
      void entryId; void prepared;
    },
  };
}
