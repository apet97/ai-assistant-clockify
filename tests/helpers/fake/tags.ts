import type { EntitySummary, WorkspaceClient } from "../../../src/clockify/client.js";
import { fakeListResult, type FakeContext } from "./state.js";

export function makeFakeTags({ state, seed, bump, nextId }: FakeContext): Pick<
  WorkspaceClient,
  "listTags" | "getTag" | "createTag" | "updateTag" | "deleteTag" |
  "prepareTagUpdate" | "updateTagAtomic" | "deleteTagAtomic"
> {
  const prepareUpdate: WorkspaceClient["prepareTagUpdate"] = async (id, patch) => {
    bump("prepareTagUpdate");
    const current = state.tags.find((tag) => tag.id === id);
    if (!current) throw new Error("tag_not_found");
    return { ...current, ...patch };
  };
  const updateAtomic: WorkspaceClient["updateTagAtomic"] = async (id, body) => {
    bump("updateTagAtomic");
    const index = state.tags.findIndex((tag) => tag.id === id);
    const updated = { ...(index >= 0 ? state.tags[index] : { id, name: id }), ...body, id } as EntitySummary;
    if (index >= 0) state.tags[index] = updated;
    else state.tags.push(updated);
    return updated;
  };
  const deleteAtomic: WorkspaceClient["deleteTagAtomic"] = async (id) => {
    bump("deleteTagAtomic");
    state.tags = state.tags.filter((tag) => tag.id !== id);
    state.deleted.push({ entityType: "tag", id });
  };
  return {
    async listTags(filter) {
      bump("listTags");
      let rows = state.tags;
      if (filter?.name) {
        const needle = filter.name.toLowerCase();
        rows = rows.filter((t) => t.name.toLowerCase().includes(needle));
      }
      // The real adapter always wires archived=false unless asked (rest/tags.ts).
      const archived = filter?.archived ?? false;
      rows = rows.filter((t) => Boolean(t.archived) === archived);
      return fakeListResult(seed, "listTags", rows);
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
    prepareTagUpdate: prepareUpdate,
    updateTagAtomic: updateAtomic,
    async deleteTag(id) {
      bump("deleteTag");
      state.tags = state.tags.filter((t) => t.id !== id);
      state.deleted.push({ entityType: "tag", id });
    },
    deleteTagAtomic: deleteAtomic,
  };
}
