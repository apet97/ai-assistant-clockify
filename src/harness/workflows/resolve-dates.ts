import { DAY_MS } from "../../durations.js";

/**
 * Server-side date/period resolution shared by workflows (CLAUDE.md "dates
 * server-side" invariant). The model knows "yesterday" or "next Monday" but not
 * the calendar date (its own clock is unreliable — live it sent the literal
 * strings "today" and "next Monday" to the wire), so the harness — which holds
 * `now` — owns every calendar computation. An unresolved date may never reach
 * the wire: callers CLARIFY instead.
 */

function addDays(isoDay: string, days: number): string {
  return new Date(Date.parse(`${isoDay}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Weekday names in JS `getUTCDay()` order (0 = Sunday). */
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Month names + 3-letter abbreviations, index 0 = January (matches getUTCMonth). */
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** A calendar day that exists (rejects 2026-13-99 etc., which Date.parse NaNs). */
function isRealDay(day: string): boolean {
  return !Number.isNaN(Date.parse(`${day}T00:00:00Z`));
}

/**
 * Build a YYYY-MM-DD from year/0-based-month/day, rejecting overflow (e.g.
 * Feb 30 — which `Date.UTC` silently rolls into March). Used by the month-name
 * partial-date branch so an impossible day clarifies instead of being sent.
 */
function buildDay(year: number, monthIndex: number, day: number): string | undefined {
  const d = new Date(Date.UTC(year, monthIndex, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== monthIndex || d.getUTCDate() !== day) {
    return undefined;
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Parse a month-name + day partial date with NO year ("June 1", "Jun 5",
 * "June 1st", "3 March") and resolve it to the CURRENT year. The model must
 * never fabricate a year for a partial date the admin typed — left to itself it
 * defaults to a training-data year (live: "June 1 to June 5" narrated as 2025);
 * the harness, which holds `now`, owns the year. Returns undefined when it isn't
 * a month-name partial or the day is out of range (caller then clarifies).
 */
function parseMonthNameDay(now: Date, raw: string): string | undefined {
  const m = raw.match(/^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?$/) ?? raw.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?$/);
  if (!m) return undefined;
  const [word, dayStr] = /^\d/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
  const monthIndex = MONTHS.findIndex((name) => name === word || name.startsWith(word));
  if (monthIndex < 0 || word.length < 3) return undefined;
  return buildDay(now.getUTCFullYear(), monthIndex, Number(dayStr));
}

/**
 * Resolve a day (YYYY-MM-DD) server-side. The model knows "yesterday" or "next
 * Monday" but not the calendar date (its own clock is unreliable — live it sent
 * the literal strings "today" and "next Monday" to the wire), so this accepts a
 * relative word (`today`/`yesterday`/`tomorrow`), a weekday (bare AND
 * `this <weekday>` = the next occurrence, today counts; `next <weekday>` =
 * strictly after today; `last <weekday>` = strictly before), or a numeric
 * `dayOffset` (0=today,
 * -1=yesterday), and the harness — which has `ctx.now` — does the math. A
 * literal `YYYY-MM-DD…` still wins; absent everything, today. Anything else
 * returns `undefined`: callers must CLARIFY — an unresolved date may never
 * reach the wire (the live loop's `?start=today` / "Invalid time value" class).
 */
export function resolveRelativeDay(
  now: Date,
  args: { date?: string; dayOffset?: number },
): string | undefined {
  const today = now.toISOString().slice(0, 10);
  if (args.dayOffset !== undefined) return addDays(today, args.dayOffset);
  const raw = args.date?.trim().toLowerCase();
  if (!raw) return today;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const day = raw.slice(0, 10);
    return isRealDay(day) ? day : undefined;
  }
  if (raw === "today" || raw === "now") return today;
  if (raw === "yesterday") return addDays(today, -1);
  if (raw === "tomorrow") return addDays(today, 1);
  const weekday = raw.match(/^(?:(this|next|last|previous)\s+)?([a-z]+)$/);
  if (weekday) {
    const target = WEEKDAYS.indexOf(weekday[2]);
    if (target >= 0) {
      const current = now.getUTCDay();
      if (weekday[1] === "last" || weekday[1] === "previous") {
        return addDays(today, -(((current - target + 7) % 7) || 7));
      }
      const ahead = (target - current + 7) % 7;
      return addDays(today, weekday[1] === "next" ? ahead || 7 : ahead);
    }
  }
  const monthDay = parseMonthNameDay(now, raw);
  if (monthDay !== undefined) return monthDay;
  return undefined;
}

export const REPORT_PERIODS = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
  "last_7_days",
  "last_30_days",
  "this_quarter",
  "last_quarter",
  "this_year",
  "last_year",
  // Forward periods (live item 321): natural for scheduling/time-off ranges
  // ("schedule me next week", "assignments next month") — they used to
  // dead-end in an honest clarify.
  "next_week",
  "next_month",
  "next_quarter",
  "next_year",
] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];


/** Resolve a named period to a UTC date range using `now` (the harness owns the math). */
export function resolvePeriod(now: Date, period: ReportPeriod): { dateRangeStart: string; dateRangeEnd: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const startOf = (yy: number, mm: number, dd: number): Date => new Date(Date.UTC(yy, mm, dd, 0, 0, 0, 0));
  const endOf = (yy: number, mm: number, dd: number): Date => new Date(Date.UTC(yy, mm, dd, 23, 59, 59, 999));
  const range = (s: Date, e: Date) => ({ dateRangeStart: s.toISOString(), dateRangeEnd: e.toISOString() });
  const lastDayOf = (yy: number, mm: number): number => new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  const dow = (now.getUTCDay() + 6) % 7; // 0 = Monday … 6 = Sunday
  const qStart = Math.floor(m / 3) * 3;

  switch (period) {
    case "today":
      return range(startOf(y, m, d), endOf(y, m, d));
    case "yesterday": {
      const yd = new Date(Date.UTC(y, m, d) - DAY_MS);
      return range(
        startOf(yd.getUTCFullYear(), yd.getUTCMonth(), yd.getUTCDate()),
        endOf(yd.getUTCFullYear(), yd.getUTCMonth(), yd.getUTCDate()),
      );
    }
    case "this_week": {
      const ws = new Date(Date.UTC(y, m, d) - dow * DAY_MS);
      return range(startOf(ws.getUTCFullYear(), ws.getUTCMonth(), ws.getUTCDate()), now);
    }
    case "last_week": {
      const ws = new Date(Date.UTC(y, m, d) - (dow + 7) * DAY_MS);
      const we = new Date(ws.getTime() + 6 * DAY_MS);
      return range(
        startOf(ws.getUTCFullYear(), ws.getUTCMonth(), ws.getUTCDate()),
        endOf(we.getUTCFullYear(), we.getUTCMonth(), we.getUTCDate()),
      );
    }
    case "this_month":
      return range(startOf(y, m, 1), now);
    case "last_month": {
      const yy = m === 0 ? y - 1 : y;
      const mm = m === 0 ? 11 : m - 1;
      return range(startOf(yy, mm, 1), endOf(yy, mm, lastDayOf(yy, mm)));
    }
    case "last_7_days":
      return range(new Date(now.getTime() - 7 * DAY_MS), now);
    case "last_30_days":
      return range(new Date(now.getTime() - 30 * DAY_MS), now);
    case "this_quarter":
      return range(startOf(y, qStart, 1), now);
    case "last_quarter": {
      let qm = qStart - 3;
      let qy = y;
      if (qm < 0) {
        qm += 12;
        qy -= 1;
      }
      return range(startOf(qy, qm, 1), endOf(qy, qm + 2, lastDayOf(qy, qm + 2)));
    }
    case "this_year":
      return range(startOf(y, 0, 1), now);
    case "last_year":
      return range(startOf(y - 1, 0, 1), endOf(y - 1, 11, 31));
    case "next_week": {
      const ws = new Date(Date.UTC(y, m, d) + (7 - dow) * DAY_MS);
      const we = new Date(ws.getTime() + 6 * DAY_MS);
      return range(
        startOf(ws.getUTCFullYear(), ws.getUTCMonth(), ws.getUTCDate()),
        endOf(we.getUTCFullYear(), we.getUTCMonth(), we.getUTCDate()),
      );
    }
    case "next_month": {
      const yy = m === 11 ? y + 1 : y;
      const mm = m === 11 ? 0 : m + 1;
      return range(startOf(yy, mm, 1), endOf(yy, mm, lastDayOf(yy, mm)));
    }
    case "next_quarter": {
      let qm = qStart + 3;
      let qy = y;
      if (qm > 11) {
        qm -= 12;
        qy += 1;
      }
      return range(startOf(qy, qm, 1), endOf(qy, qm + 2, lastDayOf(qy, qm + 2)));
    }
    case "next_year":
      return range(startOf(y + 1, 0, 1), endOf(y + 1, 11, 31));
  }
}

/**
 * Resolve a day-or-instant reference to the UTC instant the api/reports/
 * scheduling hosts want (`yyyy-MM-ddThh:mm:ssZ`, per the OpenAPI spec): a full
 * ISO datetime passes through normalized; a day reference becomes start-of-day
 * (`edge: "start"`) or end-of-day (`edge: "end"`); a PERIOD keyword
 * (`last_7_days`, `last week`, …) maps to its own start/end — the planner emits
 * these as plain date values (live: entries_list start="last_7_days").
 * `undefined` = unparseable — clarify, never send.
 */
export function resolveInstant(now: Date, raw: string, edge: "start" | "end"): string | undefined {
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
  }
  const day = resolveRelativeDay(now, { date: trimmed });
  if (day !== undefined) return edge === "start" ? `${day}T00:00:00.000Z` : `${day}T23:59:59.999Z`;
  const periodKey = trimmed.toLowerCase().replace(/[\s-]+/g, "_");
  if ((REPORT_PERIODS as readonly string[]).includes(periodKey)) {
    const range = resolvePeriod(now, periodKey as ReportPeriod);
    return edge === "start" ? range.dateRangeStart : range.dateRangeEnd;
  }
  return undefined;
}

/**
 * Per-edge config for {@link resolveDateRange}. A missing input edge is filled
 * by `defaultTo` (a static instant or a function of the already-resolved END,
 * for the reports "last 7 days through end" default); when `defaultTo` is absent
 * the resolved edge stays `undefined` (the caller's optional-edge passthrough).
 */
export interface DateEdgeOpts {
  /** The raw model-supplied value for this edge (undefined ⇒ use `defaultTo`). */
  raw?: string;
  /**
   * Filled in when `raw` is undefined. A function receives the resolved END
   * instant so START can default relative to it (reports' last-7-days window);
   * absent ⇒ the edge stays undefined.
   */
  defaultTo?: string | ((end: string | undefined) => string | undefined);
}

/**
 * Resolve a start/end date RANGE in ONE place: the per-edge {@link resolveInstant}
 * calls, the bad-date collection, and the shared "I couldn't make sense of the
 * date(s)…" clarify message all live here so the dozen-odd range-reading actions
 * don't each re-implement (and drift) the same five lines. `end` is resolved
 * first so a START default can be relative to it. Returns the resolved instants
 * (each may be `undefined` when its edge is optional and was omitted) or a single
 * `message` to clarify with. `exampleHint` is the trailing example list, which
 * differs per caller ("today, yesterday, or last monday" vs "today, tomorrow, or
 * next monday" …) — it never reaches the wire, only the clarify copy.
 */
export function resolveDateRange(
  now: Date,
  opts: { start: DateEdgeOpts; end: DateEdgeOpts; exampleHint: string },
): { ok: true; start: string | undefined; end: string | undefined } | { ok: false; message: string } {
  const resolveEdge = (
    edge: "start" | "end",
    cfg: DateEdgeOpts,
    fallback: string | undefined,
  ): string | undefined => {
    if (cfg.raw !== undefined) return resolveInstant(now, cfg.raw, edge);
    if (typeof cfg.defaultTo === "function") return cfg.defaultTo(fallback);
    return cfg.defaultTo;
  };
  const end = resolveEdge("end", opts.end, undefined);
  const start = resolveEdge("start", opts.start, end);
  const bad = [
    opts.start.raw !== undefined && start === undefined ? opts.start.raw : undefined,
    opts.end.raw !== undefined && end === undefined ? opts.end.raw : undefined,
  ].filter((value): value is string => value !== undefined);
  if (bad.length) {
    return {
      ok: false,
      message: `I couldn't make sense of the date${bad.length > 1 ? "s" : ""} ${bad.map((b) => `"${b}"`).join(" and ")} — give me a calendar date (YYYY-MM-DD) or something like ${opts.exampleHint}.`,
    };
  }
  return { ok: true, start, end };
}
