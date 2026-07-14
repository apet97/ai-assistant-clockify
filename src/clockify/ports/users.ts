import type { EntitySummary, ListResult } from "../types.js";

export interface UserSummary extends EntitySummary {
  email?: string;
  status?: string;
}

export interface GroupSummary extends EntitySummary {
  userIds?: string[];
}

export interface CalendarContext {
  timeZone: string;
  /** ISO weekday number (Monday=1 … Sunday=7). */
  weekStartsOn: number;
}

export interface UserRoleAssignment {
  role: string;
  entityId: string;
  sourceType?: string;
}

export interface WorkspaceMemberRateSnapshot {
  userId: string;
  rateKind: "HOURLY" | "COST";
  amountMinor: number | null;
  since?: string;
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
  listUsers(): Promise<ListResult<UserSummary>>;
  /**
   * The caller's CURRENT workspace role string (e.g. "ADMIN"/"OWNER"/"MEMBER"),
   * or undefined if the member can't be resolved. Used by the opt-in per-request
   * admin re-check (authz-surface-01); a single-member read, never a full scan.
   */
  getWorkspaceMemberRole(userId: string): Promise<string | undefined>;
  listUserRoleAssignments(userId: string): Promise<ListResult<UserRoleAssignment>>;
  getWorkspaceMemberRate(userId: string, rateKind: "HOURLY" | "COST"): Promise<WorkspaceMemberRateSnapshot | null>;
  /** Current admin settings first, workspace settings second; undefined if unverified. */
  getCalendarContext(userId: string): Promise<CalendarContext | undefined>;
  inviteUserAtomic(email: string, sendEmail: boolean): Promise<EntitySummary>;
  updateUserRoleAtomic(userId: string, role: string, entityId: string, sourceType?: string): Promise<EntitySummary>;
  updateWorkspaceMemberRateAtomic(input: UpdateWorkspaceMemberRateInput): Promise<void>;
  deactivateUserAtomic(userId: string): Promise<EntitySummary>;
  inviteUser(email: string, sendEmail: boolean): Promise<EntitySummary>;
  updateUserRole(userId: string, role: string, entityId: string, sourceType?: string): Promise<EntitySummary>;
  /** Set a workspace member's default hourly/cost rate (the Team-section rate). */
  updateWorkspaceMemberRate(input: UpdateWorkspaceMemberRateInput): Promise<void>;
  deactivateUser(userId: string): Promise<EntitySummary>;
  listGroups(): Promise<ListResult<GroupSummary>>;
  getGroup(id: string): Promise<GroupSummary | null>;
  createGroupAtomic(name: string): Promise<EntitySummary>;
  updateGroupAtomic(id: string, name: string): Promise<EntitySummary>;
  deleteGroupAtomic(id: string): Promise<void>;
  addUserToGroupAtomic(groupId: string, userId: string): Promise<void>;
  removeUserFromGroupAtomic(groupId: string, userId: string): Promise<void>;
  createGroup(name: string): Promise<EntitySummary>;
  updateGroup(id: string, name: string): Promise<EntitySummary>;
  deleteGroup(id: string): Promise<void>;
  addUserToGroup(groupId: string, userId: string): Promise<void>;
  removeUserFromGroup(groupId: string, userId: string): Promise<void>;
}
