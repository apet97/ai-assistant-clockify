/**
 * Hand-rolled per-key sliding-window rate limiter for the paid model loops — each
 * chat turn drives a paid model loop plus Clockify calls, and the confirm-time
 * RESUME drives one too (a chain of confirm→resume→preview→confirm would
 * otherwise run unbounded). Both are charged against the same per-session budget
 * so the limiter actually bounds the paid-loop cost it exists to damp; cancel and
 * undo stay button-driven + one-use (no model call). In-memory and per-process by
 * design: a single Railway instance, and the goal is paid-loop abuse damping, not
 * security. No new dependencies.
 */

export const DEFAULT_CHAT_RATE_LIMIT_MAX = 30;
export const DEFAULT_CHAT_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

/**
 * New-chat (session-creation) budget per ADMIN. The chat limiter above is keyed by
 * sessionId, so minting fresh sessions via POST /chat/new would reset that per-session
 * budget — this per-admin cap bounds how fast an admin can spin up new budgets.
 * Generous for a human (clicking "New chat"), low enough to damp the bypass.
 */
export const DEFAULT_NEW_CHAT_RATE_LIMIT_MAX = 10;
export const DEFAULT_NEW_CHAT_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

/** Broad authenticated API budget. Unlike the paid-loop limiter, this is keyed
 * by workspace + admin so minting/opening another chat session cannot reset it.
 * The default leaves ample headroom for shell hydration, NDJSON, artifacts, and
 * the release benchmark while bounding database/authorization work. api.ts uses
 * express-rate-limit for this layer so CodeQL recognizes the route protection. */
export const DEFAULT_API_RATE_LIMIT_MAX = 600;
export const DEFAULT_API_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

/** Sweep dead keys every N checks so the map can't grow unboundedly. */
const SWEEP_EVERY_CHECKS = 512;

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

export interface RateLimiter {
  /** Record a hit for `key` at `nowMs`; deny when `max` hits already landed inside the window. */
  check(key: string, nowMs: number): RateLimitDecision;
}

export function createSlidingWindowLimiter(max: number, windowMs: number): RateLimiter {
  const hits = new Map<string, number[]>();
  let checks = 0;

  return {
    check(key: string, nowMs: number): RateLimitDecision {
      checks += 1;
      if (checks % SWEEP_EVERY_CHECKS === 0) {
        for (const [k, stamps] of hits) {
          if (stamps.length === 0 || stamps[stamps.length - 1] <= nowMs - windowMs) hits.delete(k);
        }
      }
      const recent = (hits.get(key) ?? []).filter((t) => t > nowMs - windowMs);
      if (recent.length >= max) {
        // The denied hit is NOT recorded — a hammering client still recovers
        // as soon as the window slides, instead of pushing recovery away.
        hits.set(key, recent);
        return { allowed: false, retryAfterMs: recent[0] + windowMs - nowMs };
      }
      recent.push(nowMs);
      hits.set(key, recent);
      return { allowed: true };
    },
  };
}
