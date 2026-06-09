import type { WorkspaceClient } from "../../../src/clockify/client.js";
import type { AssignmentSummary } from "../../../src/clockify/ports/scheduling.js";
import type { FakeContext } from "./state.js";

export function makeFakeScheduling({ state, bump, nextId }: FakeContext): Pick<
  WorkspaceClient,
  | "listAssignments"
  | "getAssignment"
  | "createAssignment"
  | "updateAssignment"
  | "deleteAssignment"
  | "publishSchedule"
  | "getProjectScheduleTotals"
  | "getUserScheduleTotals"
> {
  return {
    async listAssignments(filter) {
      bump("listAssignments");
      let rows = state.assignments;
      if (filter?.userId) rows = rows.filter((a) => a.userId === filter.userId);
      if (filter?.projectId) rows = rows.filter((a) => a.projectId === filter.projectId);
      return rows;
    },
    async getAssignment(id) {
      bump("getAssignment");
      return state.assignments.find((a) => a.id === id) ?? null;
    },
    async createAssignment(input) {
      bump("createAssignment");
      const a: AssignmentSummary = {
        id: nextId("asg"),
        userId: input.userId,
        projectId: input.projectId,
        start: input.start,
        end: input.end,
        hoursPerDay: input.hoursPerDay,
        note: input.note,
        published: false,
      };
      state.assignments.push(a);
      return { id: a.id, name: a.id };
    },
    async updateAssignment(id, patch) {
      bump("updateAssignment");
      const a = state.assignments.find((x) => x.id === id);
      if (a) {
        if (patch.hoursPerDay !== undefined) a.hoursPerDay = patch.hoursPerDay;
        if (patch.note !== undefined) a.note = patch.note;
      }
      return { id, name: id };
    },
    async deleteAssignment(id, seriesUpdateOption) {
      bump("deleteAssignment");
      void seriesUpdateOption;
      state.assignments = state.assignments.filter((a) => a.id !== id);
      state.deleted.push({ entityType: "assignment", id });
    },
    async publishSchedule(input) {
      bump("publishSchedule");
      void input;
    },
    async getProjectScheduleTotals(input) {
      bump("getProjectScheduleTotals");
      void input;
      return [];
    },
    async getUserScheduleTotals(userId, range) {
      bump("getUserScheduleTotals");
      void range;
      return { userId };
    },
  };
}
