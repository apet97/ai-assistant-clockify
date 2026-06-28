import type { RestCore } from "./core.js";
import type { EntitySummary } from "../types.js";
import type { CustomFieldPort, CustomFieldSummary } from "../ports/custom-fields.js";

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
    const rows = (await core.paginate("api", `${ws}/custom-fields`)) as FieldRow[];
    return rows.find((r) => r.id === id) ?? null;
  }

  return {
    async listCustomFields() {
      const rows = (await core.paginate("api", `${ws}/custom-fields`)) as FieldRow[];
      return rows.map(mapField);
    },
    async getCustomField(id) {
      const raw = await findRaw(id);
      return raw ? mapField(raw) : null;
    },
    async createCustomField(input): Promise<EntitySummary> {
      const body: Record<string, unknown> = {
        name: input.name,
        type: input.type,
        status: input.status ?? "VISIBLE",
        ...(input.allowedValues !== undefined ? { allowedValues: input.allowedValues } : {}),
        ...(input.required !== undefined ? { required: input.required } : {}),
      };
      const cf = (await core.call("api", "POST", `${ws}/custom-fields`, body)) as { id: string; name?: string };
      return { id: cf.id, name: cf.name ?? input.name };
    },
    async updateCustomField(id, patch): Promise<EntitySummary> {
      // Clockify requires `type` on update, so source type (and the other fields
      // not being changed) from the existing field — read from the LIST because the
      // single-field GET 405s.
      const existing = ((await findRaw(id)) ?? {}) as Record<string, unknown>;
      const type = patch.type ?? (existing.type as string | undefined);
      if (!type) {
        throw new Error("custom field update requires a type and the existing type could not be resolved");
      }
      const body: Record<string, unknown> = { type };
      const name = patch.name ?? (existing.name as string | undefined);
      if (name !== undefined) body.name = name;
      const status = patch.status ?? (existing.status as string | undefined);
      if (status !== undefined) body.status = status;
      const required = patch.required ?? (existing.required as boolean | undefined);
      if (required !== undefined) body.required = required;
      const allowedValues = patch.allowedValues ?? (existing.allowedValues as string[] | undefined);
      if (allowedValues !== undefined) body.allowedValues = allowedValues;
      const updated = (await core.call("api", "PUT", `${ws}/custom-fields/${id}`, body)) as { id?: string; name?: string };
      return { id: updated?.id ?? id, name: updated?.name ?? name ?? id };
    },
    async deleteCustomField(id) {
      await core.call("api", "DELETE", `${ws}/custom-fields/${id}`);
    },
    async setProjectCustomFieldValue(projectId, fieldId, value) {
      await core.call("api", "PATCH", `${ws}/projects/${projectId}/custom-fields/${fieldId}`, {
        defaultValue: value,
      });
    },
    async setEntryCustomFieldValue(entryId, fieldId, value) {
      // The entry custom-field value lives in the entry's `customFieldValues`; GET
      // the entry, merge (replace-or-append), then PUT the full entry (Clockify's
      // PUT replaces and requires `start`, so flatten timeInterval to the top level).
      const entry = ((await core.call("api", "GET", `${ws}/time-entries/${entryId}`)) ?? {}) as EntryDoc;
      const existing: EntryCustomFieldValue[] = Array.isArray(entry.customFieldValues) ? entry.customFieldValues : [];
      let found = false;
      const merged = existing.map((cf) => {
        const id = cf.customFieldId ?? cf.customFieldDefinitionId ?? cf.id;
        if (id === fieldId) {
          found = true;
          return { ...cf, value };
        }
        return cf;
      });
      if (!found) merged.push({ customFieldId: fieldId, value });
      const start = entry.timeInterval?.start;
      if (!start) {
        // The PUT replaces the entry and requires `start`; fail clearly rather than
        // letting Clockify reject a body with a dropped (undefined) start.
        throw new Error(`Cannot set custom field on time entry ${entryId}: could not resolve its start time`);
      }
      const body: Record<string, unknown> = {
        start,
        end: entry.timeInterval?.end ?? undefined,
        description: entry.description,
        projectId: entry.projectId,
        taskId: entry.taskId,
        tagIds: entry.tagIds,
        billable: entry.billable,
        customFieldValues: merged,
      };
      await core.call("api", "PUT", `${ws}/time-entries/${entryId}`, body);
    },
  };
}
