import { hashOperation } from "./confirmations.js";

/** Stable JSON fingerprint for nonsecret billing projections and snapshots. */
export function billingFingerprint(value: unknown): string {
  return hashOperation(value);
}

export function normalizeBillingDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? value : new Date(millis).toISOString();
}
