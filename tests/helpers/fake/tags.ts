import type { EntitySummary, WorkspaceClient } from "../../../src/clockify/client.js";
import type { FakeContext } from "./state.js";

export function makeFakeTags({ state, bump, nextId }: FakeContext): Pick<
  WorkspaceClient,
  "listTags" | "getTag" | "createTag" | "updateTag" | "deleteTag"
> {
  return {
    async listTags(filter) {
      bump("listTags");
      let rows = state.tags;
      if (filter?.name) {
        const needle = filter.name.toLowerCase();
        rows = rows.filter((t) => t.name.toLowerCase().includes(needle));
      }
      if (filter?.archived !== undefined) {
        rows = rows.filter((t) => Boolean(t.archived) === filter.archived);
      }
      return rows;
    },
    async getTag(id) {
      bump("getTag");
      return state.tags.find((t) => t.id === id) ?? null;
    },
    async createTag({ name }) {
      bump("createTag");
      const tag = { id: nextId("tag"), name };
      state.tags.push(tag);
      return tag;
    },
    async updateTag(id, patch) {
      bump("updateTag");
      const index = state.tags.findIndex((t) => t.id === id);
      const base: EntitySummary = index >= 0 ? state.tags[index] : { id, name: id };
      const updated: EntitySummary = {
        ...base,
        ...(typeof patch.name === "string" ? { name: patch.name } : {}),
        ...(typeof patch.archived === "boolean" ? { archived: patch.archived } : {}),
      };
      if (index >= 0) state.tags[index] = updated;
      else state.tags.push(updated);
      return updated;
    },
    async deleteTag(id) {
      bump("deleteTag");
      state.tags = state.tags.filter((t) => t.id !== id);
      state.deleted.push({ entityType: "tag", id });
    },
  };
}
