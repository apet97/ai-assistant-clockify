import type { EntitySummary, ListResult } from "../types.js";

export interface HolidaySummary extends EntitySummary {
  startDate?: string;
  endDate?: string;
  occursAnnually?: boolean;
  /** Assigned user / user-group ids (the real holiday GET returns these). */
  userIds?: string[];
  userGroupIds?: string[];
  everyoneIncludingNew?: boolean;
}

export interface CreateHolidayInput {
  name: string;
  startDate: string; // YYYY-MM-DD
  endDate?: string; // defaults to startDate (single day)
  occursAnnually?: boolean;
  /** Clockify rejects a holiday with no assignment — supply userIds and/or userGroupIds. */
  userIds?: string[];
  userGroupIds?: string[];
}

export interface UpdateHolidayInput {
  name?: string;
  startDate?: string;
  endDate?: string;
  occursAnnually?: boolean;
  userIds?: string[];
  userGroupIds?: string[];
}
export interface PreparedHolidayUpdateInput extends CreateHolidayInput {
  everyoneIncludingNew?: boolean;
  source: HolidaySummary;
}

/**
 * Holiday slice of the {@link WorkspaceClient} port (goclmcp §2.9 — holidays).
 * Reads are immediate; create (safe write) / update / delete run from the
 * handler. Gotchas pinned by the unit tests: list is a bare array; the single
 * GET is a list-scan (no `/holidays/{id}` route); create/update use a
 * `datePeriod:{startDate,endDate}` and a `users`/`userGroups` `{contains,ids,
 * status}` assignment filter; update is a full PUT.
 */
export interface HolidayPort {
  listHolidays(): Promise<ListResult<HolidaySummary>>;
  getHoliday(id: string): Promise<HolidaySummary | null>;
  listHolidaysInPeriod(input: { assignedTo: string; start: string; end: string }): Promise<ListResult<HolidaySummary>>;
  createHoliday(input: CreateHolidayInput): Promise<EntitySummary>;
  createHolidayAtomic(input: CreateHolidayInput): Promise<EntitySummary>;
  updateHoliday(id: string, patch: UpdateHolidayInput): Promise<EntitySummary>;
  prepareHolidayUpdate(id: string, patch: UpdateHolidayInput): Promise<PreparedHolidayUpdateInput>;
  /** Complete controlled holiday projection for replacement verification. */
  getHolidayMutationState(id: string): Promise<HolidaySummary | null>;
  updateHolidayAtomic(id: string, input: PreparedHolidayUpdateInput): Promise<EntitySummary>;
  deleteHoliday(id: string): Promise<void>;
  deleteHolidayAtomic(id: string): Promise<void>;
}
