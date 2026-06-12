import type { WorkspaceClient } from "../../../src/clockify/client.js";
import type { FakeContext, FakeState } from "./state.js";

/**
 * entityType -> the FakeState collection it lives in. The real adapter
 * archive-then-deletes (projects/clients/expense categories) or hard-deletes —
 * either way the row is GONE afterward, so an undo of a creation truly removes
 * it. The fake must mirror that, or anchoring tests pass against a row live
 * Clockify no longer has.
 */
const DELETE_COLLECTION: Partial<Record<string, keyof FakeState>> = {
  project: "projects",
  client: "clients",
  task: "tasks",
  tag: "tags",
  time_entry: "timeEntries",
  invoice: "invoices",
  expense: "expenses",
  expense_category: "expenseCategories",
  custom_field: "customFields",
  webhook: "webhooks",
  user: "users",
  group: "groups",
};

/**
 * Generic entity-level operations that the real adapter routes per type
 * (`deleteEntity`/`updateEntity`). `deleteEntity` honors the `failDeleteIds`
 * seed knob to exercise partial-batch-failure paths.
 */
export function makeFakeMiscRisky({ state, seed, bump }: FakeContext): Pick<
  WorkspaceClient,
  "deleteEntity" | "updateEntity"
> {
  return {
    async deleteEntity(input) {
      bump("deleteEntity");
      if ((seed.failDeleteIds ?? []).includes(input.id)) {
        throw new Error(`Clockify refused to delete ${input.entityType} ${input.id}`);
      }
      const key = DELETE_COLLECTION[input.entityType];
      if (key) {
        const rows = state[key] as unknown as Array<{ id: string }>;
        const idx = rows.findIndex((e) => e.id === input.id);
        if (idx >= 0) rows.splice(idx, 1);
      }
      state.deleted.push(input);
    },
    async updateEntity(input) {
      bump("updateEntity");
      const name = (input.fields?.name as string | undefined) ?? input.id;
      return { id: input.id, name };
    },
  };
}
