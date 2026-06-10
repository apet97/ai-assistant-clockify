import type { RestCore } from "./core.js";
import type { EntitySummary } from "../types.js";
import type { WorkspacePort } from "../ports/workspace.js";

function mapTemplate(raw: any): EntitySummary {
  const out: EntitySummary = { id: raw.id, name: raw.name ?? raw.id };
  if (typeof raw.archived === "boolean") out.archived = raw.archived;
  return out;
}

/**
 * Typed workspace & project-template REST module (goclmcp §2.16–2.17). I/O only.
 * `getWorkspace` GETs the single workspace path: the account-level
 * `GET /workspaces` list 401s "API is not accessible" for ADD-ON tokens (they
 * are bound to one workspace; probed live 2026-06-10) while the scoped
 * `GET /workspaces/{id}` returns the full body on the same token. Templates are
 * projects flagged `is-template=true`.
 */
export function makeWorkspaceRest(core: RestCore, workspaceId: string): WorkspacePort {
  const ws = `/workspaces/${workspaceId}`;

  return {
    async getWorkspace() {
      return (await core.call("api", "GET", ws, undefined, true)) ?? null;
    },
    async listTemplates() {
      const rows = (await core.call("api", "GET", `${ws}/projects?is-template=true`)) as any[] | null;
      return (Array.isArray(rows) ? rows : []).map(mapTemplate);
    },
    async getTemplate(id) {
      const raw = await core.call("api", "GET", `${ws}/projects/${id}`, undefined, true);
      return raw ? mapTemplate(raw) : null;
    },
  };
}
