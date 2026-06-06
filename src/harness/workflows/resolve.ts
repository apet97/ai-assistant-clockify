/**
 * Deterministic name → entity resolution shared by workflows. Writes must stop
 * when identity is ambiguous (SAFETY_AND_PERMISSIONS "Ambiguous Identity"): the
 * harness never picks one of several matches — it asks the admin to choose.
 */
export type NameMatch<T> =
  | { kind: "none" }
  | { kind: "one"; entity: T }
  | { kind: "many"; matches: T[] };

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
