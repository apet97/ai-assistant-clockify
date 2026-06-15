import { Router, type Request } from "express";
import { ClockifyHeaders, verifyAddonToken } from "../addon/verify.js";
import { asyncHandler } from "./async-handler.js";
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
 * Resolve the authoritative workspaceId from the VERIFIED token claim ONLY. A
 * lifecycle token must only ever mutate the workspace it was signed for, so the
 * workspace is bound to the claim and the attacker-controlled request body can
 * NEVER select it: the body is accepted purely as a redundant echo that must
 * AGREE with the claim. `ClockifyAddonClaims.workspaceId` is OPTIONAL, and legacy
 * developer-portal tokens carry the workspace as `activeWs` instead — normalize
 * that here (mirrors the canonical reference add-ons) so a legitimate token still
 * resolves from its CLAIM. Returns the authoritative id, `undefined` when the
 * claim carries no workspace at all (caller MUST fail closed — never trust the
 * body), or `"mismatch"` when a present body disagrees with the claim.
 *
 * SECURITY (do not regress): the previous `claimWs ?? bodyWs` fallback let a
 * validly-signed token with NO workspace claim erase / hijack a victim workspace
 * named only in the body. The claim is the sole source of authority.
 */
function resolveWorkspaceId(
  claimWorkspaceId: unknown,
  claimActiveWs: unknown,
  bodyWorkspaceId: unknown,
): string | undefined | "mismatch" {
  const claimWs =
    typeof claimWorkspaceId === "string" && claimWorkspaceId
      ? claimWorkspaceId
      : typeof claimActiveWs === "string" && claimActiveWs
        ? claimActiveWs
        : undefined;
  const bodyWs = typeof bodyWorkspaceId === "string" && bodyWorkspaceId ? bodyWorkspaceId : undefined;
  if (claimWs && bodyWs && claimWs !== bodyWs) return "mismatch";
  return claimWs;
}

/** Read the legacy `activeWs` claim (not modelled by the SDK's claims type). */
function activeWsClaim(claims: unknown): unknown {
  return (claims as { activeWs?: unknown }).activeWs;
}

export function lifecycleRouter(deps: AppDeps): Router {
  const router = Router();

  router.post(
    "/lifecycle/installed",
    asyncHandler(async (req, res) => {
      const claims = await verifyAddonToken(deps.parser, getLifecycleToken(req));
      if (!claims) return res.status(401).json({ ok: false, code: "unauthorized" });

      const body = req.body ?? {};
      // INSTALLED payload (Clockify): { addonId, authToken, workspaceId, asUser,
      // apiUrl, addonUserId, webhooks }. Only the installation token + workspace
      // are essential — capture the rest opportunistically. Requiring optional
      // metadata (e.g. addonUserId) would reject otherwise-valid installs.
      const workspaceId = resolveWorkspaceId(claims.workspaceId, activeWsClaim(claims), body.workspaceId);
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
    }),
  );

  router.post(
    "/lifecycle/status-changed",
    asyncHandler(async (req, res) => {
      const claims = await verifyAddonToken(deps.parser, getLifecycleToken(req));
      if (!claims) return res.status(401).json({ ok: false, code: "unauthorized" });

      const body = req.body ?? {};
      const workspaceId = resolveWorkspaceId(claims.workspaceId, activeWsClaim(claims), body.workspaceId);
      if (workspaceId === "mismatch") {
        return res.status(403).json({ ok: false, code: "workspace_mismatch" });
      }
      if (!workspaceId) return res.status(400).json({ ok: false, code: "invalid_payload" });

      const status = String(body.status ?? "").toUpperCase() === "ACTIVE" ? "active" : "inactive";
      deps.store.setInstallationStatus(workspaceId, status);
      return res.status(200).json({ ok: true });
    }),
  );

  router.post(
    "/lifecycle/deleted",
    asyncHandler(async (req, res) => {
      const claims = await verifyAddonToken(deps.parser, getLifecycleToken(req));
      if (!claims) return res.status(401).json({ ok: false, code: "unauthorized" });

      const body = req.body ?? {};
      const workspaceId = resolveWorkspaceId(claims.workspaceId, activeWsClaim(claims), body.workspaceId);
      if (workspaceId === "mismatch") {
        return res.status(403).json({ ok: false, code: "workspace_mismatch" });
      }
      if (!workspaceId) return res.status(400).json({ ok: false, code: "invalid_payload" });

      // Uninstall = full data erasure (GDPR / data-minimization): every
      // workspace-scoped row is deleted and the installation is tombstoned with the
      // token wiped. The cross-workspace guard above ensures only the token's own
      // workspace can be erased.
      deps.store.eraseWorkspace(workspaceId);
      return res.status(200).json({ ok: true });
    }),
  );

  return router;
}
