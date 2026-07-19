import { describe, expect, it } from "vitest";
import { signSessionCookie, verifySessionCookie, type SessionClaims } from "../../src/auth/sessions.js";

const SECRET = "session-secret-value";

function makeClaims(overrides: Partial<SessionClaims> = {}): SessionClaims {
  return {
    sessionId: "sess-1",
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    workspaceRole: "ADMIN",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe("session cookie", () => {
  it("verifies with the same secret and round-trips claims", () => {
    const claims = makeClaims({ uiPreferences: { theme: "dark", language: "sr" } });
    const cookie = signSessionCookie(claims, SECRET);
    const verified = verifySessionCookie(cookie, SECRET);
    expect(verified).toEqual(claims);
  });

  it("fails with a different secret", () => {
    const cookie = signSessionCookie(makeClaims(), SECRET);
    expect(verifySessionCookie(cookie, "other-secret")).toBeUndefined();
  });

  it("fails when the payload is tampered", () => {
    const cookie = signSessionCookie(makeClaims(), SECRET);
    const [payload, signature] = cookie.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify(makeClaims({ adminUserId: "attacker" })),
      "utf8",
    ).toString("base64url");
    expect(verifySessionCookie(`${tamperedPayload}.${signature}`, SECRET)).toBeUndefined();
    void payload;
  });

  it("fails when the signature is tampered", () => {
    const cookie = signSessionCookie(makeClaims(), SECRET);
    const [payload] = cookie.split(".");
    expect(verifySessionCookie(`${payload}.deadbeef`, SECRET)).toBeUndefined();
  });

  it("rejects an expired cookie", () => {
    const expired = makeClaims({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const cookie = signSessionCookie(expired, SECRET);
    expect(verifySessionCookie(cookie, SECRET)).toBeUndefined();
  });

  it("rejects a malformed cookie", () => {
    expect(verifySessionCookie("not-a-cookie", SECRET)).toBeUndefined();
    expect(verifySessionCookie("", SECRET)).toBeUndefined();
  });
});
