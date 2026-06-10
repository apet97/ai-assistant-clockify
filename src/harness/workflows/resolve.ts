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

/**
 * Resolve a day (YYYY-MM-DD) server-side. The model knows "yesterday" but not
 * the calendar date (its own clock is unreliable — live it sent the literal
 * string "today" to the wire), so this accepts a relative word
 * (`today`/`yesterday`/`tomorrow`) or a numeric `dayOffset` (0=today,
 * -1=yesterday) and the harness — which has `ctx.now` — does the math. A
 * literal `YYYY-MM-DD…` still wins; absent everything, today.
 */
export function resolveRelativeDay(now: Date, args: { date?: string; dayOffset?: number }): string {
  const today = now.toISOString().slice(0, 10);
  if (args.dayOffset !== undefined) return addDays(today, args.dayOffset);
  const raw = args.date?.trim().toLowerCase();
  if (!raw) return today;
  if (raw === "today") return today;
  if (raw === "yesterday") return addDays(today, -1);
  if (raw === "tomorrow") return addDays(today, 1);
  return args.date!.slice(0, 10);
}
