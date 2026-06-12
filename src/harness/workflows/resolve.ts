import type { ClarifyOption, RiskyClarifyResult } from "../action.js";
import { DAY_MS } from "../../durations.js";

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

/** A clarify option label that flags archived candidates so duplicates are tellable apart. */
function optionLabel(item: { name: string; archived?: boolean }): string {
  return item.archived ? `${item.name} (archived)` : item.name;
}

/**
 * Build grounded "did you mean one of these?" clarify options from the candidates
 * already fetched (Phase 4 — a clarify offers options, never "go list them
 * yourself"). Prefers names containing the query; falls back to all candidates;
 * excludes archived unless `includeArchived` (destructive/archive verbs may
 * legitimately target archived entities — live item 305); capped. Empty when
 * there are none to offer.
 */
export function suggestOptions<T extends { id: string; name: string; archived?: boolean }>(
  items: T[],
  query: string,
  opts?: { includeArchived?: boolean },
): ClarifyOption[] {
  const candidates = opts?.includeArchived ? items : items.filter((item) => !item.archived);
  const q = query.trim().toLowerCase();
  const contains = q ? candidates.filter((item) => item.name.toLowerCase().includes(q)) : [];
  const pool = contains.length > 0 ? contains : candidates;
  return pool.slice(0, MAX_SUGGESTIONS).map((item) => ({ id: item.id, label: optionLabel(item) }));
}

export function matchByName<T extends { name: string; archived?: boolean }>(
  items: T[],
  name: string,
  opts?: { includeArchived?: boolean },
): NameMatch<T> {
  const target = name.trim().toLowerCase();
  const matches = items.filter(
    (item) =>
      (opts?.includeArchived || !item.archived) &&
      item.name.trim().toLowerCase() === target,
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

/** The archived filter the WorkspaceClient list methods accept. */
export type ArchivedFilter = { archived?: boolean };

/**
 * Fetch active + archived entities explicitly — the real list adapters default
 * to ACTIVE-ONLY on the wire, so an includeArchived resolution must ask for
 * both states. Deduped by id in case a backend ignores the filter.
 */
async function listBothArchivedStates<T extends { id: string }>(
  list: (filter?: ArchivedFilter) => Promise<T[]>,
): Promise<T[]> {
  const [active, archived] = await Promise.all([
    list({ archived: false }),
    list({ archived: true }),
  ]);
  const seen = new Set(active.map((item) => item.id));
  return [...active, ...archived.filter((item) => !seen.has(item.id))];
}

/**
 * Resolve a possibly-symbolic entity reference to a real id at PREVIEW time, so
 * an identity mistake becomes a clarify — never a confirmed-then-failed commit.
 *
 * - A 24-hex `id` is trusted as-is (no extra list call on the happy path).
 * - A non-hex `id` is checked against the listed ids first (fakes/tests use
 *   short ids), then treated as a name.
 * - A `name` resolves via {@link matchByName}; none/many stop and ask, with
 *   grounded "did you mean?" options.
 * - `includeArchived` lets destructive/archive/unarchive verbs target an
 *   ARCHIVED entity by name (live item 305: "delete <archived project>" could
 *   neither match nor suggest it). Create/normal-update resolution stays
 *   archived-excluding.
 * - `notFoundHint` appends a caller-specific sentence to the none-match
 *   clarifies ("Or should I create it first?") — copy stays byte-identical
 *   when absent.
 */
export async function resolveEntityRef<T extends { id: string; name: string; archived?: boolean }>(
  ref: { id?: string; name?: string },
  opts: {
    noun: string;
    verb: string;
    list: (filter?: ArchivedFilter) => Promise<T[]>;
    includeArchived?: boolean;
    notFoundHint?: string;
  },
): Promise<ResolveEntityResult<T>> {
  const rawId = ref.id?.trim();
  if (rawId && looksLikeClockifyId(rawId)) return { ok: true, id: rawId, name: ref.name };
  const query = (ref.name ?? rawId ?? "").trim();
  const includeArchived = opts.includeArchived === true;
  const items = includeArchived ? await listBothArchivedStates(opts.list) : await opts.list();
  if (rawId) {
    const exact = items.find((item) => item.id === rawId);
    if (exact) return { ok: true, id: exact.id, name: exact.name, entity: exact };
  }
  const match = matchByName(items, query, { includeArchived });
  if (match.kind === "one") {
    return { ok: true, id: match.entity.id, name: match.entity.name, entity: match.entity };
  }
  if (match.kind === "many") {
    const qualifier = includeArchived ? "" : "active ";
    return {
      ok: false,
      clarify: {
        clarify: `More than one ${qualifier}${opts.noun} is named "${query}". Which one should I ${opts.verb}?`,
        options: match.matches.map((m) => ({ id: m.id, label: optionLabel(m) })),
      },
    };
  }
  const options = suggestOptions(items, query, { includeArchived });
  const article = includeArchived ? (/^[aeiou]/i.test(opts.noun) ? "an" : "a") : "an active";
  const base = options.length
    ? `I couldn't find ${article} ${opts.noun} named "${query}". Did you mean one of these?`
    : `There is no ${includeArchived ? "" : "active "}${opts.noun} named "${query}" to ${opts.verb}.`;
  return {
    ok: false,
    clarify: {
      clarify: opts.notFoundHint ? `${base} ${opts.notFoundHint}` : base,
      options: options.length ? options : undefined,
    },
  };
}

/**
 * Resolve the OPTIONAL project/task slot pair every entry-shaped action carries
 * (expenses create/update, fix_entry, start_timer, log_work, entries_list) —
 * ONE copy of "a name in either slot resolves; a task needs its project". A
 * 24-hex id is trusted with zero list calls (the happy path stays free); a
 * symbolic ref resolves via {@link resolveEntityRef} with grounded clarifies.
 * Returns resolved names so previews can speak names, not ids. No refs ⇒
 * all-undefined passthrough.
 */
export async function resolveProjectTaskRefs(
  refs: { projectId?: string; projectName?: string; taskId?: string; taskName?: string },
  opts: {
    verb: string;
    listProjects: (filter?: ArchivedFilter) => Promise<Array<{ id: string; name: string; archived?: boolean }>>;
    listTasks: (projectId: string) => Promise<Array<{ id: string; name: string }>>;
    /** Appended to an unknown-project clarify ("Or should I create it first?"). */
    projectNotFoundHint?: string;
  },
): Promise<
  | { ok: true; projectId?: string; projectName?: string; taskId?: string; taskName?: string }
  | { ok: false; clarify: RiskyClarifyResult }
> {
  let projectId: string | undefined;
  let projectName: string | undefined;
  if (refs.projectId?.trim() || refs.projectName?.trim()) {
    const project = await resolveEntityRef(
      { id: refs.projectId, name: refs.projectName },
      { noun: "project", verb: opts.verb, list: opts.listProjects, notFoundHint: opts.projectNotFoundHint },
    );
    if (!project.ok) return project;
    projectId = project.id;
    projectName = project.name;
  }

  let taskId: string | undefined;
  let taskName: string | undefined;
  const rawTaskId = refs.taskId?.trim();
  if (rawTaskId && looksLikeClockifyId(rawTaskId)) {
    // An already-resolved task id is trusted as-is — no project needed.
    taskId = rawTaskId;
    taskName = refs.taskName;
  } else if (rawTaskId || refs.taskName?.trim()) {
    const query = (refs.taskName ?? rawTaskId ?? "").trim();
    if (!projectId) {
      return {
        ok: false,
        clarify: { clarify: `To ${opts.verb} task "${query}" I need the project. Which project is it in?` },
      };
    }
    const scopedProjectId = projectId;
    const task = await resolveEntityRef(
      { id: rawTaskId, name: refs.taskName },
      { noun: "task", verb: opts.verb, list: () => opts.listTasks(scopedProjectId) },
    );
    if (!task.ok) return task;
    taskId = task.id;
    taskName = task.name;
  }

  return { ok: true, projectId, projectName, taskId, taskName };
}

/**
 * Generic LIST resolver — id/exact-name (and an optional `special` token like
 * "me") → ids + display labels, with a grounded clarify on any ambiguous/unknown
 * entry (identity-mistake-is-a-clarify). Order is kept, duplicates collapse,
 * `labels[i]` pairs with `ids[i]`, and `list` is called at most once. The single
 * place this logic lives — `resolveUserRefs` and `resolveGroupRefs` are thin
 * wrappers, so users and groups can never drift apart.
 *
 * `trustIds`: when true a 24-hex value is taken as an id WITHOUT a list call (the
 * assignee happy path). When false even a 24-hex value is verified against the
 * real list — a wrong-typed id (a project id in a member slot) then clarifies
 * instead of hitting the wire (permission-affecting writes set this).
 */
async function resolveRefList(
  refs: string[],
  opts: {
    verb: string;
    /** Plural noun for the ambiguity clarify ("workspace users" / "user groups"). */
    pluralNoun: string;
    /** "a workspace member" / "a user group" — for the not-found clarify. */
    singularPhrase: string;
    /** "them" / "it" — pronoun closing the not-found clarify. */
    pronoun: string;
    list: () => Promise<Array<{ id: string; name: string }>>;
    special?: (ref: string) => { id: string; label: string } | undefined;
    trustIds?: boolean;
  },
): Promise<{ ok: true; ids: string[]; labels: string[] } | { ok: false; clarify: RiskyClarifyResult }> {
  const ids: string[] = [];
  const labels: string[] = [];
  const push = (id: string, label: string): void => {
    if (!ids.includes(id)) {
      ids.push(id);
      labels.push(label);
    }
  };
  let items: Array<{ id: string; name: string }> | undefined;
  for (const raw of refs) {
    const ref = raw.trim();
    if (!ref) continue;
    const special = opts.special?.(ref);
    if (special) {
      push(special.id, special.label);
      continue;
    }
    if (opts.trustIds && looksLikeClockifyId(ref)) {
      push(ref, ref);
      continue;
    }
    if (!items) items = await opts.list();
    // A ref may still be a real id (short test id, or a verified 24-hex) before it is a name.
    const byId = items.find((x) => x.id === ref);
    if (byId) {
      push(byId.id, byId.name);
      continue;
    }
    const match = matchByName(items, ref);
    if (match.kind === "one") {
      push(match.entity.id, match.entity.name);
      continue;
    }
    if (match.kind === "many") {
      return {
        ok: false,
        clarify: {
          clarify: `Several ${opts.pluralNoun} match "${ref}". Which one should I ${opts.verb}?`,
          options: match.matches.map((x) => ({ id: x.id, label: x.name })),
        },
      };
    }
    return {
      ok: false,
      clarify: {
        clarify: `"${ref}" isn't ${opts.singularPhrase}, so I can't ${opts.verb} ${opts.pronoun}.`,
        options: suggestOptions(items, ref),
      },
    };
  }
  return { ok: true, ids, labels };
}

/**
 * Resolve a LIST of user references — ids, exact names, or "me" — to user ids with
 * display labels (task assignees, group adds). "me" is the admin (label "you").
 * See {@link resolveRefList}; `verifyIds` sets `trustIds: false` so a 24-hex value
 * is verified rather than blindly trusted (permission-affecting writes).
 */
export async function resolveUserRefs(
  refs: string[],
  opts: { verb: string; adminUserId: string; listUsers: () => Promise<Array<{ id: string; name: string }>>; verifyIds?: boolean },
): Promise<{ ok: true; userIds: string[]; labels: string[] } | { ok: false; clarify: RiskyClarifyResult }> {
  const r = await resolveRefList(refs, {
    verb: opts.verb,
    pluralNoun: "workspace users",
    singularPhrase: "a workspace member",
    pronoun: "them",
    list: opts.listUsers,
    special: (ref) => (ref.toLowerCase() === "me" ? { id: opts.adminUserId, label: "you" } : undefined),
    trustIds: !opts.verifyIds,
  });
  return r.ok ? { ok: true, userIds: r.ids, labels: r.labels } : r;
}

/**
 * Resolve a LIST of user-GROUP references — ids or exact names — to group ids with
 * display labels (holiday/policy scoping). No "me"; a 24-hex value is always
 * verified against the real groups (so a project/user id in a group slot
 * clarifies, never hits the wire). See {@link resolveRefList}.
 */
export async function resolveGroupRefs(
  refs: string[],
  opts: { verb: string; listGroups: () => Promise<Array<{ id: string; name: string }>> },
): Promise<{ ok: true; groupIds: string[]; labels: string[] } | { ok: false; clarify: RiskyClarifyResult }> {
  const r = await resolveRefList(refs, {
    verb: opts.verb,
    pluralNoun: "user groups",
    singularPhrase: "a user group",
    pronoun: "it",
    list: opts.listGroups,
    trustIds: false,
  });
  return r.ok ? { ok: true, groupIds: r.ids, labels: r.labels } : r;
}

/**
 * Resolve ONE user reference — an id, an exact name, or "me" — to a `{ userId,
 * label }`, verifying it against the workspace user list so an identity mistake
 * (a name in the id slot, a 24-hex non-user) becomes a clarify at preview, never
 * a confirmed-then-failed commit. Shared by every action that targets a single
 * member (role grant, the per-project / workspace member rate, group add/remove)
 * so the resolution + grounded clarify live in ONE place. A name passed in the
 * `id` slot is matched by name after the exact-id lookup misses (the planner
 * routinely puts a NAME where an id belongs). `label` is "you" for the admin,
 * else the member's name — for a legible preview.
 *
 * `trustIds`: when true a 24-hex value is taken as the user id WITHOUT a list
 * call (read FILTERS — a wrong id there yields an empty list, not a damaging
 * write). Default false: even a 24-hex value is verified against the real
 * users, so a wrong-typed id clarifies instead of hitting the wire
 * (permission/assignment-affecting writes).
 */
export async function resolveUserRef(
  ref: { id?: string; name?: string },
  opts: {
    verb: string;
    adminUserId: string;
    listUsers: () => Promise<Array<{ id: string; name: string }>>;
    trustIds?: boolean;
  },
): Promise<{ ok: true; userId: string; label: string } | { ok: false; clarify: RiskyClarifyResult }> {
  if ((ref.id ?? ref.name ?? "").trim().toLowerCase() === "me") {
    return { ok: true, userId: opts.adminUserId, label: "you" };
  }
  const rawId = ref.id?.trim();
  if (opts.trustIds && rawId && looksLikeClockifyId(rawId)) {
    return { ok: true, userId: rawId, label: ref.name ?? rawId };
  }
  const users = await opts.listUsers();
  let user = ref.id ? users.find((u) => u.id === ref.id) : undefined;
  if (!user) {
    // A name may have been passed in EITHER slot — match it after the id lookup.
    const query = (ref.name ?? ref.id ?? "").trim();
    if (query) {
      const match = matchByName(users, query);
      if (match.kind === "many") {
        return {
          ok: false,
          clarify: {
            clarify: `Several workspace users match "${query}". Which one should I ${opts.verb}?`,
            options: match.matches.map((u) => ({ id: u.id, label: u.name })),
          },
        };
      }
      if (match.kind === "one") user = match.entity;
    }
  }
  if (!user) {
    const target = (ref.name ?? ref.id ?? "").trim();
    return {
      ok: false,
      clarify: {
        clarify: `"${target}" isn't a workspace member, so I can't ${opts.verb} them.`,
        options: suggestOptions(users, target),
      },
    };
  }
  return { ok: true, userId: user.id, label: user.name };
}

/** Longest value rendered on a preview "set <field> → <value>" line. */
const MAX_PATCH_VALUE_LEN = 80;

/**
 * Render a single patch value for a risky-update PREVIEW card. Strings show
 * as-is (quoted so a trailing space / emptiness is visible); arrays/objects are
 * JSON; everything else stringifies. Long values are elided so the card stays
 * readable. Values come from the typed patch the COMMIT will write — never a
 * token (patches never carry secrets, by construction), so nothing sensitive
 * can surface here.
 */
function renderPatchValue(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = JSON.stringify(value);
  else if (value === null || value === undefined) text = String(value);
  else if (typeof value === "object") text = JSON.stringify(value);
  else text = String(value);
  return text.length > MAX_PATCH_VALUE_LEN ? `${text.slice(0, MAX_PATCH_VALUE_LEN - 1)}…` : text;
}

/**
 * Build the `expectedChanges` list for a risky UPDATE preview as
 * `set <field> → <value>` — the value the commit will actually write, not just
 * the field name. A model-garbled value (wrong currency, mangled note) is then
 * catchable at preview time, the same philosophy as name→id resolution at
 * preview time. Values are clamped/stringified by {@link renderPatchValue};
 * patches never carry tokens, so nothing sensitive can leak.
 */
export function describePatch(patch: Record<string, unknown>): string[] {
  return Object.entries(patch).map(([field, value]) => `set ${field} → ${renderPatchValue(value)}`);
}

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
