import type { RestCore } from "./core.js";
import type { EntitySummary } from "../client.js";
import type { WorkspacePort } from "../ports/workspace.js";

function mapTemplate(raw: any): EntitySummary {
  const out: EntitySummary = { id: raw.id, name: raw.name ?? raw.id };
  if (typeof raw.archived === "boolean") out.archived = raw.archived;
  return out;
}

/**
 * Typed workspace & project-template REST module (goclmcp §2.16–2.17). I/O only.
 * `getWorkspace` reads the workspace list (`GET /workspaces`) and returns the
 * current one; templates are projects flagged `is-template=true`.
 */
export function makeWorkspaceRest(core: RestCore, workspaceId: string): WorkspacePort {
  const ws = `/workspaces/${workspaceId}`;

  return {
    async getWorkspace() {
      const rows = (await core.call("api", "GET", "/workspaces")) as any[] | null;
      const found = (Array.isArray(rows) ? rows : []).find((w) => w.id === workspaceId);
      return found ?? null;
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
