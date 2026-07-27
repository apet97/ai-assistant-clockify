import type { SessionClaims } from "../auth/sessions.js";
import type { Store } from "../db/store.js";

/**
 * ArtifactService (T16-E): scoped short-lived artifact retrieval. The store
 * lookup is bound to workspace+admin+session, so a foreign or expired id is
 * indistinguishable from a missing one. The filename is sanitized here so no
 * caller can emit a header-splitting or path-carrying name.
 */
export interface ArtifactServiceDeps {
  store: Pick<Store, "getArtifact">;
}

export interface DownloadableArtifact {
  bytes: Uint8Array;
  contentType: string;
  checksum: string;
  safeFilename: string;
}

export function createArtifactService(deps: ArtifactServiceDeps) {
  function getForDownload(claims: SessionClaims, artifactId: string): DownloadableArtifact | undefined {
    const artifact = deps.store.getArtifact(
      artifactId,
      claims.workspaceId,
      claims.adminUserId,
      claims.sessionId,
    );
    if (!artifact) return undefined;
    return {
      bytes: artifact.bytes,
      contentType: artifact.contentType,
      checksum: artifact.checksum,
      safeFilename: artifact.filename.replace(/[^a-zA-Z0-9._-]/g, "_"),
    };
  }

  return { getForDownload };
}

export type ArtifactService = ReturnType<typeof createArtifactService>;
