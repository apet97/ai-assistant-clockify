import type { WorkspaceClient } from "../../../src/clockify/client.js";
import type { AssignmentSummary } from "../../../src/clockify/ports/scheduling.js";
import { fakeListResult, type FakeContext } from "./state.js";

export function makeFakeScheduling({ state, seed, bump, nextId }: FakeContext): Pick<
  WorkspaceClient,
  | "listAssignments"
  | "getAssignment"
  | "prepareAssignmentUpdate"
  | "createAssignmentAtomic"
  | "updateAssignmentAtomic"
  | "deleteAssignmentAtomic"
  | "publishScheduleAtomic"
  | "createAssignment"
  | "updateAssignment"
  | "deleteAssignment"
  | "publishSchedule"
  | "getProjectScheduleTotals"
  | "getAllProjectScheduleTotals"
  | "getOneProjectScheduleTotals"
  | "getUserScheduleTotals"
> {
  const createAssignmentAtomic: WorkspaceClient["createAssignmentAtomic"] = async (input) => {
    bump("createAssignmentAtomic");
    bump("createAssignment");
    const a: AssignmentSummary = {
      id: nextId("asg"), userId: input.userId, projectId: input.projectId,
      start: input.start, end: input.end, hoursPerDay: input.hoursPerDay,
      ...(input.startTime !== undefined ? { startTime: input.startTime } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}), published: false,
    };
    state.assignments.push(a);
    return { id: a.id, name: a.id };
  };
  const updateAssignmentAtomic: WorkspaceClient["updateAssignmentAtomic"] = async (id, input) => {
    bump("updateAssignmentAtomic");
    bump("updateAssignment");
    const a = state.assignments.find((x) => x.id === id);
    if (a) Object.assign(a, input);
    return { id, name: id };
  };
  const deleteAssignmentAtomic: WorkspaceClient["deleteAssignmentAtomic"] = async (id, seriesUpdateOption) => {
    bump("deleteAssignmentAtomic");
    bump("deleteAssignment");
    void seriesUpdateOption;
    state.assignments = state.assignments.filter((a) => a.id !== id);
    state.deleted.push({ entityType: "assignment", id });
  };
  const publishScheduleAtomic: WorkspaceClient["publishScheduleAtomic"] = async (input) => {
    bump("publishScheduleAtomic");
    bump("publishSchedule");
    for (const assignment of state.assignments) {
      if (!input.userId || assignment.userId === input.userId) assignment.published = true;
    }
  };
  return {
    async listAssignments(filter) {
      bump("listAssignments");
      let rows = state.assignments;
      if (filter?.userId) rows = rows.filter((a) => a.userId === filter.userId);
      if (filter?.projectId) rows = rows.filter((a) => a.projectId === filter.projectId);
      return fakeListResult(seed, "listAssignments", rows);
    },
    async getAssignment(id) {
      bump("getAssignment");
      return state.assignments.find((a) => a.id === id) ?? null;
    },
    async prepareAssignmentUpdate(id, patch) {
      bump("prepareAssignmentUpdate");
      const a = state.assignments.find((x) => x.id === id);
      if (!a?.userId || !a.projectId || !a.start || !a.end || a.hoursPerDay === undefined) throw new Error("assignment_not_found");
      return {
        userId: a.userId, projectId: a.projectId, start: a.start, end: a.end,
        hoursPerDay: patch.hoursPerDay ?? a.hoursPerDay,
        ...(a.startTime !== undefined ? { startTime: a.startTime } : {}),
        ...(patch.note !== undefined ? { note: patch.note } : a.note !== undefined ? { note: a.note } : {}),
        ...(patch.seriesUpdateOption !== undefined ? { seriesUpdateOption: patch.seriesUpdateOption } : {}),
      };
    },
    createAssignmentAtomic,
    updateAssignmentAtomic,
    deleteAssignmentAtomic,
    publishScheduleAtomic,
    createAssignment: createAssignmentAtomic,
    async updateAssignment(id, patch) {
      const a = state.assignments.find((x) => x.id === id);
      if (!a?.userId || !a.projectId || !a.start || !a.end || a.hoursPerDay === undefined) throw new Error("assignment_not_found");
      return updateAssignmentAtomic(id, {
        userId: a.userId, projectId: a.projectId, start: a.start, end: a.end,
        hoursPerDay: patch.hoursPerDay ?? a.hoursPerDay,
        ...(a.startTime !== undefined ? { startTime: a.startTime } : {}),
        ...(patch.note !== undefined ? { note: patch.note } : a.note !== undefined ? { note: a.note } : {}),
        ...(patch.seriesUpdateOption !== undefined ? { seriesUpdateOption: patch.seriesUpdateOption } : {}),
      });
    },
    deleteAssignment: deleteAssignmentAtomic,
    publishSchedule: publishScheduleAtomic,
    async getAllProjectScheduleTotals(input) {
      bump("getAllProjectScheduleTotals");
      bump("getProjectScheduleTotals");
      void input;
      return fakeListResult(seed, "getAllProjectScheduleTotals", []);
    },
    async getOneProjectScheduleTotals(input) {
      bump("getOneProjectScheduleTotals");
      bump("getProjectScheduleTotals");
      void input;
      return fakeListResult(seed, "getOneProjectScheduleTotals", []);
    },
    async getProjectScheduleTotals(input) {
      bump("getProjectScheduleTotals");
      void input;
      return fakeListResult(seed, "getProjectScheduleTotals", []);
    },
    async getUserScheduleTotals(userId, range) {
      bump("getUserScheduleTotals");
      void range;
      return { userId };
    },
  };
}
