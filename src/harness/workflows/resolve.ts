import type { ClarifyOption } from "../action.js";

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
