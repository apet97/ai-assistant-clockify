/**
 * Pure presentation logic for the embedded chat UI — countdown formatting,
 * expiry views, the smart-scroll predicate, per-item batch outcomes, and
 * display labels. A dependency-free leaf (types only from ./shared.js) so it
 * is unit-testable without a DOM and adds no module cycles. The DOM glue in
 * render.ts/main.ts consumes these; main.ts re-exports them for tests.
 *
 * TRUTH NOTES: expiry here is ADVISORY — the server's TTL check stays
 * authoritative (a stale Confirm gets the server's verbatim 400/409 message).
 * batchItemOutcomes never invents success: a missing response is a failure.
 */
import type { ConfirmResponse } from "./shared.js";

/** Milliseconds until an ISO instant; NaN when the date is malformed. */
export function msUntil(expiresAt: string, nowMs: number): number {
  return Date.parse(expiresAt) - nowMs;
}

/** "4:59"-style countdown; clamps at "0:00". */
export function formatCountdown(msRemaining: number): string {
  const totalSeconds = Math.max(0, Math.floor(msRemaining / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export interface ExpiryView {
  expired: boolean;
  label: string;
}

/**
 * The expiry pill for a preview card. `undefined` when there is nothing
 * trustworthy to show (absent or malformed `expiresAt` — old previews and
 * minimal test fixtures render without a pill rather than a broken one).
 */
export function expiryView(expiresAt: string | undefined, nowMs: number): ExpiryView | undefined {
  if (!expiresAt) return undefined;
  const remaining = msUntil(expiresAt, nowMs);
  if (Number.isNaN(remaining)) return undefined;
  if (remaining <= 0) return { expired: true, label: "Expired" };
  return { expired: false, label: `Expires in ${formatCountdown(remaining)}` };
}

/**
 * Whether the log is (near) the bottom — the auto-scroll only sticks then, so
 * reading older history is never yanked back down by streaming results.
 */
export function isNearBottom(
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
  slackPx = 48,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= slackPx;
}

export interface BatchItemOutcome {
  label: string;
  ok: boolean;
  detail: string;
}

/**
 * Per-item outcomes for a settled "Confirm all" card. Failures carry the
 * server's message verbatim; a label with no response is reported as a
 * failure, never assumed confirmed.
 */
export function batchItemOutcomes(labels: string[], responses: ConfirmResponse[]): BatchItemOutcome[] {
  return labels.map((label, i) => {
    const response = responses[i];
    if (!response) return { label, ok: false, detail: "No response." };
    if (response.ok) return { label, ok: true, detail: "Confirmed" };
    return { label, ok: false, detail: typeof response.message === "string" ? response.message : "Confirmation failed." };
  });
}

/** Display names for feature-group keys; wire values stay raw snake_case. */
const GROUP_LABEL_OVERRIDES: Record<string, string> = {
  users_groups: "Users & groups",
};

export function humanizeGroup(group: string): string {
  const override = GROUP_LABEL_OVERRIDES[group];
  if (override) return override;
  const words = group.split("_").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Display names for permission levels; unknown levels pass through unchanged. */
export function levelLabel(level: string): string {
  if (level === "off") return "Off";
  if (level === "read") return "Read only";
  if (level === "read_write") return "Read & write";
  return level;
}
