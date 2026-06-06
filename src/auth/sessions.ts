import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Signed, HTTP-only session cookie (ARCHITECTURE "Component Load").
 *
 * Cookie value shape: `<base64url(JSON claims)>.<base64url HMAC-SHA256>`.
 * The signature covers the encoded payload; verification is timing-safe and
 * rejects tampering, wrong secret, malformed input, and expired claims.
 */
export interface SessionClaims {
  sessionId: string;
  workspaceId: string;
  adminUserId: string;
  workspaceRole: string;
  expiresAt: string;
}

const sessionClaimsSchema = z.object({
  sessionId: z.string().min(1),
  workspaceId: z.string().min(1),
  adminUserId: z.string().min(1),
  workspaceRole: z.string().min(1),
  expiresAt: z.string().min(1),
});

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

export function signSessionCookie(claims: SessionClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySessionCookie(
  cookieValue: string,
  secret: string,
): SessionClaims | undefined {
  const separator = cookieValue.lastIndexOf(".");
  if (separator <= 0) return undefined;

  const payload = cookieValue.slice(0, separator);
  const signature = cookieValue.slice(separator + 1);
  if (!safeEqual(signature, sign(payload, secret))) return undefined;

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const result = sessionClaimsSchema.safeParse(decoded);
    if (!result.success) return undefined;
    if (new Date(result.data.expiresAt).getTime() <= Date.now()) return undefined;
    return result.data;
  } catch {
    return undefined;
  }
}
