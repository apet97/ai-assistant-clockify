import type { RestCore } from "./core.js";
import type { TagPort } from "../ports/tags.js";
import { mapEntitySummary } from "./common.js";

/**
 * Typed tag REST module (goclmcp §2.5). `updateTag` is GET-then-merge-PUT (PUT
 * replaces, requires `name`). Tags delete with a plain DELETE.
 */
export function makeTagRest(core: RestCore, workspaceId: string): TagPort {
  const ws = `/workspaces/${workspaceId}`;
  const map = mapEntitySummary;

  return {
    async listTags(filter) {
      const params: Record<string, string> = { archived: String(filter?.archived ?? false) };
      if (filter?.name) params.name = filter.name;
      const result = await core.paginate("api", `${ws}/tags`, params);
      return { ...result, rows: result.rows.map(map) };
    },
    async getTag(id) {
      const t = await core.call("api", "GET", `${ws}/tags/${id}`, undefined, true);
      return t ? map(t) : null;
    },
    async createTag({ name }) {
      const t = await core.call("api", "POST", `${ws}/tags`, { name });
      return map(t);
    },
    async updateTag(id, patch) {
      const t = await core.getThenPut("api", `${ws}/tags/${id}`, patch);
      return map(t);
    },
    async deleteTag(id) {
      await core.call("api", "DELETE", `${ws}/tags/${id}`);
    },
  };
}
