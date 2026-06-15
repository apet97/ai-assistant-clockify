/**
 * Pure consistency metrics over a signature histogram (Phase 0 — the weak-model
 * meter). The eval scripts already record, per case, a `signatures` histogram
 * (each distinct "action+arg-keys" signature → how many of the --repeat runs
 * produced it). This module turns that histogram into the numbers we judge a
 * weak model by:
 *
 *   - modalFraction      — the EXISTING metric: most-common-signature / runs.
 *   - distinct           — how many DIFFERENT signatures appeared (1 = stable).
 *   - entropyBits        — Shannon spread in bits (0 = one signature; grows as
 *                          the model scatters across more, more-even choices).
 *   - normalizedEntropy  — entropyBits / log2(runs) in [0,1], so a 3-run case and
 *                          a 10-run case are comparable.
 *
 * modalFraction alone hides shape: {a:2,b:1} and {a:2,c:1} both score 0.67, but a
 * case that scatters across MANY signatures (low modal, high distinct/entropy) is
 * a different, worse failure than a clean 50/50 flip. Entropy + distinct surface
 * that so Phases 1–3 can target the genuinely chaotic cases first.
 *
 * Pure and deterministic (no I/O, clock, or catalog) — unit-tested in isolation.
 */

/** A `signature → run-count` histogram, as produced per case by the eval scripts. */
export type SignatureHistogram = Record<string, number>;

export interface ConsistencyStats {
  /** Total runs counted (sum of the histogram values). */
  total: number;
  /** Number of DISTINCT signatures observed (1 = perfectly consistent). */
  distinct: number;
  /** The most frequent (modal) signature, or "" when there were no runs. */
  modal: string;
  /** Modal count / total — the existing consistency metric, in [0,1]. */
  modalFraction: number;
  /** Shannon entropy of the distribution, in bits (0 = one signature). */
  entropyBits: number;
  /** entropyBits / log2(total) in [0,1] — spread normalized to this run count. */
  normalizedEntropy: number;
}

/** Compute the consistency statistics for one case's signature histogram. */
export function consistencyStats(signatures: SignatureHistogram): ConsistencyStats {
  const entries = Object.entries(signatures).filter(([, count]) => count > 0);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);

  if (total === 0) {
    return { total: 0, distinct: 0, modal: "", modalFraction: 0, entropyBits: 0, normalizedEntropy: 0 };
  }

  let modal = "";
  let modalCount = 0;
  let entropyBits = 0;
  for (const [signature, count] of entries) {
    if (count > modalCount) {
      modal = signature;
      modalCount = count;
    }
    const p = count / total;
    entropyBits -= p * Math.log2(p);
  }

  return {
    total,
    distinct: entries.length,
    modal,
    modalFraction: modalCount / total,
    entropyBits,
    // log2(1) === 0 → a single run can't be "spread"; guard the divide.
    normalizedEntropy: total > 1 ? entropyBits / Math.log2(total) : 0,
  };
}

/** Mean of a numeric list; 0 for an empty list (never NaN). Shared by the meters. */
export function mean(values: number[]): number {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}
