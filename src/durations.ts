/**
 * Day-based time spans in milliseconds — the single source of truth for the
 * calendar math scattered across the workflows and the time-off REST adapter.
 * Previously each module redefined `DAY_MS` (some as `86_400_000`, some as
 * `24 * 60 * 60 * 1000`) and its multiples independently.
 */

/** Milliseconds in one day. */
export const DAY_MS = 86_400_000;
/** Milliseconds in seven days (default report/audit look-back window). */
export const SEVEN_DAYS_MS = 7 * DAY_MS;
/** Milliseconds in thirty days (default invoice due window). */
export const THIRTY_DAYS_MS = 30 * DAY_MS;
