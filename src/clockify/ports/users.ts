import type { EntitySummary } from "../types.js";

export interface UserSummary extends EntitySummary {
  email?: string;
  status?: string;
}

export interface GroupSummary extends EntitySummary {
  userIds?: string[];
}

/** Workspace member (Team-section) billing-rate write (minor units on the wire). */
export interface UpdateWorkspaceMemberRateInput {
  userId: string;
  rateKind: "HOURLY" | "COST";
  amountMinor: number;
  since?: string;
}

/**
 * User & group slice of the {@link WorkspaceClient} port (goclmcp §2.13). Reads
 * are immediate; the writes run from the handler. Gotchas pinned by the unit
 * tests: invite is `POST /users?send-email={bool}` with `{email}`; role is
 * `POST /users/{id}/roles {entityId,role}` (the route has no PUT — spec + goclmcp,
 * which live-pinned the POST); the Team-section member rate is
 * `PUT /users/{id}/{hourly-rate|cost-rate} {amount}`; deactivate is
 * `PUT /users/{id} {status:INACTIVE}`; groups live under `/user-groups`, the
 * single GET is a list-scan, members are `…/{id}/users`.
 */
export interface UserPort {
  listUsers(): Promise<UserSummary[]>;
  inviteUser(email: string, sendEmail: boolean): Promise<EntitySummary>;
  updateUserRole(userId: string, role: string, entityId: string, sourceType?: string): Promise<EntitySummary>;
  /** Set a workspace member's default hourly/cost rate (the Team-section rate). */
  updateWorkspaceMemberRate(input: UpdateWorkspaceMemberRateInput): Promise<void>;
  deactivateUser(userId: string): Promise<EntitySummary>;
  listGroups(): Promise<GroupSummary[]>;
  getGroup(id: string): Promise<GroupSummary | null>;
  createGroup(name: string): Promise<EntitySummary>;
  updateGroup(id: string, name: string): Promise<EntitySummary>;
  deleteGroup(id: string): Promise<void>;
  addUserToGroup(groupId: string, userId: string): Promise<void>;
  removeUserFromGroup(groupId: string, userId: string): Promise<void>;
}
