import { Router, type Request } from "express";
import {
  ClockifyHeaders,
  verifyAddonToken,
  type ClockifyAddonClaims,
} from "../addon/verify.js";
import { asyncHandler } from "./async-handler.js";
import type { AppDeps } from "./deps.js";
import { canonicalClockifyServiceUrl } from "../clockify/service-url.js";
import { createWorkspaceMutationCoordinator } from "../clockify/workspace-mutation-coordinator.js";
import { buildManifest } from "../addon/manifest.js";
import { hashCanonicalAttestationJson } from "../addon/install-attestation.js";
import { nowDate } from "../durations.js";
import {
  LIFECYCLE_CLOCK_SKEW_SECONDS,
  MAX_LIFECYCLE_AGE_SECONDS,
} from "../addon/lifecycle-authority.js";
import { logAlias } from "../log-alias.js";

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

type OrderedLifecycleClaims = ClockifyAddonClaims & { iat: number; exp: number };

async function verifyOrderedLifecycleToken(
  deps: Pick<AppDeps, "parser" | "now">,
  token: string | undefined,
): Promise<OrderedLifecycleClaims | undefined> {
  const claims = await verifyAddonToken(deps.parser, token);
  if (!claims) return undefined;
  const { iat, exp } = claims;
  const nowSeconds = Math.floor(nowDate(deps).getTime() / 1000);
  if (
    typeof iat !== "number" || !Number.isSafeInteger(iat) || iat < 0
    || typeof exp !== "number" || !Number.isSafeInteger(exp) || exp < iat
    || iat > nowSeconds + LIFECYCLE_CLOCK_SKEW_SECONDS
    || nowSeconds - iat > MAX_LIFECYCLE_AGE_SECONDS + LIFECYCLE_CLOCK_SKEW_SECONDS
  ) return undefined;
  return claims as OrderedLifecycleClaims;
}

export function lifecycleRouter(deps: AppDeps): Router {
  const router = Router();
  const mutationCoordinator = deps.mutationCoordinator ?? createWorkspaceMutationCoordinator();
  // F14: lifecycle log lines carry stable HMAC ALIASES, generation, state, and
  // bounded counts — never a raw workspace/admin/add-on id (customer-linked
  // identifiers must not reach the hosting platform's log plane).
  const wsAlias = (workspaceId: string): string =>
    logAlias(deps.config.sessionSecret, "workspace", workspaceId);
  const addonAlias = (addonId: string): string =>
    logAlias(deps.config.sessionSecret, "addon", addonId);
  let lifecycleRequestSequence = 0;
  const nextLifecycleRequestSequence = (): number => {
    lifecycleRequestSequence += 1;
    if (!Number.isSafeInteger(lifecycleRequestSequence)) {
      throw new Error("lifecycle_request_sequence_exhausted");
    }
    return lifecycleRequestSequence;
  };

  router.post(
    "/lifecycle/installed",
    asyncHandler(async (req, res) => {
      // Capture arrival order before asynchronous signature verification. A
      // slower old callback must not overtake and erase/disable a newer install.
      const requestSequence = nextLifecycleRequestSequence();
      const claims = await verifyOrderedLifecycleToken(deps, getLifecycleToken(req));
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

      let bodyApiUrl: string | undefined;
      let claimApiUrl: string | undefined;
      try {
        bodyApiUrl = typeof body.apiUrl === "string"
          ? canonicalClockifyServiceUrl(body.apiUrl, "api")
          : undefined;
        claimApiUrl = typeof claims.backendUrl === "string"
          ? canonicalClockifyServiceUrl(claims.backendUrl, "api")
          : undefined;
      } catch {
        return res.status(400).json({ ok: false, code: "invalid_service_origin" });
      }
      if (bodyApiUrl && claimApiUrl && bodyApiUrl !== claimApiUrl) {
        return res.status(403).json({ ok: false, code: "service_origin_mismatch" });
      }

      return mutationCoordinator.runLifecycle(workspaceId, async () => {
        // A fresh install that arrives while an uninstall is settling waits until
        // the old generation's dispatched writes and durable erasure are complete.
        // Lifecycle serialization makes the wait + save one ordered state change;
        // a concurrent delete cannot observe no row and later erase this token.
        const pendingDeletion = mutationCoordinator.waitForDeletion(workspaceId);
        if (pendingDeletion) await pendingDeletion;
        const saveResult = deps.store.saveInstallation({
          workspaceId,
          addonId: body.addonId ?? claims.addonId ?? "",
          addonUserId: body.addonUserId ?? "",
          addonToken,
          apiUrl: bodyApiUrl,
          backendUrl: claimApiUrl,
          status: "active",
          lifecycleIssuedAt: claims.iat,
          installedByUserId: body.asUser,
          ...(deps.releaseArtifactIdentity
            ? {
                freshInstallAttestation: {
                  releaseSha: deps.releaseArtifactIdentity.releaseSha,
                  releaseBuildHash: deps.releaseArtifactIdentity.releaseBuildHash,
                  serverArtifactSha256: deps.releaseArtifactIdentity.serverArtifactSha256,
                  sourceRelationship: deps.releaseArtifactIdentity.sourceRelationship,
                  sourceBindingSha256: deps.releaseArtifactIdentity.sourceBindingSha256,
                  manifestSha256: hashCanonicalAttestationJson(buildManifest(deps.config.baseUrl)),
                },
              }
            : {}),
        });
        if (saveResult.outcome === "stale_lifecycle" || saveResult.outcome === "retired_token_replay") {
          console.log(`[lifecycle] event=installed_ignored_${saveResult.outcome} workspace=${wsAlias(workspaceId)} generation=${saveResult.generation ?? "none"}`);
          return res.status(200).json({ ok: true });
        }
        const installed = deps.store.getInstallation(workspaceId);
        // A retired-token replay is an intentional store no-op. If the current
        // row is inactive, never let that old callback reactivate the process-
        // local coordinator epoch; persisted state and the barrier must agree.
        if (installed?.status === "active") {
          mutationCoordinator.activate(workspaceId, installed.generation);
        }
        // Operational trace (searchable, NEVER the token or a raw id): install
        // churn + correlation via stable aliases, generation, and state.
        console.log(`[lifecycle] event=installed workspace=${wsAlias(workspaceId)} addon=${addonAlias(String(body.addonId ?? claims.addonId ?? ""))} generation=${installed?.generation ?? "none"} status=${installed?.status ?? "none"}`);
        return res.status(200).json({ ok: true });
      }, {
        sequence: requestSequence,
        stale: () => {
          console.log(`[lifecycle] event=installed_ignored_stale workspace=${wsAlias(workspaceId)}`);
          return res.status(200).json({ ok: true });
        },
      });
    }),
  );

  router.post(
    "/lifecycle/status-changed",
    asyncHandler(async (req, res) => {
      const requestSequence = nextLifecycleRequestSequence();
      const claims = await verifyOrderedLifecycleToken(deps, getLifecycleToken(req));
      if (!claims) return res.status(401).json({ ok: false, code: "unauthorized" });

      const body = req.body ?? {};
      const workspaceId = resolveWorkspaceId(claims.workspaceId, activeWsClaim(claims), body.workspaceId);
      if (workspaceId === "mismatch") {
        return res.status(403).json({ ok: false, code: "workspace_mismatch" });
      }
      if (!workspaceId) return res.status(400).json({ ok: false, code: "invalid_payload" });

      const status = String(body.status ?? "").toUpperCase() === "ACTIVE" ? "active" : "inactive";
      return mutationCoordinator.runLifecycle(workspaceId, async () => {
        // Status callbacks carry no replacement installation token. Serialize
        // them behind deletion so they cannot resurrect or race a tokenless
        // tombstone; setInstallationStatus also rejects deleted -> active.
        const pendingDeletion = mutationCoordinator.waitForDeletion(workspaceId);
        if (pendingDeletion) await pendingDeletion;
        const statusResult = deps.store.setInstallationStatus(workspaceId, status, claims.iat);
        if (statusResult.outcome !== "applied") {
          console.log(`[lifecycle] event=status_changed_ignored_${statusResult.outcome} workspace=${wsAlias(workspaceId)} generation=${statusResult.generation ?? "none"}`);
          return res.status(200).json({ ok: true });
        }
        if (status === "inactive") mutationCoordinator.block(workspaceId);
        if (status === "active") {
          const installation = deps.store.getInstallation(workspaceId);
          if (installation?.status === "active") {
            mutationCoordinator.activate(workspaceId, installation.generation);
          }
        }
        console.log(`[lifecycle] event=status_changed workspace=${wsAlias(workspaceId)} status=${status} generation=${statusResult.generation ?? "none"}`);
        return res.status(200).json({ ok: true });
      }, {
        sequence: requestSequence,
        stale: () => {
          console.log(`[lifecycle] event=status_changed_ignored_stale workspace=${wsAlias(workspaceId)}`);
          return res.status(200).json({ ok: true });
        },
      });
    }),
  );

  router.post(
    "/lifecycle/deleted",
    asyncHandler(async (req, res) => {
      const requestSequence = nextLifecycleRequestSequence();
      const claims = await verifyOrderedLifecycleToken(deps, getLifecycleToken(req));
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
      // workspace can be erased, including the installation metadata itself.
      // Durable forensic trace: the audit rows are themselves erased, so the erase
      // COUNTS go to the log drain (which survives) — never the token or any content.
      // Revocation is synchronous: queued/not-yet-dispatched mutations observe
      // the aborted lifecycle signal immediately. Persist the tokenless tombstone
      // before awaiting actions that may already be settling a host response.
      return mutationCoordinator.runLifecycle(workspaceId, async () => {
        const tombstone = deps.store.tombstoneInstallationForLifecycle(workspaceId, claims.iat);
        if (!tombstone.accepted) {
          console.log(`[lifecycle] event=deleted_ignored_stale_lifecycle workspace=${wsAlias(workspaceId)}`);
          return res.status(200).json({ ok: true });
        }
        const deletion = mutationCoordinator.beginDeletion(workspaceId);
        if (!deletion.owner) {
          await deletion.completed;
          return res.status(200).json({ ok: true });
        }
        try {
          await deletion.drained;
          // Bind the destructive erase to the exact tokenless generation. A
          // newer installation can never be deleted by an older lifecycle event.
          const erased = tombstone.generation !== undefined
            ? deps.store.eraseWorkspaceForDeletion(workspaceId, tombstone.generation)
            : deps.store.eraseWorkspace(workspaceId);
          console.log(`[lifecycle] event=deleted workspace=${wsAlias(workspaceId)} generation=${tombstone.generation ?? "none"} erased=${JSON.stringify(erased ?? {})}`);
          return res.status(200).json({ ok: true });
        } finally {
          deletion.finish();
        }
      }, {
        sequence: requestSequence,
        stale: () => {
          console.log(`[lifecycle] event=deleted_ignored_stale workspace=${wsAlias(workspaceId)}`);
          return res.status(200).json({ ok: true });
        },
      });
    }),
  );

  return router;
}
