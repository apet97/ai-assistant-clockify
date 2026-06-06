import type { Request } from "express";
import type { ClockifySignatureParser } from "@apet97/clockify-addon-sdk";
import type { AppConfig } from "../config.js";
import type { Installation, Store } from "../db/store.js";
import type { WorkspaceClient } from "../clockify/client.js";
import type { ModelClient } from "../assistant/model-client.js";
import { verifySessionCookie, type SessionClaims } from "../auth/sessions.js";

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

export const SESSION_COOKIE = "ai_assistant_session";

export function parseCookies(header: string | undefined): Record<string, string> {
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
    "SameSite=Lax",
    `Max-Age=${8 * 60 * 60}`,
  ];
  if (secure) attributes.push("Secure");
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
