import type { Request, Response } from "express";
import type { ClockifySignatureParser } from "@apet97/clockify-addon-sdk";
import type { AppConfig } from "../config.js";
import type { Installation, Store } from "../db/store.js";
import type { WorkspaceClient } from "../clockify/client.js";
import type { ModelClient } from "../assistant/model-client.js";
import type { WorkspaceMutationCoordinator } from "../clockify/workspace-mutation-coordinator.js";
import type { RuntimeReleaseArtifactIdentity } from "../release-artifact.js";
import type { ApiOperationIndex } from "../assistant-v2/discovery/api-index.js";
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
  clockifyForWorkspace: (
    installation: Installation,
    options?: { signal?: AbortSignal },
  ) => WorkspaceClient;
  /** Shared lifecycle/write settlement barrier. createApp supplies one when omitted. */
  mutationCoordinator?: WorkspaceMutationCoordinator;
  now?: () => Date;
  readiness?: { isReady(): boolean };
  /** Verified once before production startup. Public version metadata is read
   * from this proof, never echoed directly from environment configuration. */
  releaseArtifactIdentity?: RuntimeReleaseArtifactIdentity;
  /** Tests written before persisted intent capabilities may opt out. Ignored
   * outside NODE_ENV=test; production has no capability-enforcement toggle. */
  enforceIntentCapabilitiesInTests?: true;
  /** Immutable trusted API discovery index built once at startup from MODEL_API. */
  apiOperationIndex?: ApiOperationIndex;
  /** Human-readable product version reported by /version. The ONE source of
   * truth is package.json's `version`; createApp reads it when omitted so
   * every caller (production start() and tests) sees the same value unless a
   * test deliberately overrides it. Never a literal duplicated elsewhere. */
  productVersion?: string;
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
    // `decodeURIComponent` THROWS on a malformed escape (`%zz`), and a cookie
    // header is third-party input: any other app on the domain can set one.
    // A bare call turned that into an uncaught parser exception and a generic
    // 500 before any auth decision — for requests whose OWN session cookie was
    // perfectly valid. Skip only the offending pair, keep the rest.
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      // A value that is not valid percent-encoding cannot be a cookie this app
      // issued, so dropping it lands on the ordinary absent/invalid-session
      // path rather than failing the request.
      continue;
    }
  }
  return out;
}

/** Cookie Max-Age fallback (seconds) when no TTL is threaded (e.g. the in-process
 *  test cookie helper); matches the store's own 8h session fallback. Real routes
 *  pass `sessionTtlMs/1000` so the cookie expiry tracks the authoritative TTL. */
const DEFAULT_COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60;

export function buildSessionCookie(
  value: string,
  secure: boolean,
  maxAgeSeconds: number = DEFAULT_COOKIE_MAX_AGE_SECONDS,
): string {
  const attributes = [
    `${SESSION_COOKIE}=${value}`,
    "HttpOnly",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
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
export function setSessionCookie(
  res: Response,
  claims: SessionClaims,
  sessionSecret: string,
  baseUrl: string,
  sessionTtlMs: number,
): void {
  const secure = baseUrl.startsWith("https://");
  res.setHeader(
    "Set-Cookie",
    buildSessionCookie(signSessionCookie(claims, sessionSecret), secure, Math.floor(sessionTtlMs / 1000)),
  );
}
