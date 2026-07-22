import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Router, type Response } from "express";
import { ClockifyQueryParams, verifyAddonToken } from "../addon/verify.js";
import { isAdminRole } from "../auth/roles.js";
import { signSessionCookie, type SessionClaims } from "../auth/sessions.js";
import { asyncHandler } from "./async-handler.js";
import { buildSessionCookie, resolveSession, type AppDeps } from "./deps.js";
import { canonicalClockifyServiceUrl } from "../clockify/service-url.js";
import { clockifyUiPreferences } from "../ui-preferences.js";
import { createRouteAuthority } from "./route-authority.js";

/**
 * Admin-only component route (ARCHITECTURE "Component Load"). Verifies the
 * Clockify token, rejects non-admins BEFORE any session is created, then issues
 * a signed HTTP-only session cookie and serves the chat shell.
 */
const BUILT_INDEX = resolve("dist/ui/index.html");

/**
 * Defense-in-depth for the embedded chat HTML, which renders attacker-influenced
 * workspace data (project/client names, time-entry descriptions, model reply
 * text). The render layer is already XSS-safe by convention (textContent /
 * createElementNS, never innerHTML — see ui/render.ts), so these headers are a
 * BACKSTOP, not the only control: they neutralise a future regression to
 * innerHTML and add a header-level clickjacking control.
 *
 * The shell loads ONLY external same-origin module script + stylesheet (no
 * inline script/style), so the policy can be strict without 'unsafe-inline'.
 * `connect-src 'self'` covers the same-origin /api chat fetches (incl. NDJSON).
 *
 * frame-ancestors MUST keep the Clockify/CAKE embedding origins — the component
 * renders inside Clockify's cross-site iframe; omitting them would break the
 * embed. Clockify hosts the iframe from *.clockify.me (app + developer console)
 * and the marketplace from *.cake.com.
 */
const FRAME_ANCESTORS = "https://*.clockify.me https://*.cake.com";
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  `frame-ancestors ${FRAME_ANCESTORS}`,
].join("; ");

/** Apply the HTML-response security headers (idempotent, value-stable). */
function setComponentSecurityHeaders(res: Response): void {
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "private, no-store");
}

const ADMIN_ONLY_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>AI Assistant</title></head>
<body><main><h1>AI Assistant</h1><p>This add-on is available to Clockify admins and owners only.</p></main></body></html>`;

const NOT_INSTALLED_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>AI Assistant</title></head>
<body><main><h1>AI Assistant</h1><p>This add-on is not installed for this workspace. Install it from the Clockify marketplace to continue.</p></main></body></html>`;

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
  const authority = createRouteAuthority(deps);

  router.get(
    "/component/assistant",
    asyncHandler(async (req, res) => {
      // Set the HTML security backstop on EVERY response path (rejection pages and
      // the chat shell alike) before branching, so no render surface ships bare.
      setComponentSecurityHeaders(res);

      const token = req.query[ClockifyQueryParams.AUTH_TOKEN];
      const claims = await verifyAddonToken(deps.parser, typeof token === "string" ? token : undefined);

      if (!claims) {
        return res.status(401).type("html").send(ADMIN_ONLY_PAGE);
      }

      const workspaceId = claims.workspaceId;
      const adminUserId = claims.user;
      if (!workspaceId || !adminUserId) {
        return res.status(401).type("html").send(ADMIN_ONLY_PAGE);
      }
      if (!isAdminRole(claims.workspaceRole)) {
        deps.store.invalidateAdminSessions(workspaceId, adminUserId);
        return res.status(403).type("html").send(ADMIN_ONLY_PAGE);
      }

      // Active-installation gate: a valid admin token for a workspace where the
      // add-on was never installed (or was uninstalled) must NOT mint a session —
      // that cookie would otherwise reach /permissions, /metrics, and /chat/history
      // for an uninstalled workspace. The lifecycle install always precedes the
      // first component load, so an active row is expected here.
      const installation = deps.store.getInstallation(workspaceId);
      if (!installation || installation.status !== "active") {
        return res.status(409).type("html").send(NOT_INSTALLED_PAGE);
      }

      // Refresh environment hosts from the freshest token. The install/lifecycle
      // token often omits backendUrl/reportsUrl, so the user token loaded here is
      // the reliable source of which Clockify hosts to call (api + reports differ
      // by environment — see resolveClockify*Base). Only present fields change.
      try {
        const apiUrl = typeof claims.backendUrl === "string"
          ? canonicalClockifyServiceUrl(claims.backendUrl, "api")
          : undefined;
        const reportsUrl = typeof claims.reportsUrl === "string"
          ? canonicalClockifyServiceUrl(claims.reportsUrl, "reports")
          : undefined;
        deps.store.updateInstallationEnv(workspaceId, {
          apiUrl,
          backendUrl: apiUrl,
          reportsUrl,
        });
      } catch {
        return res.status(400).type("html").send(ADMIN_ONLY_PAGE);
      }

      // The iframe JWT role can be stale after demotion. Force a current-role
      // lookup through the shared authority choke point before reusing or
      // creating any privileged session. Non-admin invalidates every existing
      // session; lookup uncertainty fails closed without setting a cookie.
      const refreshedInstallation = deps.store.getInstallation(workspaceId);
      if (!refreshedInstallation || refreshedInstallation.status !== "active") {
        return res.status(409).type("html").send(NOT_INSTALLED_PAGE);
      }
      // Role and display-context reads are independent. Start both together so
      // verified Clockify timezone propagation adds no sequential iframe delay.
      // A missing/invalid display context is omitted rather than guessed; role
      // uncertainty still fails the entire privileged session closed.
      const [liveAuthority, calendarContext] = await Promise.all([
        authority.verifyWriteAuthority(
          { sessionId: "", workspaceId, adminUserId },
          refreshedInstallation,
        ),
        deps.clockifyForWorkspace(refreshedInstallation)
          .getCalendarContext(adminUserId)
          .catch(() => undefined),
      ]);
      if (!liveAuthority.ok) {
        return res.status(liveAuthority.status).type("html").send(ADMIN_ONLY_PAGE);
      }

      // verifyWriteAuthority awaited Clockify. Recheck the durable generation
      // synchronously at the session-creation boundary so uninstall/reinstall
      // cannot erase the workspace during that await and then have this request
      // recreate a session after deletion. There is deliberately no await
      // between this check and resolve/create below.
      const sessionBoundaryInstallation = deps.store.getInstallation(workspaceId);
      if (
        !refreshedInstallation
        || !sessionBoundaryInstallation
        || sessionBoundaryInstallation.status !== "active"
        || sessionBoundaryInstallation.generation !== refreshedInstallation.generation
      ) {
        return res.status(409).type("html").send(NOT_INSTALLED_PAGE);
      }

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
        : deps.store.createSession({ workspaceId, adminUserId, ttlMs: deps.config.sessionTtlMs });
      const sessionClaims: SessionClaims = {
        sessionId: session.id,
        workspaceId,
        adminUserId,
        workspaceRole: String(claims.workspaceRole),
        uiPreferences: clockifyUiPreferences(claims.theme, calendarContext?.timeZone),
        expiresAt: session.expiresAt,
      };
      const cookie = signSessionCookie(sessionClaims, deps.config.sessionSecret);
      res.setHeader(
        "Set-Cookie",
        buildSessionCookie(
          cookie,
          deps.config.baseUrl.startsWith("https://"),
          Math.floor(deps.config.sessionTtlMs / 1000),
        ),
      );
      return res.status(200).type("html").send(shellHtml());
    }),
  );

  return router;
}
