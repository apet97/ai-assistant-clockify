import type { WorkspaceClient } from "../../../src/clockify/client.js";
import type { HolidaySummary } from "../../../src/clockify/ports/holidays.js";
import { fakeListResult, type FakeContext } from "./state.js";

export function makeFakeHolidays({ state, seed, bump, nextId }: FakeContext): Pick<
  WorkspaceClient,
  | "listHolidays"
  | "getHoliday"
  | "listHolidaysInPeriod"
  | "createHoliday"
  | "createHolidayAtomic"
  | "updateHoliday"
  | "prepareHolidayUpdate"
  | "getHolidayMutationState"
  | "updateHolidayAtomic"
  | "deleteHoliday"
  | "deleteHolidayAtomic"
> {
  return {
    async listHolidays() {
      bump("listHolidays");
      return fakeListResult(seed, "listHolidays", state.holidays);
    },
    async getHoliday(id) {
      bump("getHoliday");
      return state.holidays.find((h) => h.id === id) ?? null;
    },
    async listHolidaysInPeriod(input) {
      bump("listHolidaysInPeriod");
      void input;
      return fakeListResult(seed, "listHolidaysInPeriod", state.holidays);
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
    async createHolidayAtomic(input) {
      bump("createHolidayAtomic");
      const holiday: HolidaySummary = { id: nextId("hol"), name: input.name, startDate: input.startDate, endDate: input.endDate ?? input.startDate, ...(input.occursAnnually !== undefined ? { occursAnnually: input.occursAnnually } : {}), ...(input.userIds?.length ? { userIds: input.userIds } : {}), ...(input.userGroupIds?.length ? { userGroupIds: input.userGroupIds } : {}) };
      state.holidays.push(holiday);
      return holiday;
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
    async prepareHolidayUpdate(id, patch) {
      bump("prepareHolidayUpdate");
      const holiday = state.holidays.find((row) => row.id === id);
      if (!holiday?.startDate) throw new Error("holiday_not_found");
      return { ...holiday, ...patch, name: patch.name ?? holiday.name, startDate: patch.startDate ?? holiday.startDate, endDate: patch.endDate ?? holiday.endDate ?? holiday.startDate, source: structuredClone(holiday) };
    },
    async getHolidayMutationState(id) {
      bump("getHolidayMutationState");
      const holiday = state.holidays.find((row) => row.id === id);
      return holiday ? structuredClone(holiday) : null;
    },
    async updateHolidayAtomic(id, input) {
      bump("updateHolidayAtomic");
      const index = state.holidays.findIndex((row) => row.id === id);
      if (index < 0) throw new Error("holiday_not_found");
      const { source: _source, ...body } = input;
      state.holidays[index] = { ...state.holidays[index]!, ...body, id };
      return { id, name: state.holidays[index]!.name };
    },
    async deleteHoliday(id) {
      bump("deleteHoliday");
      state.holidays = state.holidays.filter((h) => h.id !== id);
      state.deleted.push({ entityType: "holiday", id });
    },
    async deleteHolidayAtomic(id) {
      bump("deleteHolidayAtomic");
      state.holidays = state.holidays.filter((holiday) => holiday.id !== id);
      state.deleted.push({ entityType: "holiday", id });
    },
  };
}
