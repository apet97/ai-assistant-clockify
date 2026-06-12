import type { RestCore } from "./core.js";
import type { EntitySummary } from "../types.js";
import type { UserPort, UserSummary, GroupSummary } from "../ports/users.js";

function mapUser(raw: any): UserSummary {
  const out: UserSummary = { id: raw.id, name: raw.name ?? raw.email ?? raw.id };
  if (raw.email !== undefined) out.email = raw.email;
  if (raw.status !== undefined) out.status = raw.status;
  return out;
}

function mapGroup(raw: any): GroupSummary {
  const out: GroupSummary = { id: raw.id, name: raw.name ?? raw.id };
  if (Array.isArray(raw.userIds)) out.userIds = raw.userIds;
  return out;
}

/**
 * Typed user & group REST module (goclmcp §2.13). I/O only. Shapes pinned by the
 * unit tests: invite is `POST /users?send-email={bool}`; role is
 * `POST /users/{id}/roles {entityId,role}` (the route has no PUT — spec +
 * goclmcp, which live-pinned the POST); deactivate is `PUT /users/{id}
 * {status:INACTIVE}`; groups live under `/user-groups` (single GET is a
 * list-scan), members under `…/{id}/users`.
 */
export function makeUserRest(core: RestCore, workspaceId: string): UserPort {
  const ws = `/workspaces/${workspaceId}`;

  return {
    async listUsers() {
      const rows = (await core.call("api", "GET", `${ws}/users`)) as any[] | null;
      return (Array.isArray(rows) ? rows : []).map(mapUser);
    },
    async inviteUser(email, sendEmail): Promise<EntitySummary> {
      const qs = new URLSearchParams({ "send-email": String(sendEmail) });
      const u = (await core.call("api", "POST", `${ws}/users?${qs.toString()}`, { email })) as { id?: string; name?: string };
      return { id: u?.id ?? email, name: u?.name ?? email };
    },
    async updateUserRole(userId, role, entityId, sourceType): Promise<EntitySummary> {
      // POST /users/{recipient}/roles {entityId, role, sourceType?}. entityId is the
      // SCOPE: workspaceId (ADMIN), projectId (PROJECT_MANAGER), or a group id with
      // sourceType=USER_GROUP (TEAM_MANAGER of a group). Live-verified 2026-06-12.
      await core.call("api", "POST", `${ws}/users/${userId}/roles`, {
        entityId,
        role,
        ...(sourceType ? { sourceType } : {}),
      });
      return { id: userId, name: role };
    },
    async deactivateUser(userId): Promise<EntitySummary> {
      const u = (await core.call("api", "PUT", `${ws}/users/${userId}`, { status: "INACTIVE" })) as { id?: string } | null;
      return { id: u?.id ?? userId, name: "INACTIVE" };
    },
    async listGroups() {
      const rows = (await core.call("api", "GET", `${ws}/user-groups`)) as any[] | null;
      return (Array.isArray(rows) ? rows : []).map(mapGroup);
    },
    async getGroup(id) {
      const rows = (await core.call("api", "GET", `${ws}/user-groups`)) as any[] | null;
      const raw = (Array.isArray(rows) ? rows : []).find((g) => g.id === id);
      return raw ? mapGroup(raw) : null;
    },
    async createGroup(name): Promise<EntitySummary> {
      const g = (await core.call("api", "POST", `${ws}/user-groups`, { name })) as { id: string; name?: string };
      return { id: g.id, name: g.name ?? name };
    },
    async updateGroup(id, name): Promise<EntitySummary> {
      const g = (await core.call("api", "PUT", `${ws}/user-groups/${id}`, { name })) as { id?: string; name?: string };
      return { id: g?.id ?? id, name: g?.name ?? name };
    },
    async deleteGroup(id) {
      await core.call("api", "DELETE", `${ws}/user-groups/${id}`);
    },
    async addUserToGroup(groupId, userId) {
      await core.call("api", "POST", `${ws}/user-groups/${groupId}/users`, { userId });
    },
    async removeUserFromGroup(groupId, userId) {
      await core.call("api", "DELETE", `${ws}/user-groups/${groupId}/users/${userId}`);
    },
  };
}
