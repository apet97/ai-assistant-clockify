import type { RestCore } from "./core.js";
import type { ClientPort } from "../ports/clients.js";
import type { EntitySummary } from "../types.js";

/**
 * Typed client REST module (goclmcp §2.4). `updateClient` is GET-then-merge-PUT
 * (PUT replaces, requires `name`). `deleteClient` archives (PUT name+archived)
 * then deletes — Clockify rejects deleting an active client, and rejects the
 * delete entirely if the client still has active projects (the error surfaces).
 */
export function makeClientRest(core: RestCore, workspaceId: string): ClientPort {
  const ws = `/workspaces/${workspaceId}`;
  const map = (c: any): EntitySummary => ({ id: c.id, name: c.name, archived: c.archived });

  return {
    async listClients(filter) {
      const params: Record<string, string> = {};
      if (filter?.name) params.name = filter.name;
      if (filter?.archived !== undefined) params.archived = String(filter.archived);
      const rows = await core.paginate("api", `${ws}/clients`, params);
      return rows.map(map);
    },
    async getClient(id) {
      const c = await core.call("api", "GET", `${ws}/clients/${id}`, undefined, true);
      return c ? map(c) : null;
    },
    async createClient({ name }) {
      const c = await core.call("api", "POST", `${ws}/clients`, { name });
      return map(c);
    },
    async updateClient(id, patch) {
      const c = await core.getThenPut("api", `${ws}/clients/${id}`, patch);
      return map(c);
    },
    async deleteClient(id) {
      await core.getThenPut("api", `${ws}/clients/${id}`, { archived: true }); // archive first
      await core.call("api", "DELETE", `${ws}/clients/${id}`);
    },
  };
}
