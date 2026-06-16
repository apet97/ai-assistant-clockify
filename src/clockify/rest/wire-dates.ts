/**
 * Canonical Clockify date-normalization helpers, shared by the REST modules.
 *
 * Clockify's date fields are NOT uniform on the wire — each helper here encodes a
 * live-verified, INTENTIONALLY DIFFERENT shape. Keep them separate; collapsing
 * them would silently change a request body. The consumer modules import the one
 * that matches their endpoint's documented shape.
 */

import { DAY_MS } from "../../durations.js";

/**
 * Clockify date fields want a full ISO datetime; normalize a bare YYYY-MM-DD.
 * Used by invoices (issuedDate/dueDate/payment date/import range) and expenses
 * (create/update date).
 */
export function toClockifyDate(d: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00Z` : d;
}

/**
 * The holidays in-period endpoint wants full ISO datetimes; normalize a date-only
 * lower bound to the START of the day. (Distinct from {@link toClockifyDate}:
 * here a value already carrying a `T` is left untouched.)
 */
export function periodStart(d: string): string {
  return d.includes("T") ? d : `${d}T00:00:00Z`;
}

/**
 * The holidays in-period endpoint upper bound — normalize a date-only value to
 * the END of the day (23:59:59.999Z) so the bound is inclusive.
 */
export function periodEnd(d: string): string {
  return d.includes("T") ? d : `${d}T23:59:59.999Z`;
}

/** The time-off period wants bare `YYYY-MM-DD` dates (the spec's documented shape). */
export function toBareDate(d: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const parsed = new Date(d);
  return Number.isNaN(parsed.getTime()) ? d : parsed.toISOString().slice(0, 10);
}

/** Inclusive calendar-day span between two bare dates (start === end → 1). */
export function inclusiveDays(start: string, end: string): number | undefined {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return undefined;
  return Math.round((b - a) / DAY_MS) + 1;
}
