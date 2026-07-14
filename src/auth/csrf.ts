import { createHmac, timingSafeEqual } from "node:crypto";

export const CSRF_HEADER = "x-csrf-token";

export function createCsrfToken(sessionId: string, secret: string): string {
  return createHmac("sha256", secret).update(`csrf:v1:${sessionId}`).digest("base64url");
}

export function verifyCsrfToken(candidate: unknown, sessionId: string, secret: string): boolean {
  if (typeof candidate !== "string") return false;
  const expected = createCsrfToken(sessionId, secret);
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
