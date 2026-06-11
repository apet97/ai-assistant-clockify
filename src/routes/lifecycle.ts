import { Router, type Request } from "express";
import { ClockifyHeaders, verifyAddonToken } from "../addon/verify.js";
import type { AppDeps } from "./deps.js";

/**
 * Clockify lifecycle routes (ARCHITECTURE "Lifecycle Install"). Each request is
 * authenticated by the signed lifecycle token header before any state changes.
 * The installed payload carries the add-on token used for later API calls; it is
 * stored encrypted and never logged.
 */
function getLifecycleToken(req: Request): string | undefined {
  const value = req.headers[ClockifyHeaders.LIFECYCLE_TOKEN];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Bind the workspace to the VERIFIED token claim. A valid lifecycle token must
 * only ever mutate the workspace it was signed for, so the attacker-controlled
 * request body can never select a different (victim) workspace. Returns the
 * authoritative workspaceId, or `"mismatch"` when the body names a workspace
 * that disagrees with the claim (cross-workspace install hijack / DoS).
 */
function resolveWorkspaceId(
  claimWorkspaceId: unknown,
  bodyWorkspaceId: unknown,
): string | undefined | "mismatch" {
  const claimWs = typeof claimWorkspaceId === "string" ? claimWorkspaceId : undefined;
  const bodyWs = typeof bodyWorkspaceId === "string" ? bodyWorkspaceId : undefined;
  if (claimWs && bodyWs && claimWs !== bodyWs) return "mismatch";
  // Prefer the verified claim; fall back to the body only when the claim omits it.
  return claimWs ?? bodyWs;
}

export function lifecycleRouter(deps: AppDeps): Router {
  const router = Router();

  router.post("/lifecycle/installed", async (req, res) => {
    const claims = await verifyAddonToken(deps.parser, getLifecycleToken(req));
    if (!claims) return res.status(401).json({ ok: false, code: "unauthorized" });

    const body = req.body ?? {};
    // INSTALLED payload (Clockify): { addonId, authToken, workspaceId, asUser,
    // apiUrl, addonUserId, webhooks }. Only the installation token + workspace
    // are essential — capture the rest opportunistically. Requiring optional
    // metadata (e.g. addonUserId) would reject otherwise-valid installs.
    const workspaceId = resolveWorkspaceId(claims.workspaceId, body.workspaceId);
    if (workspaceId === "mismatch") {
      return res.status(403).json({ ok: false, code: "workspace_mismatch" });
    }
    const addonToken = body.authToken;
    if (!workspaceId || !addonToken) {
      return res.status(400).json({ ok: false, code: "invalid_payload" });
    }

    deps.store.saveInstallation({
      workspaceId,
      addonId: body.addonId ?? claims.addonId ?? "",
      addonUserId: body.addonUserId ?? "",
      addonToken,
      apiUrl: body.apiUrl,
      backendUrl: claims.backendUrl,
      status: "active",
      installedByUserId: body.asUser,
    });
    return res.status(200).json({ ok: true });
  });

  router.post("/lifecycle/status-changed", async (req, res) => {
    const claims = await verifyAddonToken(deps.parser, getLifecycleToken(req));
    if (!claims) return res.status(401).json({ ok: false, code: "unauthorized" });

    const body = req.body ?? {};
    const workspaceId = resolveWorkspaceId(claims.workspaceId, body.workspaceId);
    if (workspaceId === "mismatch") {
      return res.status(403).json({ ok: false, code: "workspace_mismatch" });
    }
    if (!workspaceId) return res.status(400).json({ ok: false, code: "invalid_payload" });

    const status = String(body.status ?? "").toUpperCase() === "ACTIVE" ? "active" : "inactive";
    deps.store.setInstallationStatus(workspaceId, status);
    return res.status(200).json({ ok: true });
  });

  router.post("/lifecycle/deleted", async (req, res) => {
    const claims = await verifyAddonToken(deps.parser, getLifecycleToken(req));
    if (!claims) return res.status(401).json({ ok: false, code: "unauthorized" });

    const body = req.body ?? {};
    const workspaceId = resolveWorkspaceId(claims.workspaceId, body.workspaceId);
    if (workspaceId === "mismatch") {
      return res.status(403).json({ ok: false, code: "workspace_mismatch" });
    }
    if (!workspaceId) return res.status(400).json({ ok: false, code: "invalid_payload" });

    deps.store.setInstallationStatus(workspaceId, "deleted");
    return res.status(200).json({ ok: true });
  });

  return router;
}
