import type { EntitySummary, ListResult } from "../types.js";

/** Clockify custom-field types (case-sensitive on the wire). */
export type CustomFieldType =
  | "TXT"
  | "NUMBER"
  | "DROPDOWN_SINGLE"
  | "DROPDOWN_MULTIPLE"
  | "CHECKBOX"
  | "LINK";

export interface CustomFieldSummary extends EntitySummary {
  type?: string;
  status?: string;
  required?: boolean;
  allowedValues?: string[];
}

export interface CreateCustomFieldInput {
  name: string;
  type: CustomFieldType;
  /** Required for DROPDOWN_SINGLE / DROPDOWN_MULTIPLE. */
  allowedValues?: string[];
  required?: boolean;
  status?: string;
}

export interface UpdateCustomFieldInput {
  name?: string;
  type?: CustomFieldType;
  allowedValues?: string[];
  required?: boolean;
  status?: string;
}

export interface PreparedCustomFieldUpdateInput extends UpdateCustomFieldInput {
  type: CustomFieldType;
}

export interface PreparedEntryCustomFieldValueInput {
  body: Record<string, unknown>;
  /** Complete source document used for both the replacement body and target fingerprint. */
  source: Record<string, unknown>;
}

/**
 * Custom-field slice of the {@link WorkspaceClient} port (goclmcp §2.8). Reads
 * are immediate; create/update/delete + set-value are risky (commit-only).
 * Gotchas pinned by the unit tests: list is a bare array; update is GET-then-PUT
 * because Clockify requires `type` on update; a project value is a clean
 * `PATCH /projects/{p}/custom-fields/{f} {defaultValue}`, while an entry value is
 * merged into the entry's `customFieldValues` and written via a full-entry PUT.
 */
export interface CustomFieldPort {
  listCustomFields(): Promise<ListResult<CustomFieldSummary>>;
  getCustomField(id: string): Promise<CustomFieldSummary | null>;
  createCustomField(input: CreateCustomFieldInput): Promise<EntitySummary>;
  createCustomFieldAtomic(input: CreateCustomFieldInput): Promise<EntitySummary>;
  updateCustomField(id: string, patch: UpdateCustomFieldInput): Promise<EntitySummary>;
  prepareCustomFieldUpdate(id: string, patch: UpdateCustomFieldInput): Promise<PreparedCustomFieldUpdateInput>;
  updateCustomFieldAtomic(id: string, body: PreparedCustomFieldUpdateInput): Promise<EntitySummary>;
  deleteCustomField(id: string): Promise<void>;
  deleteCustomFieldAtomic(id: string): Promise<void>;
  setProjectCustomFieldValue(projectId: string, fieldId: string, value: unknown): Promise<void>;
  setProjectCustomFieldValueAtomic(projectId: string, fieldId: string, value: unknown): Promise<void>;
  setEntryCustomFieldValue(entryId: string, fieldId: string, value: unknown): Promise<void>;
  prepareEntryCustomFieldValue(entryId: string, fieldId: string, value: unknown): Promise<PreparedEntryCustomFieldValueInput>;
  /** Exact raw entry document used to verify a full replacement immediately before dispatch. */
  getEntryCustomFieldMutationState(entryId: string): Promise<Record<string, unknown> | null>;
  setEntryCustomFieldValueAtomic(entryId: string, prepared: PreparedEntryCustomFieldValueInput): Promise<void>;
}
