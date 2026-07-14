import type { WorkspaceClient } from "../../../src/clockify/client.js";
import type { UserSummary, GroupSummary } from "../../../src/clockify/ports/users.js";
import { fakeListResult, type FakeContext } from "./state.js";

export function makeFakeUsers({ state, seed, bump, nextId }: FakeContext): Pick<
  WorkspaceClient,
  | "listUsers"
  | "getWorkspaceMemberRole"
  | "getCalendarContext"
  | "inviteUser"
  | "updateUserRole"
  | "updateWorkspaceMemberRate"
  | "deactivateUser"
  | "listGroups"
  | "getGroup"
  | "createGroup"
  | "updateGroup"
  | "deleteGroup"
  | "addUserToGroup"
  | "removeUserFromGroup"
> {
  return {
    async listUsers() {
      bump("listUsers");
      return fakeListResult(seed, "listUsers", state.users);
    },
    async getWorkspaceMemberRole(userId): Promise<string | undefined> {
      bump("getWorkspaceMemberRole");
      return state.memberRoles[userId] ?? "ADMIN";
    },
    async getCalendarContext() {
      bump("getCalendarContext");
      return state.calendarContext;
    },
    async inviteUser(email, sendEmail) {
      bump("inviteUser");
      void sendEmail;
      const u: UserSummary = { id: nextId("user"), name: email, email, status: "PENDING" };
      state.users.push(u);
      return { id: u.id, name: u.name };
    },
    async updateUserRole(userId, role, entityId, sourceType) {
      bump("updateUserRole");
      void entityId;
      void sourceType;
      const u = state.users.find((x) => x.id === userId);
      if (u) u.status = `ROLE:${role}`;
      return { id: userId, name: role };
    },
    async updateWorkspaceMemberRate(input) {
      bump("updateWorkspaceMemberRate");
      void input;
    },
    async deactivateUser(userId) {
      bump("deactivateUser");
      const u = state.users.find((x) => x.id === userId);
      if (u) u.status = "INACTIVE";
      return { id: userId, name: "INACTIVE" };
    },
    async listGroups() {
      bump("listGroups");
      return fakeListResult(seed, "listGroups", state.groups);
    },
    async getGroup(id) {
      bump("getGroup");
      return state.groups.find((g) => g.id === id) ?? null;
    },
    async createGroup(name) {
      bump("createGroup");
      const g: GroupSummary = { id: nextId("grp"), name, userIds: [] };
      state.groups.push(g);
      return { id: g.id, name: g.name };
    },
    async updateGroup(id, name) {
      bump("updateGroup");
      const g = state.groups.find((x) => x.id === id);
      if (g) g.name = name;
      return { id, name };
    },
    async deleteGroup(id) {
      bump("deleteGroup");
      state.groups = state.groups.filter((g) => g.id !== id);
      state.deleted.push({ entityType: "group", id });
    },
    async addUserToGroup(groupId, userId) {
      bump("addUserToGroup");
      const g = state.groups.find((x) => x.id === groupId);
      if (g) g.userIds = [...(g.userIds ?? []), userId];
    },
    async removeUserFromGroup(groupId, userId) {
      bump("removeUserFromGroup");
      const g = state.groups.find((x) => x.id === groupId);
      if (g) g.userIds = (g.userIds ?? []).filter((u) => u !== userId);
    },
  };
}
