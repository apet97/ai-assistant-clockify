import { Router } from "express";
import type { ArtifactService } from "../services/artifact-service.js";
import { asyncHandler } from "./async-handler.js";
import type { RequireSession } from "./route-ports.js";

/** GET /api/artifacts/:id — transport only: authorize, one scoped service
 * lookup, stream the bytes with download-hardening headers (T16-G). */
export function artifactsRouter(options: {
  requireSession: RequireSession;
  artifacts: ArtifactService;
}): Router {
  const router = Router();
  router.get("/artifacts/:id", asyncHandler(async (req, res) => {
    const claims = await options.requireSession(req, res);
    if (!claims) return;
    const artifact = options.artifacts.getForDownload(claims, req.params.id);
    if (!artifact) {
      return res.status(404).json({ ok: false, code: "not_found", message: "Artifact not found or expired." });
    }
    res.setHeader("Content-Type", artifact.contentType);
    res.setHeader("Content-Length", String(artifact.bytes.byteLength));
    res.setHeader("Content-Disposition", `attachment; filename="${artifact.safeFilename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Checksum-Sha256", artifact.checksum);
    return res.status(200).send(Buffer.from(artifact.bytes));
  }));
  return router;
}
