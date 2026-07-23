const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

/** NFKC + lowercase normalization for indexed text and queries. */
export function normalizeSearchText(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/** Generic Unicode letter/number tokenization; no language-specific lists. */
export function tokenizeSearchText(text: string): string[] {
  const normalized = normalizeSearchText(text);
  const matches = normalized.match(TOKEN_PATTERN);
  if (!matches) return [];
  return [...new Set(matches)];
}

function codePointTrigrams(text: string): Set<string> {
  const codePoints = [...text];
  const trigrams = new Set<string>();
  for (let index = 0; index <= codePoints.length - 3; index += 1) {
    trigrams.add(codePoints.slice(index, index + 3).join(""));
  }
  return trigrams;
}

export function trigramJaccardSimilarity(left: string, right: string): number {
  const leftTrigrams = codePointTrigrams(left);
  const rightTrigrams = codePointTrigrams(right);
  if (leftTrigrams.size === 0 && rightTrigrams.size === 0) return 1;
  if (leftTrigrams.size === 0 || rightTrigrams.size === 0) return 0;
  let intersection = 0;
  for (const trigram of leftTrigrams) {
    if (rightTrigrams.has(trigram)) intersection += 1;
  }
  const union = leftTrigrams.size + rightTrigrams.size - intersection;
  return intersection / union;
}
