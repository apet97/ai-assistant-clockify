import { describe, expect, it } from "vitest";
import { createSlidingWindowLimiter } from "../../src/routes/rate-limit.js";

describe("createSlidingWindowLimiter", () => {
  it("allows up to max hits in the window and denies the next with the right retryAfterMs", () => {
    const limiter = createSlidingWindowLimiter(3, 60_000);
    expect(limiter.check("s1", 1_000)).toEqual({ allowed: true });
    expect(limiter.check("s1", 2_000)).toEqual({ allowed: true });
    expect(limiter.check("s1", 3_000)).toEqual({ allowed: true });
    // Oldest hit at 1_000 leaves the window at 61_000.
    expect(limiter.check("s1", 10_000)).toEqual({ allowed: false, retryAfterMs: 51_000 });
  });

  it("allows again once the oldest hit slides out of the window", () => {
    const limiter = createSlidingWindowLimiter(2, 60_000);
    limiter.check("s1", 1_000);
    limiter.check("s1", 2_000);
    expect(limiter.check("s1", 3_000).allowed).toBe(false);
    expect(limiter.check("s1", 61_001).allowed).toBe(true); // hit@1000 expired
  });

  it("a denied hit does NOT extend the window (a hammering client still recovers)", () => {
    const limiter = createSlidingWindowLimiter(1, 60_000);
    limiter.check("s1", 1_000);
    for (let t = 2_000; t < 60_000; t += 10_000) {
      expect(limiter.check("s1", t).allowed).toBe(false);
    }
    expect(limiter.check("s1", 61_001).allowed).toBe(true);
  });

  it("independent keys never share budget", () => {
    const limiter = createSlidingWindowLimiter(1, 60_000);
    expect(limiter.check("s1", 1_000).allowed).toBe(true);
    expect(limiter.check("s2", 1_000).allowed).toBe(true);
    expect(limiter.check("s1", 2_000).allowed).toBe(false);
    expect(limiter.check("s2", 2_000).allowed).toBe(false);
  });
});
