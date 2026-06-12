import type { WorkspaceClient } from "../../../src/clockify/client.js";
import type { HolidaySummary } from "../../../src/clockify/ports/holidays.js";
import type { FakeContext } from "./state.js";

export function makeFakeHolidays({ state, bump, nextId }: FakeContext): Pick<
  WorkspaceClient,
  | "listHolidays"
  | "getHoliday"
  | "listHolidaysInPeriod"
  | "createHoliday"
  | "updateHoliday"
  | "deleteHoliday"
> {
  return {
    async listHolidays() {
      bump("listHolidays");
      return state.holidays;
    },
    async getHoliday(id) {
      bump("getHoliday");
      return state.holidays.find((h) => h.id === id) ?? null;
    },
    async listHolidaysInPeriod(input) {
      bump("listHolidaysInPeriod");
      void input;
      return state.holidays;
    },
    async createHoliday(input) {
      bump("createHoliday");
      const holiday: HolidaySummary = {
        id: nextId("hol"),
        name: input.name,
        startDate: input.startDate,
        endDate: input.endDate ?? input.startDate,
        occursAnnually: input.occursAnnually,
        ...(input.userIds?.length ? { userIds: input.userIds } : {}),
        ...(input.userGroupIds?.length ? { userGroupIds: input.userGroupIds } : {}),
      };
      state.holidays.push(holiday);
      return { id: holiday.id, name: holiday.name };
    },
    async updateHoliday(id, patch) {
      bump("updateHoliday");
      const index = state.holidays.findIndex((h) => h.id === id);
      const base: HolidaySummary = index >= 0 ? state.holidays[index] : { id, name: id };
      const updated: HolidaySummary = {
        ...base,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.startDate !== undefined ? { startDate: patch.startDate } : {}),
        ...(patch.endDate !== undefined ? { endDate: patch.endDate } : {}),
        ...(patch.occursAnnually !== undefined ? { occursAnnually: patch.occursAnnually } : {}),
        ...(patch.userIds?.length ? { userIds: patch.userIds } : {}),
        ...(patch.userGroupIds?.length ? { userGroupIds: patch.userGroupIds } : {}),
      };
      if (index >= 0) state.holidays[index] = updated;
      else state.holidays.push(updated);
      return { id, name: updated.name };
    },
    async deleteHoliday(id) {
      bump("deleteHoliday");
      state.holidays = state.holidays.filter((h) => h.id !== id);
      state.deleted.push({ entityType: "holiday", id });
    },
  };
}
