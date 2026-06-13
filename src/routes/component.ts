import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Router } from "express";
import { ClockifyQueryParams, verifyAddonToken } from "../addon/verify.js";
import { isAdminRole } from "../auth/roles.js";
import { signSessionCookie, type SessionClaims } from "../auth/sessions.js";
import { buildSessionCookie, resolveSession, type AppDeps } from "./deps.js";

/**
 * Admin-only component route (ARCHITECTURE "Component Load"). Verifies the
 * Clockify token, rejects non-admins BEFORE any session is created, then issues
 * a signed HTTP-only session cookie and serves the chat shell.
 */
const BUILT_INDEX = resolve("dist/ui/index.html");

const ADMIN_ONLY_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>AI Assistant</title></head>
<body><main><h1>AI Assistant</h1><p>This add-on is available to Clockify admins and owners only.</p></main></body></html>`;

function shellHtml(): string {
  if (existsSync(BUILT_INDEX)) return readFileSync(BUILT_INDEX, "utf8");
  // Dev/test fallback shell (the built bundle is served from /ui/ in production).
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Assistant</title><link rel="stylesheet" href="/ui/styles.css"></head>
<body><div id="app">Loading AI Assistant…</div><script type="module" src="/ui/main.js"></script></body></html>`;
}

export function componentRouter(deps: AppDeps): Router {
  const router = Router();
  const secure = deps.config.baseUrl.startsWith("https://");

  router.get("/component/assistant", async (req, res) => {
    const token = req.query[ClockifyQueryParams.AUTH_TOKEN];
    const claims = await verifyAddonToken(deps.parser, typeof token === "string" ? token : undefined);

    if (!claims) {
      return res.status(401).type("html").send(ADMIN_ONLY_PAGE);
    }
    if (!isAdminRole(claims.workspaceRole)) {
      return res.status(403).type("html").send(ADMIN_ONLY_PAGE);
    }

    const workspaceId = claims.workspaceId;
    const adminUserId = claims.user;
    if (!workspaceId || !adminUserId) {
      return res.status(401).type("html").send(ADMIN_ONLY_PAGE);
    }

    // Refresh environment hosts from the freshest token. The install/lifecycle
    // token often omits backendUrl/reportsUrl, so the user token loaded here is
    // the reliable source of which Clockify hosts to call (api + reports differ
    // by environment — see resolveClockify*Base). Only present fields change.
    deps.store.updateInstallationEnv(workspaceId, {
      apiUrl: claims.backendUrl,
      backendUrl: claims.backendUrl,
      reportsUrl: claims.reportsUrl,
    });

    // Reuse the SAME session across an iframe RELOAD so the conversation history
    // and the still-live pending previews survive it. resolveSession already
    // verifies the incoming cookie is signed AND backs a live (non-expired) session
    // row; we additionally require it to belong to THIS freshly-verified admin +
    // workspace, so a stale/foreign/expired cookie can never bind another session
    // (admin-rejection-before-session and the per-admin/workspace binding both
    // still hold). Anything else mints a fresh session.
    const existing = resolveSession(req, deps);
    const reuse =
      existing !== undefined &&
      existing.workspaceId === workspaceId &&
      existing.adminUserId === adminUserId;
    const session = reuse
      ? { id: existing.sessionId, expiresAt: existing.expiresAt }
      : deps.store.createSession({ workspaceId, adminUserId });
    const sessionClaims: SessionClaims = {
      sessionId: session.id,
      workspaceId,
      adminUserId,
      workspaceRole: String(claims.workspaceRole),
      expiresAt: session.expiresAt,
    };
    const cookie = signSessionCookie(sessionClaims, deps.config.sessionSecret);
    res.setHeader("Set-Cookie", buildSessionCookie(cookie, secure));
    return res.status(200).type("html").send(shellHtml());
  });

  return router;
}
