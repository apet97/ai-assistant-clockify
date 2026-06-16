import type { Request, Response } from "express";
import type { ClockifySignatureParser } from "@apet97/clockify-addon-sdk";
import type { AppConfig } from "../config.js";
import type { Installation, Store } from "../db/store.js";
import type { WorkspaceClient } from "../clockify/client.js";
import type { ModelClient } from "../assistant/model-client.js";
import { signSessionCookie, verifySessionCookie, type SessionClaims } from "../auth/sessions.js";

/**
 * Shared app dependencies and request helpers. Leaf module so route modules and
 * server.ts can both import it without a cycle. Dependencies are injected so the
 * app is fully testable with a fake model, fake Clockify client, in-memory
 * store, and test-signed tokens.
 */
export interface AppDeps {
  config: AppConfig;
  store: Store;
  parser: ClockifySignatureParser;
  modelClient: ModelClient;
  /** Build a workspace-scoped Clockify client for an installation. */
  clockifyForWorkspace: (installation: Installation) => WorkspaceClient;
  now?: () => Date;
}

const SESSION_COOKIE = "ai_assistant_session";

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

export function buildSessionCookie(value: string, secure: boolean): string {
  const attributes = [
    `${SESSION_COOKIE}=${value}`,
    "HttpOnly",
    "Path=/",
    `Max-Age=${8 * 60 * 60}`,
  ];
  if (secure) {
    // The component renders inside Clockify's cross-site iframe, so the session
    // cookie must be SameSite=None + Secure to be SENT on the same-origin chat
    // API calls the iframe makes. Partitioned (CHIPS) keeps it working under
    // third-party-cookie blocking. Lax would silently drop the cookie there.
    attributes.push("SameSite=None", "Secure", "Partitioned");
  } else {
    // Local http dev/tests: browsers reject SameSite=None without Secure.
    attributes.push("SameSite=Lax");
  }
  return attributes.join("; ");
}

/**
 * Resolve the authenticated admin session from the signed cookie AND the
 * server-side session row. Returns undefined if either is missing/invalid.
 */
export function resolveSession(req: Request, deps: AppDeps): SessionClaims | undefined {
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[SESSION_COOKIE];
  if (!raw) return undefined;

  const claims = verifySessionCookie(raw, deps.config.sessionSecret);
  if (!claims) return undefined;

  const session = deps.store.getSession(claims.sessionId);
  if (!session) return undefined;
  if (session.workspaceId !== claims.workspaceId || session.adminUserId !== claims.adminUserId) {
    return undefined;
  }
  return claims;
}

/**
 * Sign `claims` and write the session cookie header (ARCH-04). The two
 * re-cookie routes (`POST /chat/new`, `POST /chat/sessions/:id/open`) build a
 * route-specific `SessionClaims`, then share this exact sign+set step so the
 * cookie attributes can never drift between them. The `secure` flag is derived
 * HERE from `baseUrl` (single source of truth) so no caller re-computes it: an
 * https base means the cross-site iframe cookie (SameSite=None; Secure;
 * Partitioned); local http dev/tests fall back to SameSite=Lax.
 */
export function setSessionCookie(res: Response, claims: SessionClaims, sessionSecret: string, baseUrl: string): void {
  const secure = baseUrl.startsWith("https://");
  res.setHeader("Set-Cookie", buildSessionCookie(signSessionCookie(claims, sessionSecret), secure));
}
