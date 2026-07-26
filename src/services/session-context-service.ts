import type { SessionClaims } from "../auth/sessions.js";
import { createCsrfToken } from "../auth/csrf.js";
import type { Store } from "../db/store.js";
import type { PublicProductLinks, SessionListView } from "../shared/contracts.js";

/**
 * SessionContextService (T16-D): the authenticated session-context views and
 * transitions extracted from `routes/api.ts`. It builds claims and view data
 * only — signing and setting the HttpOnly cookie stays in the transport layer.
 * Every method is scoped to the caller's verified workspace+admin; the
 * open-session target check is the IDOR guard (a foreign target reads as
 * nonexistent, never as forbidden).
 */
export interface SessionContextServiceDeps {
  store: Pick<Store, "createSession" | "getSession" | "listSessions">;
  sessionSecret: string;
  baseUrl: string;
  sessionTtlMs: number;
  now(): Date;
}

export interface MeView {
  workspaceId: string;
  adminUserId: string;
  workspaceRole: string;
  preferences: NonNullable<SessionClaims["uiPreferences"]>;
  links: PublicProductLinks;
  csrfToken: string;
}

export function createSessionContextService(deps: SessionContextServiceDeps) {
  function me(claims: SessionClaims): MeView {
    return {
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      workspaceRole: claims.workspaceRole,
      preferences: claims.uiPreferences ?? { theme: "system" },
      links: {
        privacy: new URL("/privacy", deps.baseUrl).toString(),
        support: new URL("/support", deps.baseUrl).toString(),
        security: new URL("/security", deps.baseUrl).toString(),
      },
      csrfToken: createCsrfToken(claims.sessionId, deps.sessionSecret),
    };
  }

  function listSessions(claims: SessionClaims): SessionListView {
    const sessions = deps.store
      .listSessions(claims.workspaceId, claims.adminUserId, deps.now().toISOString())
      .map((s) => ({ ...s, current: s.id === claims.sessionId }));
    return { sessions };
  }

  /** Mint a FRESH session for the same admin+workspace. The previous session's
   * messages are NOT deleted — only the transcript the UI shows resets. */
  function startNewSession(claims: SessionClaims): SessionClaims {
    const session = deps.store.createSession({
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      ttlMs: deps.sessionTtlMs,
    });
    return {
      sessionId: session.id,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      workspaceRole: claims.workspaceRole,
      ...(claims.uiPreferences ? { uiPreferences: claims.uiPreferences } : {}),
      expiresAt: session.expiresAt,
    };
  }

  /** Resolve a switch to a PAST conversation. The target must be a LIVE session
   * owned by THIS workspace+admin; getSession already drops expired rows, so an
   * expired/unknown/foreign id is indistinguishable (undefined -> 404, no
   * cookie). The returned claims carry the TARGET's own expiry — never
   * extended. */
  function openSession(claims: SessionClaims, targetSessionId: string): SessionClaims | undefined {
    const target = deps.store.getSession(targetSessionId);
    if (
      !target ||
      target.workspaceId !== claims.workspaceId ||
      target.adminUserId !== claims.adminUserId
    ) {
      return undefined;
    }
    return {
      sessionId: target.id,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      workspaceRole: claims.workspaceRole,
      ...(claims.uiPreferences ? { uiPreferences: claims.uiPreferences } : {}),
      expiresAt: target.expiresAt,
    };
  }

  return { me, listSessions, startNewSession, openSession };
}

export type SessionContextService = ReturnType<typeof createSessionContextService>;
