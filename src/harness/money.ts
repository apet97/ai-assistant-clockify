/**
 * Amount-unit conversion — the single source of truth for the major↔minor
 * (×100) mapping that Clockify's money fields want as integer minor units, in
 * BOTH directions (`toMinor` in, `fromMinor` out).
 *
 * This conversion has historically been a bug source when copied per-workflow
 * (rounding before vs. after the ×100, divergent inline copies). Every workflow
 * that accepts a major/minor `amount` MUST funnel through `toMinor` so the
 * mapping is fixed in exactly one place; every read that renders a minor-unit
 * wire value back to a major string MUST funnel through `fromMinor`.
 */

/** Resolve a major/minor amount to the integer minor units (cents) Clockify wants. */
export function toMinor(amount: number, unit: "major" | "minor"): number {
  return unit === "minor" ? Math.round(amount) : Math.round(amount * 100);
}

/** Render integer minor units (cents) back to a bare 2-decimal major string (no currency symbol) — the inverse of `toMinor`. */
export function fromMinor(minor: number): string {
  return (minor / 100).toFixed(2);
}
