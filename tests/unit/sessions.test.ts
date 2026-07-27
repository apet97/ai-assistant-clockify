import { createHmac } from "node:crypto";
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

function signRawSessionPayload(claims: unknown): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

describe("session cookie", () => {
  it("verifies with the same secret and round-trips claims", () => {
    const claims = makeClaims();
    const cookie = signSessionCookie(claims, SECRET);
    const verified = verifySessionCookie(cookie, SECRET);
    expect(verified).toEqual(claims);
  });

  it("accepts and drops only the legacy language field in signed preferences", () => {
    const claims = makeClaims();
    const cookie = signRawSessionPayload({
      ...claims,
      uiPreferences: { theme: "dark", language: "sr", timeZone: "Europe/Belgrade" },
    });

    expect(verifySessionCookie(cookie, SECRET)).toEqual({
      ...claims,
      uiPreferences: { theme: "dark", timeZone: "Europe/Belgrade" },
    });
  });

  it("keeps the nested preference object strict during legacy migration", () => {
    const cookie = signRawSessionPayload({
      ...makeClaims(),
      uiPreferences: { theme: "dark", language: "sr", unrelated: true },
    });

    expect(verifySessionCookie(cookie, SECRET)).toBeUndefined();
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
