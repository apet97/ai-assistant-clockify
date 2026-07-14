import { Temporal } from "@js-temporal/polyfill";

/**
 * Server-side date/period resolution shared by workflows (CLAUDE.md "dates
 * server-side" invariant). The model knows "yesterday" or "next Monday" but not
 * the calendar date (its own clock is unreliable — live it sent the literal
 * strings "today" and "next Monday" to the wire), so the harness — which holds
 * `now` — owns every calendar computation. An unresolved date may never reach
 * the wire: callers CLARIFY instead.
 */

function addDays(isoDay: string, days: number): string {
  return Temporal.PlainDate.from(isoDay).add({ days }).toString();
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
  try {
    return Temporal.PlainDate.from(day).toString() === day;
  } catch {
    return false;
  }
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
  timeZone = "UTC",
): string | undefined {
  let zonedNow: Temporal.ZonedDateTime;
  try {
    zonedNow = Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(timeZone);
  } catch {
    return undefined;
  }
  const today = zonedNow.toPlainDate().toString();
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
      const current = zonedNow.dayOfWeek % 7;
      if (weekday[1] === "last" || weekday[1] === "previous") {
        return addDays(today, -(((current - target + 7) % 7) || 7));
      }
      const ahead = (target - current + 7) % 7;
      return addDays(today, weekday[1] === "next" ? ahead || 7 : ahead);
    }
  }
  const monthDay = parseMonthNameDay(new Date(Date.UTC(zonedNow.year, 0, 1)), raw);
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


/** Resolve a named period with verified zoned calendar arithmetic. */
export function resolvePeriod(
  now: Date,
  period: ReportPeriod,
  timeZone = "UTC",
  weekStartsOn = 1,
): { dateRangeStart: string; dateRangeEnd: string } {
  const instant = Temporal.Instant.fromEpochMilliseconds(now.getTime());
  const zoned = instant.toZonedDateTimeISO(timeZone);
  const today = zoned.toPlainDate();
  const start = (day: Temporal.PlainDate): string => day
    .toZonedDateTime({ timeZone, plainTime: "00:00" })
    .toInstant().toString({ smallestUnit: "millisecond" });
  const end = (day: Temporal.PlainDate): string => day.add({ days: 1 })
    .toZonedDateTime({ timeZone, plainTime: "00:00" })
    .toInstant().subtract({ milliseconds: 1 }).toString({ smallestUnit: "millisecond" });
  const nowIso = instant.toString({ smallestUnit: "millisecond" });
  const result = (dateRangeStart: string, dateRangeEnd: string) => ({ dateRangeStart, dateRangeEnd });
  const weekOffset = (today.dayOfWeek - weekStartsOn + 7) % 7;
  const thisWeek = today.subtract({ days: weekOffset });
  const monthStart = today.with({ day: 1 });
  const quarterMonth = Math.floor((today.month - 1) / 3) * 3 + 1;
  const quarterStart = Temporal.PlainDate.from({ year: today.year, month: quarterMonth, day: 1 });
  const yearStart = Temporal.PlainDate.from({ year: today.year, month: 1, day: 1 });

  switch (period) {
    case "today": return result(start(today), end(today));
    case "yesterday": {
      const day = today.subtract({ days: 1 });
      return result(start(day), end(day));
    }
    case "this_week": return result(start(thisWeek), nowIso);
    case "last_week": {
      const first = thisWeek.subtract({ weeks: 1 });
      return result(start(first), end(first.add({ days: 6 })));
    }
    case "next_week": {
      const first = thisWeek.add({ weeks: 1 });
      return result(start(first), end(first.add({ days: 6 })));
    }
    case "this_month": return result(start(monthStart), nowIso);
    case "last_month": {
      const first = monthStart.subtract({ months: 1 });
      return result(start(first), end(monthStart.subtract({ days: 1 })));
    }
    case "next_month": {
      const first = monthStart.add({ months: 1 });
      return result(start(first), end(first.add({ months: 1 }).subtract({ days: 1 })));
    }
    case "last_7_days": return result(start(today.subtract({ days: 7 })), nowIso);
    case "last_30_days": return result(start(today.subtract({ days: 30 })), nowIso);
    case "this_quarter": return result(start(quarterStart), nowIso);
    case "last_quarter": {
      const first = quarterStart.subtract({ months: 3 });
      return result(start(first), end(quarterStart.subtract({ days: 1 })));
    }
    case "next_quarter": {
      const first = quarterStart.add({ months: 3 });
      return result(start(first), end(first.add({ months: 3 }).subtract({ days: 1 })));
    }
    case "this_year": return result(start(yearStart), nowIso);
    case "last_year": {
      const first = yearStart.subtract({ years: 1 });
      return result(start(first), end(yearStart.subtract({ days: 1 })));
    }
    case "next_year": {
      const first = yearStart.add({ years: 1 });
      return result(start(first), end(first.add({ years: 1 }).subtract({ days: 1 })));
    }
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
export function resolveInstant(
  now: Date,
  raw: string,
  edge: "start" | "end",
  timeZone = "UTC",
): string | undefined {
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    if (!/([zZ]|[+-]\d{2}:?\d{2})$/.test(trimmed)) return undefined;
    try {
      return Temporal.Instant.from(trimmed).toString({ smallestUnit: "millisecond" });
    } catch {
      return undefined;
    }
  }
  const day = resolveRelativeDay(now, { date: trimmed }, timeZone);
  if (day !== undefined) {
    try {
      const start = Temporal.PlainDate.from(day).toZonedDateTime({ timeZone, plainTime: "00:00" });
      const instant = edge === "start"
        ? start.toInstant()
        : start.add({ days: 1 }).toInstant().subtract({ milliseconds: 1 });
      return instant.toString({ smallestUnit: "millisecond" });
    } catch {
      return undefined;
    }
  }
  const periodKey = trimmed.toLowerCase().replace(/[\s-]+/g, "_");
  if ((REPORT_PERIODS as readonly string[]).includes(periodKey)) {
    const range = resolvePeriod(now, periodKey as ReportPeriod, timeZone);
    return edge === "start" ? range.dateRangeStart : range.dateRangeEnd;
  }
  return undefined;
}

/** Convert a verified local calendar time to a UTC wire instant. */
export function zonedDayTimeInstant(day: string, hour: number, minute: number, timeZone: string): string | undefined {
  try {
    const zoned = Temporal.PlainDate.from(day).toZonedDateTime({
      timeZone,
      plainTime: Temporal.PlainTime.from({ hour, minute }),
    });
    return zoned.toInstant().toString({ smallestUnit: "millisecond" });
  } catch {
    return undefined;
  }
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
  opts: { start: DateEdgeOpts; end: DateEdgeOpts; exampleHint: string; timeZone?: string },
): { ok: true; start: string | undefined; end: string | undefined } | { ok: false; message: string } {
  const resolveEdge = (
    edge: "start" | "end",
    cfg: DateEdgeOpts,
    fallback: string | undefined,
  ): string | undefined => {
    if (cfg.raw !== undefined) return resolveInstant(now, cfg.raw, edge, opts.timeZone);
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
  if (start !== undefined && end !== undefined && Date.parse(start) > Date.parse(end)) {
    return {
      ok: false,
      message: "The start date must not be after the end date. Give me a range in chronological order.",
    };
  }
  return { ok: true, start, end };
}
