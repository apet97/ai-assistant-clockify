import type { EntitySummary, WorkspaceClient } from "../../../src/clockify/client.js";
import { fakeListResult, type FakeContext } from "./state.js";

export function makeFakeClients({ state, seed, bump, nextId }: FakeContext): Pick<
  WorkspaceClient,
  "listClients" | "getClient" | "createClient" | "updateClient" | "deleteClient" | "listCurrencies"
> {
  return {
    async listClients(filter) {
      bump("listClients");
      let rows = state.clients;
      if (filter?.name) {
        const needle = filter.name.toLowerCase();
        rows = rows.filter((c) => c.name.toLowerCase().includes(needle));
      }
      if (filter?.archived !== undefined) {
        rows = rows.filter((c) => Boolean(c.archived) === filter.archived);
      }
      return fakeListResult(seed, "listClients", rows);
    },
    async getClient(id) {
      bump("getClient");
      return state.clients.find((c) => c.id === id) ?? null;
    },
    async createClient({ name, ccEmails, currencyId }) {
      bump("createClient");
      // Echo the create-then-PUT fields so tests can assert they were threaded through.
      const c = { id: nextId("client"), name, ...(ccEmails ? { ccEmails } : {}), ...(currencyId ? { currencyId } : {}) } as EntitySummary;
      state.clients.push(c);
      return c;
    },
    async updateClient(id, patch) {
      bump("updateClient");
      const index = state.clients.findIndex((c) => c.id === id);
      const base: EntitySummary = index >= 0 ? state.clients[index] : { id, name: id };
      const updated: EntitySummary = {
        ...base,
        ...(typeof patch.name === "string" ? { name: patch.name } : {}),
        ...(typeof patch.archived === "boolean" ? { archived: patch.archived } : {}),
      };
      if (index >= 0) state.clients[index] = updated;
      else state.clients.push(updated);
      return updated;
    },
    async deleteClient(id) {
      bump("deleteClient");
      state.clients = state.clients.filter((c) => c.id !== id);
      state.deleted.push({ entityType: "client", id });
    },
    async listCurrencies() {
      bump("listCurrencies");
      return fakeListResult(seed, "listCurrencies", state.currencies);
    },
  };
}
