import type { EntitySummary } from "../client.js";

export interface HolidaySummary extends EntitySummary {
  startDate?: string;
  endDate?: string;
  occursAnnually?: boolean;
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

/**
 * Holiday slice of the {@link WorkspaceClient} port (goclmcp §2.9 — holidays).
 * Reads are immediate; create (safe write) / update / delete run from the
 * handler. Gotchas pinned by the unit tests: list is a bare array; the single
 * GET is a list-scan (no `/holidays/{id}` route); create/update use a
 * `datePeriod:{startDate,endDate}` and a `users`/`userGroups` `{contains,ids,
 * status}` assignment filter; update is a full PUT.
 */
export interface HolidayPort {
  listHolidays(): Promise<HolidaySummary[]>;
  getHoliday(id: string): Promise<HolidaySummary | null>;
  listHolidaysInPeriod(input: { assignedTo: string; start: string; end: string }): Promise<HolidaySummary[]>;
  createHoliday(input: CreateHolidayInput): Promise<EntitySummary>;
  updateHoliday(id: string, patch: UpdateHolidayInput): Promise<EntitySummary>;
  deleteHoliday(id: string): Promise<void>;
}
