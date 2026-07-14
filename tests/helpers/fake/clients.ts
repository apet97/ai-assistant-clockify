import type { EntitySummary, WorkspaceClient } from "../../../src/clockify/client.js";
import { fakeListResult, type FakeContext } from "./state.js";

export function makeFakeClients({ state, seed, bump, nextId }: FakeContext): Pick<
  WorkspaceClient,
  "listClients" | "getClient" | "getClientMutationState" | "createClient" | "updateClient" | "deleteClient" | "listCurrencies" |
  "createClientBaseAtomic" | "prepareClientUpdate" | "updateClientAtomic" | "deleteClientAtomic"
> {
  const createBaseAtomic: WorkspaceClient["createClientBaseAtomic"] = async ({ name }) => {
    bump("createClientBaseAtomic");
    const client = { id: nextId("client"), name };
    state.clients.push(client);
    return client;
  };
  const prepareUpdate: WorkspaceClient["prepareClientUpdate"] = async (id, patch) => {
    bump("prepareClientUpdate");
    const current = state.clients.find((client) => client.id === id);
    if (!current) throw new Error("client_not_found");
    return { ...current, ...patch };
  };
  const updateAtomic: WorkspaceClient["updateClientAtomic"] = async (id, body) => {
    bump("updateClientAtomic");
    const index = state.clients.findIndex((client) => client.id === id);
    const updated = { ...(index >= 0 ? state.clients[index] : { id, name: id }), ...body, id } as EntitySummary;
    if (index >= 0) state.clients[index] = updated;
    else state.clients.push(updated);
    return updated;
  };
  const deleteAtomic: WorkspaceClient["deleteClientAtomic"] = async (id) => {
    bump("deleteClientAtomic");
    state.clients = state.clients.filter((client) => client.id !== id);
    state.deleted.push({ entityType: "client", id });
  };
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
    async getClientMutationState(id) {
      bump("getClientMutationState");
      const row = state.clients.find((client) => client.id === id);
      return row ? { ...row } as Record<string, unknown> : null;
    },
    async createClient({ name, ccEmails, currencyId }) {
      bump("createClient");
      // Echo the create-then-PUT fields so tests can assert they were threaded through.
      const c = { id: nextId("client"), name, ...(ccEmails ? { ccEmails } : {}), ...(currencyId ? { currencyId } : {}) } as EntitySummary;
      state.clients.push(c);
      return c;
    },
    createClientBaseAtomic: createBaseAtomic,
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
    prepareClientUpdate: prepareUpdate,
    updateClientAtomic: updateAtomic,
    async deleteClient(id) {
      bump("deleteClient");
      state.clients = state.clients.filter((c) => c.id !== id);
      state.deleted.push({ entityType: "client", id });
    },
    deleteClientAtomic: deleteAtomic,
    async listCurrencies() {
      bump("listCurrencies");
      return fakeListResult(seed, "listCurrencies", state.currencies);
    },
  };
}
