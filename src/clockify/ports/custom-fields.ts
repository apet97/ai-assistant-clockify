import type { EntitySummary } from "../client.js";

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

/**
 * Custom-field slice of the {@link WorkspaceClient} port (goclmcp §2.8). Reads
 * are immediate; create/update/delete + set-value are risky (commit-only).
 * Gotchas pinned by the unit tests: list is a bare array; update is GET-then-PUT
 * because Clockify requires `type` on update; a project value is a clean
 * `PATCH /projects/{p}/custom-fields/{f} {defaultValue}`, while an entry value is
 * merged into the entry's `customFieldValues` and written via a full-entry PUT.
 */
export interface CustomFieldPort {
  listCustomFields(): Promise<CustomFieldSummary[]>;
  getCustomField(id: string): Promise<CustomFieldSummary | null>;
  createCustomField(input: CreateCustomFieldInput): Promise<EntitySummary>;
  updateCustomField(id: string, patch: UpdateCustomFieldInput): Promise<EntitySummary>;
  deleteCustomField(id: string): Promise<void>;
  setProjectCustomFieldValue(projectId: string, fieldId: string, value: unknown): Promise<void>;
  setEntryCustomFieldValue(entryId: string, fieldId: string, value: unknown): Promise<void>;
}
