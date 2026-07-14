import type { WorkspaceClient } from "../../../src/clockify/client.js";
import { fakeListResult, type FakeContext } from "./state.js";

export function makeFakeWorkspace({ state, seed, bump }: FakeContext): Pick<
  WorkspaceClient,
  "getWorkspace" | "listTemplates" | "getTemplate"
> {
  return {
    async getWorkspace() {
      bump("getWorkspace");
      return { id: "ws-1", name: "Fake Workspace", currencies: [{ code: "USD", isDefault: true }] };
    },
    async listTemplates() {
      bump("listTemplates");
      return fakeListResult(
        seed,
        "listTemplates",
        state.projects.filter((p) => p.name.toLowerCase().includes("template")),
      );
    },
    async getTemplate(id) {
      bump("getTemplate");
      return state.projects.find((p) => p.id === id) ?? null;
    },
  };
}
