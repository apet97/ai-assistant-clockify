/**
 * Select one exact eval case when the selector is a complete case id. Partial
 * ID fragments remain available for ad-hoc slices, but can never widen an
 * exact release-evidence command to a longer id with the same prefix.
 */
export function selectEvalCases<T extends { id: string }>(
  cases: readonly T[],
  selector?: string,
): T[] {
  if (selector === undefined) return [...cases];
  const exact = cases.find((candidate) => candidate.id === selector);
  return exact === undefined
    ? cases.filter((candidate) => candidate.id.includes(selector))
    : [exact];
}
