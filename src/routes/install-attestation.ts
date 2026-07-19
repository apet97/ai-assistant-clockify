import { Router } from "express";
import {
  createInstallationAttestationEnvelope,
  deriveInstallationAttestationKey,
  hashCanonicalAttestationJson,
  verifyInstallationAttestationEnvelope,
  type InstallationAttestationRecord,
} from "../addon/install-attestation.js";
import { buildManifest } from "../addon/manifest.js";
import type { RuntimeReleaseArtifactIdentity } from "../release-artifact.js";
import { asyncHandler } from "./async-handler.js";
import type { AppDeps } from "./deps.js";

const MAX_WORKSPACE_ID_BYTES = 256;
const MAX_ADDON_TOKEN_BYTES = 16_384;

function currentBinding(deps: AppDeps): (RuntimeReleaseArtifactIdentity & { manifestSha256: string }) | undefined {
  const identity = deps.releaseArtifactIdentity;
  if (!identity) return undefined;
  return {
    ...identity,
    manifestSha256: hashCanonicalAttestationJson(buildManifest(deps.config.baseUrl)),
  };
}

function matchesCurrentRelease(
  record: InstallationAttestationRecord,
  current: ReturnType<typeof currentBinding>,
): boolean {
  return Boolean(current)
    && record.releaseSha === current?.releaseSha
    && record.releaseBuildHash === current.releaseBuildHash
    && record.serverArtifactSha256 === current.serverArtifactSha256
    && record.sourceRelationship === current.sourceRelationship
    && record.sourceBindingSha256 === current.sourceBindingSha256
    && record.manifestSha256 === current.manifestSha256;
}

function unavailable(res: import("express").Response) {
  return res.status(404).json({ ok: false, code: "attestation_unavailable" });
}

/** Release-only attestation endpoints. The authenticated GET returns proof only
 * for the exact active installation token/generation. The public POST verifies
 * an already-minted envelope for CI without exposing any workspace or token. */
export function installAttestationRouter(deps: AppDeps): Router {
  const router = Router();
  const key = deriveInstallationAttestationKey(deps.config.sessionSecret);

  router.get(
    "/release/install-attestation/:workspaceId",
    asyncHandler(async (req, res) => {
      res.setHeader("Cache-Control", "private, no-store");
      const workspaceId = req.params.workspaceId ?? "";
      const addonToken = req.get("X-Addon-Token") ?? "";
      if (
        !workspaceId
        || Buffer.byteLength(workspaceId) > MAX_WORKSPACE_ID_BYTES
        || !addonToken
        || Buffer.byteLength(addonToken) > MAX_ADDON_TOKEN_BYTES
      ) return unavailable(res);
      const record = deps.store.getAuthenticatedInstallationAttestation(workspaceId, addonToken);
      const current = currentBinding(deps);
      if (!record || !matchesCurrentRelease(record, current)) return unavailable(res);
      const verificationEnvelope = createInstallationAttestationEnvelope(record, key);
      return res.status(200).json({
        method: "authenticated_server_installation_attestation",
        ...record,
        attestationSha256: hashCanonicalAttestationJson(record),
        verificationEnvelope,
      });
    }),
  );

  router.post(
    "/release/install-attestation/verify",
    asyncHandler(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const verification = verifyInstallationAttestationEnvelope(req.body, key);
      const current = currentBinding(deps);
      if (!verification.valid || !matchesCurrentRelease(verification, current)) {
        return res.status(400).json({ valid: false });
      }
      return res.status(200).json({
        valid: true,
        attestationSha256: verification.attestationSha256,
        releaseSha: verification.releaseSha,
        releaseBuildHash: verification.releaseBuildHash,
        serverArtifactSha256: verification.serverArtifactSha256,
        sourceRelationship: verification.sourceRelationship,
        sourceBindingSha256: verification.sourceBindingSha256,
        manifestSha256: verification.manifestSha256,
      });
    }),
  );

  return router;
}
