import type { ClarifyOption, RiskyClarifyResult } from "../action.js";

/**
 * Deterministic name → entity resolution shared by workflows. Writes must stop
 * when identity is ambiguous (SAFETY_AND_PERMISSIONS "Ambiguous Identity"): the
 * harness never picks one of several matches — it asks the admin to choose.
 */
export type NameMatch<T> =
  | { kind: "none" }
  | { kind: "one"; entity: T }
  | { kind: "many"; matches: T[] };

/** Most "did you mean?" options to offer when a named entity isn't found. */
const MAX_SUGGESTIONS = 12;

/**
 * Build grounded "did you mean one of these?" clarify options from the candidates
 * already fetched (Phase 4 — a clarify offers options, never "go list them
 * yourself"). Prefers names containing the query; falls back to all active
 * candidates; excludes archived; capped. Empty when there are none to offer.
 */
export function suggestOptions<T extends { id: string; name: string; archived?: boolean }>(
  items: T[],
  query: string,
): ClarifyOption[] {
  const active = items.filter((item) => !item.archived);
  const q = query.trim().toLowerCase();
  const contains = q ? active.filter((item) => item.name.toLowerCase().includes(q)) : [];
  const pool = contains.length > 0 ? contains : active;
  return pool.slice(0, MAX_SUGGESTIONS).map((item) => ({ id: item.id, label: item.name }));
}

export function matchByName<T extends { name: string; archived?: boolean }>(
  items: T[],
  name: string,
): NameMatch<T> {
  const target = name.trim().toLowerCase();
  const matches = items.filter(
    (item) => !item.archived && item.name.trim().toLowerCase() === target,
  );
  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1) return { kind: "one", entity: matches[0] };
  return { kind: "many", matches };
}

/**
 * Clockify entity ids are 24-hex Mongo ObjectIds. The planner habitually puts a
 * NAME (or an invoice number) in the id slot — the live loop showed
 * `GET /projects/AIASSIST_LOOP_P4` 400ing after the admin had already confirmed.
 * Anything that doesn't look like a real id must be resolved, never sent.
 */
export function looksLikeClockifyId(value: string): boolean {
  return /^[0-9a-f]{24}$/i.test(value.trim());
}

export type ResolveEntityResult<T> =
  | { ok: true; id: string; name?: string; entity?: T }
  | { ok: false; clarify: RiskyClarifyResult };

/**
 * Resolve a possibly-symbolic entity reference to a real id at PREVIEW time, so
 * an identity mistake becomes a clarify — never a confirmed-then-failed commit.
 *
 * - A 24-hex `id` is trusted as-is (no extra list call on the happy path).
 * - A non-hex `id` is checked against the listed ids first (fakes/tests use
 *   short ids), then treated as a name.
 * - A `name` resolves via {@link matchByName}; none/many stop and ask, with
 *   grounded "did you mean?" options.
 */
export async function resolveEntityRef<T extends { id: string; name: string; archived?: boolean }>(
  ref: { id?: string; name?: string },
  opts: { noun: string; verb: string; list: () => Promise<T[]> },
): Promise<ResolveEntityResult<T>> {
  const rawId = ref.id?.trim();
  if (rawId && looksLikeClockifyId(rawId)) return { ok: true, id: rawId, name: ref.name };
  const query = (ref.name ?? rawId ?? "").trim();
  const items = await opts.list();
  if (rawId) {
    const exact = items.find((item) => item.id === rawId);
    if (exact) return { ok: true, id: exact.id, name: exact.name, entity: exact };
  }
  const match = matchByName(items, query);
  if (match.kind === "one") {
    return { ok: true, id: match.entity.id, name: match.entity.name, entity: match.entity };
  }
  if (match.kind === "many") {
    return {
      ok: false,
      clarify: {
        clarify: `More than one active ${opts.noun} is named "${query}". Which one should I ${opts.verb}?`,
        options: match.matches.map((m) => ({ id: m.id, label: m.name })),
      },
    };
  }
  const options = suggestOptions(items, query);
  return {
    ok: false,
    clarify: {
      clarify: options.length
        ? `I couldn't find an active ${opts.noun} named "${query}". Did you mean one of these?`
        : `There is no active ${opts.noun} named "${query}" to ${opts.verb}.`,
      options: options.length ? options : undefined,
    },
  };
}

function addDays(isoDay: string, days: number): string {
  return new Date(Date.parse(`${isoDay}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Weekday names in JS `getUTCDay()` order (0 = Sunday). */
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** A calendar day that exists (rejects 2026-13-99 etc., which Date.parse NaNs). */
function isRealDay(day: string): boolean {
  return !Number.isNaN(Date.parse(`${day}T00:00:00Z`));
}

/**
 * Resolve a day (YYYY-MM-DD) server-side. The model knows "yesterday" or "next
 * Monday" but not the calendar date (its own clock is unreliable — live it sent
 * the literal strings "today" and "next Monday" to the wire), so this accepts a
 * relative word (`today`/`yesterday`/`tomorrow`), a weekday (bare = the next
 * occurrence, today counts; `next <weekday>` = strictly after today; `last
 * <weekday>` = strictly before), or a numeric `dayOffset` (0=today,
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
  const weekday = raw.match(/^(?:(next|last|previous)\s+)?([a-z]+)$/);
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
] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

const DAY_MS = 86_400_000;

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
