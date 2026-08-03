import type { RestCore } from "./core.js";
import type { EntitySummary } from "../types.js";
import type { CustomFieldPort, CustomFieldSummary, CreateCustomFieldInput, UpdateCustomFieldInput, PreparedCustomFieldUpdateInput, PreparedEntryCustomFieldValueInput } from "../ports/custom-fields.js";
import { assertCompleteAbsence } from "./list-pages.js";
import { AmbiguousWriteOutcome } from "../write-outcome.js";

/** Custom-field row fields read by {@link mapField} + the update GET-scan. */
type FieldRow = {
  id: string;
  name: string;
  type?: string;
  status?: string;
  required?: boolean;
  allowedValues?: string[];
};

/** One entry of a time entry's `customFieldValues` (read for replace-or-append). */
type EntryCustomFieldValue = {
  customFieldId?: string;
  customFieldDefinitionId?: string;
  id?: string;
  value?: unknown;
};

/** The time-entry doc fields the entry-value PUT carries over. */
type EntryDoc = {
  customFieldValues?: EntryCustomFieldValue[];
  timeInterval?: { start?: string; end?: string };
  description?: string;
  projectId?: string;
  taskId?: string;
  tagIds?: string[];
  billable?: boolean;
};

function mapField(raw: FieldRow): CustomFieldSummary {
  const out: CustomFieldSummary = { id: raw.id, name: raw.name };
  if (raw.type !== undefined) out.type = raw.type;
  if (raw.status !== undefined) out.status = raw.status;
  if (typeof raw.required === "boolean") out.required = raw.required;
  if (Array.isArray(raw.allowedValues)) out.allowedValues = raw.allowedValues;
  return out;
}

/**
 * Typed custom-field REST module (goclmcp §2.8). Reads are immediate; the risky
 * methods run only from a handler's `commit`. Shapes pinned by the unit tests:
 * list is a bare array; update is GET-then-PUT because Clockify requires `type`
 * on update (sourced from the existing field); a project value is a clean
 * `PATCH /projects/{p}/custom-fields/{f} {defaultValue}`, while an entry value is
 * merged into the entry's `customFieldValues` and written via a full-entry PUT
 * (the PUT replaces and requires `start`, flattened from `timeInterval`).
 */
export function makeCustomFieldRest(core: RestCore, workspaceId: string): CustomFieldPort {
  const ws = `/workspaces/${workspaceId}`;

  // The single-field GET /custom-fields/{id} 405s (live-verified); read one field
  // by listing and filtering, like invoice items.
  async function findRaw(id: string): Promise<FieldRow | null> {
    const result = await core.paginate("api", `${ws}/custom-fields`);
    const raw = (result.rows as FieldRow[]).find((r) => r.id === id);
    if (!raw) assertCompleteAbsence(result.truncated, "custom-field", id);
    return raw ?? null;
  }

  const createAtomic = async (input: CreateCustomFieldInput): Promise<EntitySummary> => {
    const body = { name: input.name, type: input.type, status: input.status ?? "VISIBLE", ...(input.allowedValues !== undefined ? { allowedValues: input.allowedValues } : {}), ...(input.required !== undefined ? { required: input.required } : {}) };
    const field = (await core.mutate("api", "POST", `${ws}/custom-fields`, body)) as { id?: unknown; name?: string } | null;
    if (typeof field?.id !== "string" || field.id.length === 0) {
      throw new AmbiguousWriteOutcome("POST", `${ws}/custom-fields`, "Clockify returned a successful custom-field response without a usable id.");
    }
    return { id: field.id, name: field.name ?? input.name };
  };
  const prepareUpdate = async (id: string, patch: UpdateCustomFieldInput): Promise<PreparedCustomFieldUpdateInput> => {
    const existing = ((await findRaw(id)) ?? {}) as Record<string, unknown>;
    const type = patch.type ?? (existing.type as PreparedCustomFieldUpdateInput["type"] | undefined);
    if (!type) throw new Error("custom field update requires a type and the existing type could not be resolved");
    return {
      type,
      ...((patch.name ?? existing.name as string | undefined) !== undefined ? { name: patch.name ?? existing.name as string } : {}),
      ...((patch.status ?? existing.status as string | undefined) !== undefined ? { status: patch.status ?? existing.status as string } : {}),
      ...((patch.required ?? existing.required as boolean | undefined) !== undefined ? { required: patch.required ?? existing.required as boolean } : {}),
      ...((patch.allowedValues ?? existing.allowedValues as string[] | undefined) !== undefined ? { allowedValues: patch.allowedValues ?? existing.allowedValues as string[] } : {}),
    };
  };
  const updateAtomic = async (id: string, body: PreparedCustomFieldUpdateInput): Promise<EntitySummary> => {
    const updated = (await core.mutate("api", "PUT", `${ws}/custom-fields/${id}`, body)) as { id?: string; name?: string };
    return { id: updated?.id ?? id, name: updated?.name ?? body.name ?? id };
  };
  const deleteAtomic = async (id: string): Promise<void> => { await core.mutate("api", "DELETE", `${ws}/custom-fields/${id}`); };
  const setProjectAtomic = async (projectId: string, fieldId: string, value: unknown): Promise<void> => { await core.mutate("api", "PATCH", `${ws}/projects/${projectId}/custom-fields/${fieldId}`, { defaultValue: value }); };
  const getEntryMutationState = async (id: string): Promise<Record<string, unknown> | null> => {
    const entry = await core.call("api", "GET", `${ws}/time-entries/${id}`);
    return entry && typeof entry === "object" ? structuredClone(entry as Record<string, unknown>) : null;
  };
  const prepareEntryValue = async (entryId: string, fieldId: string, value: unknown): Promise<PreparedEntryCustomFieldValueInput> => {
    const entry = ((await getEntryMutationState(entryId)) ?? {}) as EntryDoc;
    const existing: EntryCustomFieldValue[] = Array.isArray(entry.customFieldValues) ? entry.customFieldValues : [];
    let found = false;
    const merged = existing.map((field) => {
      const id = field.customFieldId ?? field.customFieldDefinitionId ?? field.id;
      if (id !== fieldId) return field;
      found = true;
      return { ...field, value };
    });
    if (!found) merged.push({ customFieldId: fieldId, value });
    const start = entry.timeInterval?.start;
    if (!start) throw new Error(`Cannot set custom field on time entry ${entryId}: could not resolve its start time`);
    return {
      source: structuredClone(entry as Record<string, unknown>),
      body: {
        start,
        ...(entry.timeInterval?.end != null ? { end: entry.timeInterval.end } : {}),
        ...(entry.description !== undefined ? { description: entry.description } : {}),
        ...(entry.projectId !== undefined ? { projectId: entry.projectId } : {}),
        ...(entry.taskId !== undefined ? { taskId: entry.taskId } : {}),
        ...(entry.tagIds !== undefined ? { tagIds: entry.tagIds } : {}),
        ...(entry.billable !== undefined ? { billable: entry.billable } : {}),
        customFieldValues: merged,
      },
    };
  };
  const setEntryAtomic = async (id: string, prepared: PreparedEntryCustomFieldValueInput): Promise<void> => { await core.mutate("api", "PUT", `${ws}/time-entries/${id}`, prepared.body); };

  return {
    async listCustomFields() {
      const result = await core.paginate("api", `${ws}/custom-fields`);
      return { ...result, rows: (result.rows as FieldRow[]).map(mapField) };
    },
    async getCustomField(id) {
      const raw = await findRaw(id);
      return raw ? mapField(raw) : null;
    },
    async createCustomField(input): Promise<EntitySummary> {
      return createAtomic(input);
    },
    createCustomFieldAtomic: createAtomic,
    async updateCustomField(id, patch): Promise<EntitySummary> {
      // Clockify requires `type` on update, so source type (and the other fields
      // not being changed) from the existing field — read from the LIST because the
      // single-field GET 405s.
      return updateAtomic(id, await prepareUpdate(id, patch));
    },
    prepareCustomFieldUpdate: prepareUpdate,
    updateCustomFieldAtomic: updateAtomic,
    async deleteCustomField(id) {
      await deleteAtomic(id);
    },
    deleteCustomFieldAtomic: deleteAtomic,
    async setProjectCustomFieldValue(projectId, fieldId, value) {
      await setProjectAtomic(projectId, fieldId, value);
    },
    setProjectCustomFieldValueAtomic: setProjectAtomic,
    async setEntryCustomFieldValue(entryId, fieldId, value) {
      // The entry custom-field value lives in the entry's `customFieldValues`; GET
      // the entry, merge (replace-or-append), then PUT the full entry (Clockify's
      // PUT replaces and requires `start`, so flatten timeInterval to the top level).
      await setEntryAtomic(entryId, await prepareEntryValue(entryId, fieldId, value));
    },
    prepareEntryCustomFieldValue: prepareEntryValue,
    getEntryCustomFieldMutationState: getEntryMutationState,
    setEntryCustomFieldValueAtomic: setEntryAtomic,
  };
}
