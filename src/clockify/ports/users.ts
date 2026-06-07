import type { EntitySummary } from "../client.js";

export interface UserSummary extends EntitySummary {
  email?: string;
  status?: string;
}

export interface GroupSummary extends EntitySummary {
  userIds?: string[];
}

/**
 * User & group slice of the {@link WorkspaceClient} port (goclmcp §2.13). Reads
 * are immediate; the writes run from the handler. Gotchas pinned by the unit
 * tests: invite is `POST /users?send-email={bool}` with `{email}`; role is
 * `PUT /users/{id}/roles {entityId,role}`; deactivate is `PUT /users/{id}
 * {status:INACTIVE}`; groups live under `/user-groups`, the single GET is a
 * list-scan, members are `…/{id}/users`.
 */
export interface UserPort {
  listUsers(): Promise<UserSummary[]>;
  inviteUser(email: string, sendEmail: boolean): Promise<EntitySummary>;
  updateUserRole(userId: string, role: string, entityId: string): Promise<EntitySummary>;
  deactivateUser(userId: string): Promise<EntitySummary>;
  listGroups(): Promise<GroupSummary[]>;
  getGroup(id: string): Promise<GroupSummary | null>;
  createGroup(name: string): Promise<EntitySummary>;
  updateGroup(id: string, name: string): Promise<EntitySummary>;
  deleteGroup(id: string): Promise<void>;
  addUserToGroup(groupId: string, userId: string): Promise<void>;
  removeUserFromGroup(groupId: string, userId: string): Promise<void>;
}
