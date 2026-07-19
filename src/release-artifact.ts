import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
export const RELEASE_ARTIFACT_MANIFEST_PATH = "dist/release-artifact-manifest.json";
export const RELEASE_SERVER_ARTIFACT_PATH = "dist/server";

export type ReleaseSourceRelationship =
  | "exact_head"
  | "evidence_descendant"
  | "source_bound_builder"
  | "unbound";

export interface ReleaseArtifactManifest {
  schemaVersion: 1;
  kind: "release-artifact-identity";
  sourceCandidateSha: string;
  sourceArchiveSha256: string;
  buildHeadSha: string | null;
  sourceRelationship: ReleaseSourceRelationship;
  serverArtifact: typeof RELEASE_SERVER_ARTIFACT_PATH;
  serverArtifactSha256: string;
  sourceBindingSha256: string | null;
}

export interface RuntimeReleaseArtifactIdentity {
  releaseSha: string;
  releaseBuildHash: string;
  serverArtifactSha256: string;
  sourceBindingSha256: string | null;
  sourceRelationship: Exclude<ReleaseSourceRelationship, "unbound">;
}

export class RuntimeReleaseArtifactError extends Error {
  constructor(readonly code: string) {
    super(`Runtime release artifact verification failed: ${code}`);
    this.name = "RuntimeReleaseArtifactError";
  }
}

export function computeServerArtifactSha256(repositoryRoot: string): string {
  const artifactRoot = resolve(repositoryRoot, RELEASE_SERVER_ARTIFACT_PATH);
  const records: Array<{ path: string; bytes: number; sha256: string }> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) throw new RuntimeReleaseArtifactError("server_artifact_invalid");
      if (info.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!info.isFile()) throw new RuntimeReleaseArtifactError("server_artifact_invalid");
      const bytes = readFileSync(absolute);
      records.push({
        path: relative(artifactRoot, absolute).split(sep).join("/"),
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  };
  try {
    const rootInfo = lstatSync(artifactRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new RuntimeReleaseArtifactError("server_artifact_invalid");
    }
    visit(artifactRoot);
  } catch (error) {
    if (error instanceof RuntimeReleaseArtifactError) throw error;
    throw new RuntimeReleaseArtifactError("server_artifact_invalid");
  }
  records.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (records.length === 0 || !records.some((record) => record.path === "server.js")) {
    throw new RuntimeReleaseArtifactError("server_artifact_invalid");
  }
  return createHash("sha256")
    .update("ai-assistant-dist-server-v1\n")
    .update(JSON.stringify(records))
    .digest("hex");
}

export function readReleaseArtifactManifest(repositoryRoot: string): ReleaseArtifactManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(
      resolve(repositoryRoot, RELEASE_ARTIFACT_MANIFEST_PATH),
      "utf8",
    )) as unknown;
  } catch {
    throw new RuntimeReleaseArtifactError("release_manifest_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RuntimeReleaseArtifactError("release_manifest_invalid");
  }
  const manifest = parsed as Partial<ReleaseArtifactManifest>;
  const relationship = manifest.sourceRelationship;
  const buildHeadIsValid = relationship === "source_bound_builder"
    ? manifest.buildHeadSha === null
    : typeof manifest.buildHeadSha === "string" && SHA_PATTERN.test(manifest.buildHeadSha);
  if (
    manifest.schemaVersion !== 1
    || manifest.kind !== "release-artifact-identity"
    || typeof manifest.sourceCandidateSha !== "string"
    || !SHA_PATTERN.test(manifest.sourceCandidateSha)
    || typeof manifest.sourceArchiveSha256 !== "string"
    || !SHA256_PATTERN.test(manifest.sourceArchiveSha256)
    || !buildHeadIsValid
    || !["exact_head", "evidence_descendant", "source_bound_builder", "unbound"].includes(relationship ?? "")
    || manifest.serverArtifact !== RELEASE_SERVER_ARTIFACT_PATH
    || typeof manifest.serverArtifactSha256 !== "string"
    || !SHA256_PATTERN.test(manifest.serverArtifactSha256)
    || (relationship === "source_bound_builder"
      ? typeof manifest.sourceBindingSha256 !== "string" || !SHA256_PATTERN.test(manifest.sourceBindingSha256)
      : manifest.sourceBindingSha256 !== null)
  ) {
    throw new RuntimeReleaseArtifactError("release_manifest_invalid");
  }
  return manifest as ReleaseArtifactManifest;
}

/** Fail before DB/model initialization when production identity is absent,
 * environment values differ from the build manifest, or built bytes changed. */
export function verifyRuntimeReleaseArtifact(input: {
  repositoryRoot: string;
  nodeEnv: string;
  releaseSha?: string;
  releaseBuildHash?: string;
  sourceBindingSha256?: string;
}): RuntimeReleaseArtifactIdentity | undefined {
  if (input.releaseSha === undefined && input.releaseBuildHash === undefined) {
    if (input.nodeEnv === "production") {
      throw new RuntimeReleaseArtifactError("release_identity_required");
    }
    return undefined;
  }
  if (
    typeof input.releaseSha !== "string"
    || !SHA_PATTERN.test(input.releaseSha)
    || typeof input.releaseBuildHash !== "string"
    || !SHA256_PATTERN.test(input.releaseBuildHash)
  ) {
    throw new RuntimeReleaseArtifactError("release_identity_required");
  }
  const manifest = readReleaseArtifactManifest(resolve(input.repositoryRoot));
  if (
    manifest.sourceCandidateSha !== input.releaseSha
    || manifest.sourceArchiveSha256 !== input.releaseBuildHash
  ) {
    throw new RuntimeReleaseArtifactError("release_identity_mismatch");
  }
  if (manifest.sourceRelationship === "unbound") {
    throw new RuntimeReleaseArtifactError("source_candidate_unbound");
  }
  if (
    manifest.sourceRelationship === "source_bound_builder"
    && (
      typeof input.sourceBindingSha256 !== "string"
      || !SHA256_PATTERN.test(input.sourceBindingSha256)
      || manifest.sourceBindingSha256 !== input.sourceBindingSha256
    )
  ) {
    throw new RuntimeReleaseArtifactError("source_binding_mismatch");
  }
  if (computeServerArtifactSha256(input.repositoryRoot) !== manifest.serverArtifactSha256) {
    throw new RuntimeReleaseArtifactError("server_artifact_mismatch");
  }
  return {
    releaseSha: manifest.sourceCandidateSha,
    releaseBuildHash: manifest.sourceArchiveSha256,
    serverArtifactSha256: manifest.serverArtifactSha256,
    sourceBindingSha256: manifest.sourceBindingSha256,
    sourceRelationship: manifest.sourceRelationship,
  };
}
