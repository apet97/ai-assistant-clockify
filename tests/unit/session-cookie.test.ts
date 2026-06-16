import { describe, expect, it } from "vitest";
import { buildSessionCookie } from "../../src/routes/deps.js";

/**
 * The component runs inside Clockify's cross-site iframe. Over HTTPS the session
 * cookie MUST be SameSite=None + Secure (+ Partitioned for CHIPS) or the browser
 * drops it on the iframe's chat API calls and every request is unauthenticated.
 */
describe("buildSessionCookie", () => {
  it("is SameSite=None; Secure; Partitioned over HTTPS (cross-site iframe)", () => {
    const cookie = buildSessionCookie("abc", true);
    expect(cookie).toContain("ai_assistant_session=abc");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Partitioned");
    expect(cookie).not.toContain("SameSite=Lax");
  });

  it("falls back to SameSite=Lax (no Secure) for local http dev", () => {
    const cookie = buildSessionCookie("abc", false);
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("SameSite=None");
    expect(cookie).not.toContain("Secure");
  });

  it("sets Max-Age to the supplied TTL seconds (T50: cookie tracks sessionTtlMs, not a hard-coded 8h)", () => {
    // 2h default session TTL -> 7200s, not the old 28800 (8h).
    expect(buildSessionCookie("abc", true, 7200)).toContain("Max-Age=7200");
    expect(buildSessionCookie("abc", true, 7200)).not.toContain("Max-Age=28800");
  });
});
