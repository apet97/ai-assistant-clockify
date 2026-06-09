import type { WorkspaceClient } from "../../../src/clockify/client.js";
import type { FakeContext } from "./state.js";

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
      state.deleted.push(input);
    },
    async updateEntity(input) {
      bump("updateEntity");
      const name = (input.fields?.name as string | undefined) ?? input.id;
      return { id: input.id, name };
    },
  };
}
