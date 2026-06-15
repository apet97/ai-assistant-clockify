/**
 * "Did you mean" for action NAMES (Phase 3 — weak-model recovery). When a model
 * proposes an action that isn't in the catalog, the harness already returns an
 * `unknown_action` error; this turns that dead end into a self-correction by
 * naming the closest real actions — mirroring the entity layer's grounded
 * `suggestOptions`, which action names never had.
 *
 * Catalog names are underscore-structured and share a `clockify_` prefix +
 * `_create`/`_list` suffixes, so two signals are combined:
 *   - TOKEN OVERLAP (split on non-alphanumerics) — catches plural/order swaps that
 *     raw edit distance misses ("clockify_create_invoice" → "clockify_invoices_create").
 *   - LEVENSHTEIN — catches single-character typos ("clockfy_status" → "clockify_status").
 * A candidate qualifies on ≥2 shared tokens OR a small edit distance, so a truly
 * unrelated string yields NO suggestion (never noise). Pure + deterministic.
 */

/** Iterative two-row Levenshtein edit distance. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

/**
 * The nearest catalog-style names to `query`, best first, at most `limit`. Empty
 * when nothing is genuinely similar (an unrelated/empty query gets no suggestion).
 */
export function nearestNames(query: string, candidates: readonly string[], limit = 3): string[] {
  const q = query.toLowerCase();
  if (q.length === 0) return [];
  const queryTokens = tokens(query);

  const scored = candidates.map((name) => {
    const nameTokens = tokens(name);
    let overlap = 0;
    for (const t of queryTokens) if (nameTokens.has(t)) overlap += 1;
    return { name, overlap, distance: levenshtein(q, name.toLowerCase()) };
  });

  // Qualify on a strong token match (≥2 shared) OR a small edit distance — so a
  // bogus name (no shared tokens, far edit distance) suggests nothing.
  const close = scored.filter(
    (c) => c.overlap >= 2 || c.distance <= Math.ceil(Math.max(q.length, c.name.length) * 0.34),
  );
  close.sort(
    (a, b) => b.overlap - a.overlap || a.distance - b.distance || a.name.localeCompare(b.name),
  );
  return close.slice(0, limit).map((c) => c.name);
}
