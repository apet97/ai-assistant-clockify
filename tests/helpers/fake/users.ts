import type { WorkspaceClient } from "../../../src/clockify/client.js";
import type { UserSummary, GroupSummary } from "../../../src/clockify/ports/users.js";
import { fakeListResult, type FakeContext } from "./state.js";

export function makeFakeUsers({ state, seed, bump, nextId }: FakeContext): Pick<
  WorkspaceClient,
  | "listUsers"
  | "getWorkspaceMemberRole"
  | "listUserRoleAssignments"
  | "getWorkspaceMemberRate"
  | "getCalendarContext"
  | "inviteUserAtomic"
  | "updateUserRoleAtomic"
  | "updateWorkspaceMemberRateAtomic"
  | "updateWorkspaceMemberHourlyRateAtomic"
  | "updateWorkspaceMemberCostRateAtomic"
  | "deactivateUserAtomic"
  | "inviteUser"
  | "updateUserRole"
  | "updateWorkspaceMemberRate"
  | "deactivateUser"
  | "listGroups"
  | "getGroup"
  | "createGroupAtomic"
  | "updateGroupAtomic"
  | "deleteGroupAtomic"
  | "addUserToGroupAtomic"
  | "removeUserFromGroupAtomic"
  | "createGroup"
  | "updateGroup"
  | "deleteGroup"
  | "addUserToGroup"
  | "removeUserFromGroup"
> {
  const inviteUserAtomic: WorkspaceClient["inviteUserAtomic"] = async (email, sendEmail) => {
    bump("inviteUserAtomic"); bump("inviteUser"); void sendEmail;
    const u: UserSummary = { id: nextId("user"), name: email, email, status: "PENDING" };
    state.users.push(u);
    return { id: u.id, name: u.name };
  };
  const updateUserRoleAtomic: WorkspaceClient["updateUserRoleAtomic"] = async (userId, role, entityId, sourceType) => {
    bump("updateUserRoleAtomic"); bump("updateUserRole");
    const u = state.users.find((x) => x.id === userId);
    if (u) u.status = `ROLE:${role}`;
    const roles = state.userRoleAssignments[userId] ?? [];
    state.userRoleAssignments[userId] = [
      ...roles.filter((candidate) => candidate.entityId !== entityId || candidate.sourceType !== sourceType),
      { role, entityId, ...(sourceType !== undefined ? { sourceType } : {}) },
    ];
    return { id: userId, name: role };
  };
  const applyWorkspaceMemberRate = (
    input: { userId: string; amountMinor: number; since?: string },
    rateKind: "HOURLY" | "COST",
    counter: "updateWorkspaceMemberHourlyRateAtomic" | "updateWorkspaceMemberCostRateAtomic",
  ) => {
    bump(counter);
    state.workspaceMemberRates[input.userId] = {
      ...(state.workspaceMemberRates[input.userId] ?? {}),
      [rateKind]: { amountMinor: input.amountMinor, ...(input.since !== undefined ? { since: input.since } : {}) },
    };
  };
  const updateWorkspaceMemberHourlyRateAtomic: WorkspaceClient["updateWorkspaceMemberHourlyRateAtomic"] = async (input) => {
    applyWorkspaceMemberRate(input, "HOURLY", "updateWorkspaceMemberHourlyRateAtomic");
  };
  const updateWorkspaceMemberCostRateAtomic: WorkspaceClient["updateWorkspaceMemberCostRateAtomic"] = async (input) => {
    applyWorkspaceMemberRate(input, "COST", "updateWorkspaceMemberCostRateAtomic");
  };
  const updateWorkspaceMemberRateAtomic: WorkspaceClient["updateWorkspaceMemberRateAtomic"] = async (input) => {
    if (input.rateKind === "COST") {
      await updateWorkspaceMemberCostRateAtomic(input);
      return;
    }
    await updateWorkspaceMemberHourlyRateAtomic(input);
  };
  const deactivateUserAtomic: WorkspaceClient["deactivateUserAtomic"] = async (userId) => {
    bump("deactivateUserAtomic"); bump("deactivateUser");
    const u = state.users.find((x) => x.id === userId);
    if (u) u.status = "INACTIVE";
    return { id: userId, name: "INACTIVE" };
  };
  const createGroupAtomic: WorkspaceClient["createGroupAtomic"] = async (name) => {
    bump("createGroupAtomic"); bump("createGroup");
    const g: GroupSummary = { id: nextId("grp"), name, userIds: [] };
    state.groups.push(g);
    return { id: g.id, name: g.name };
  };
  const updateGroupAtomic: WorkspaceClient["updateGroupAtomic"] = async (id, name) => {
    bump("updateGroupAtomic"); bump("updateGroup");
    const g = state.groups.find((x) => x.id === id);
    if (g) g.name = name;
    return { id, name };
  };
  const deleteGroupAtomic: WorkspaceClient["deleteGroupAtomic"] = async (id) => {
    bump("deleteGroupAtomic"); bump("deleteGroup");
    state.groups = state.groups.filter((g) => g.id !== id);
    state.deleted.push({ entityType: "group", id });
  };
  const addUserToGroupAtomic: WorkspaceClient["addUserToGroupAtomic"] = async (groupId, userId) => {
    bump("addUserToGroupAtomic"); bump("addUserToGroup");
    const g = state.groups.find((x) => x.id === groupId);
    if (g && !(g.userIds ?? []).includes(userId)) g.userIds = [...(g.userIds ?? []), userId];
  };
  const removeUserFromGroupAtomic: WorkspaceClient["removeUserFromGroupAtomic"] = async (groupId, userId) => {
    bump("removeUserFromGroupAtomic"); bump("removeUserFromGroup");
    const g = state.groups.find((x) => x.id === groupId);
    if (g) g.userIds = (g.userIds ?? []).filter((u) => u !== userId);
  };
  return {
    async listUsers() {
      bump("listUsers");
      return fakeListResult(seed, "listUsers", state.users);
    },
    async getWorkspaceMemberRole(userId): Promise<string | undefined> {
      bump("getWorkspaceMemberRole");
      return state.memberRoles[userId] ?? "ADMIN";
    },
    async listUserRoleAssignments(userId) {
      bump("listUserRoleAssignments");
      return { rows: (state.userRoleAssignments[userId] ?? []).map((row) => ({ ...row })), truncated: seed.listTruncated?.listUsers ?? false };
    },
    async getWorkspaceMemberRate(userId, rateKind) {
      bump("getWorkspaceMemberRate");
      const user = state.users.find((candidate) => candidate.id === userId);
      if (!user) return null;
      const rate = state.workspaceMemberRates[userId]?.[rateKind];
      return { userId, rateKind, amountMinor: rate?.amountMinor ?? null, ...(rate?.since !== undefined ? { since: rate.since } : {}) };
    },
    async getCalendarContext() {
      bump("getCalendarContext");
      return state.calendarContext;
    },
    inviteUserAtomic,
    updateUserRoleAtomic,
    updateWorkspaceMemberRateAtomic,
    updateWorkspaceMemberHourlyRateAtomic,
    updateWorkspaceMemberCostRateAtomic,
    deactivateUserAtomic,
    inviteUser: inviteUserAtomic,
    updateUserRole: updateUserRoleAtomic,
    updateWorkspaceMemberRate: updateWorkspaceMemberRateAtomic,
    deactivateUser: deactivateUserAtomic,
    async listGroups() {
      bump("listGroups");
      return fakeListResult(seed, "listGroups", state.groups);
    },
    async getGroup(id) {
      bump("getGroup");
      return state.groups.find((g) => g.id === id) ?? null;
    },
    createGroupAtomic,
    updateGroupAtomic,
    deleteGroupAtomic,
    addUserToGroupAtomic,
    removeUserFromGroupAtomic,
    createGroup: createGroupAtomic,
    updateGroup: updateGroupAtomic,
    deleteGroup: deleteGroupAtomic,
    addUserToGroup: addUserToGroupAtomic,
    removeUserFromGroup: removeUserFromGroupAtomic,
  };
}
