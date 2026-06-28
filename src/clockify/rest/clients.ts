import type { RestCore } from "./core.js";
import type { ClientPort } from "../ports/clients.js";
import { mapEntitySummary } from "./common.js";

/**
 * Typed client REST module (goclmcp §2.4). `updateClient` is GET-then-merge-PUT
 * (PUT replaces, requires `name`). `deleteClient` archives (PUT name+archived)
 * then deletes — Clockify rejects deleting an active client, and rejects the
 * delete entirely if the client still has active projects (the error surfaces).
 */
export function makeClientRest(core: RestCore, workspaceId: string): ClientPort {
  const ws = `/workspaces/${workspaceId}`;
  const map = mapEntitySummary;

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
    async createClient({ name, ccEmails, currencyId }) {
      const created = (await core.call("api", "POST", `${ws}/clients`, { name })) as { id: string };
      // POST /clients SILENTLY DROPS ccEmails/currencyId (live-probed: only name+email
      // stick) — apply them via the verified GET-then-PUT path, same class as the
      // invoice note/subject silent-drop. A name-only create stays a single POST.
      const extra: Record<string, unknown> = {};
      if (ccEmails !== undefined) extra.ccEmails = ccEmails;
      if (currencyId !== undefined) extra.currencyId = currencyId;
      if (Object.keys(extra).length > 0) {
        return map(await core.getThenPut("api", `${ws}/clients/${created.id}`, extra));
      }
      return map(created);
    },
    async updateClient(id, patch) {
      const c = await core.getThenPut("api", `${ws}/clients/${id}`, patch);
      return map(c);
    },
    async deleteClient(id) {
      await core.getThenPut("api", `${ws}/clients/${id}`, { archived: true }); // archive first
      await core.call("api", "DELETE", `${ws}/clients/${id}`);
    },
    async listCurrencies() {
      // Currencies live on the workspace doc (`GET /workspaces/{id}` → `currencies[]`),
      // not a standalone list endpoint (live-verified). Workspace-scoped GET is allowed.
      const doc = (await core.call("api", "GET", ws)) as { currencies?: Array<{ id: string; code: string }> } | null;
      return (doc?.currencies ?? []).map((c) => ({ id: c.id, code: c.code }));
    },
  };
}
