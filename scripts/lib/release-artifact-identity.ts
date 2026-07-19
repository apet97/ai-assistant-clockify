import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { relative, resolve, sep } from "node:path";

import { isPostCandidateEvidencePath } from "../evidence/marketplace-media-binding.js";

const SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MANIFEST_PATH = "dist/release-artifact-manifest.json";
const SERVER_ARTIFACT_PATH = "dist/server";
export const RELEASE_SOURCE_BINDING_PATH = ".release/source-candidate-binding.json";
const MAX_GIT_OUTPUT_BYTES = 128 * 1024 * 1024;

export type SourceCandidateRelationship =
  | "exact_head"
  | "evidence_descendant"
  | "source_bound_builder"
  | "unbound";

interface ReleaseArtifactManifest {
  schemaVersion: 1;
  kind: "release-artifact-identity";
  sourceCandidateSha: string;
  sourceArchiveSha256: string;
  buildHeadSha: string | null;
  sourceRelationship: SourceCandidateRelationship;
  serverArtifact: typeof SERVER_ARTIFACT_PATH;
  serverArtifactSha256: string;
  sourceBindingSha256: string | null;
}

export interface VerifiedReleaseArtifact {
  sourceCandidateSha: string;
  sourceArchiveSha256: string;
  sourceRelationship: Exclude<SourceCandidateRelationship, "unbound" | "source_bound_builder">;
  serverArtifact: typeof SERVER_ARTIFACT_PATH;
  serverArtifactSha256: string;
}

export interface ReleaseSourceBinding {
  schemaVersion: 1;
  kind: "release-source-binding";
  sourceCandidateSha: string;
  sourceArchiveSha256: string;
  gitObjectFormat: "sha1" | "sha256";
  canonicalSourceTreeSha256: string;
  fileCount: number;
}

export class ReleaseArtifactIdentityError extends Error {
  constructor(readonly code: string) {
    super(`Release artifact identity verification failed: ${code}`);
    this.name = "ReleaseArtifactIdentityError";
  }
}

function git(
  repositoryRoot: string,
  args: readonly string[],
  encoding: BufferEncoding | null = "utf8",
): string | Buffer {
  const result = spawnSync("git", [...args], {
    cwd: repositoryRoot,
    encoding,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  if (result.status !== 0 || result.error) {
    throw new ReleaseArtifactIdentityError("source_candidate_unverified");
  }
  return result.stdout;
}

function gitText(repositoryRoot: string, args: readonly string[]): string {
  return (git(repositoryRoot, args, "utf8") as string).trim();
}

function assertHash(value: string, pattern: RegExp, code: string): void {
  if (!pattern.test(value)) throw new ReleaseArtifactIdentityError(code);
}

function sourceRelationship(
  repositoryRoot: string,
  sourceCandidateSha: string,
): { buildHeadSha: string; relationship: SourceCandidateRelationship } {
  const buildHeadSha = gitText(repositoryRoot, ["rev-parse", "HEAD"]);
  const status = gitText(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status !== "") return { buildHeadSha, relationship: "unbound" };
  if (buildHeadSha === sourceCandidateSha) {
    return { buildHeadSha, relationship: "exact_head" };
  }
  const ancestor = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", sourceCandidateSha, buildHeadSha],
    { cwd: repositoryRoot, stdio: "ignore" },
  );
  if (ancestor.status !== 0 || ancestor.error) {
    return { buildHeadSha, relationship: "unbound" };
  }
  const changed = gitText(repositoryRoot, [
    "diff",
    "--name-only",
    `${sourceCandidateSha}..${buildHeadSha}`,
  ]).split("\n").filter(Boolean);
  return {
    buildHeadSha,
    relationship: changed.every(isPostCandidateEvidencePath)
      ? "evidence_descendant"
      : "unbound",
  };
}

function archiveSha256(repositoryRoot: string, sourceCandidateSha: string): string {
  const resolvedCommit = gitText(repositoryRoot, [
    "rev-parse",
    "--verify",
    `${sourceCandidateSha}^{commit}`,
  ]);
  if (resolvedCommit !== sourceCandidateSha) {
    throw new ReleaseArtifactIdentityError("source_candidate_unverified");
  }
  const archive = git(
    repositoryRoot,
    ["archive", "--format=tar", sourceCandidateSha],
    null,
  ) as Buffer;
  return createHash("sha256").update(archive).digest("hex");
}

interface SourceTreeRecord {
  path: string;
  mode: "100644" | "100755" | "120000";
  bytes: number;
  gitBlobId: string;
}

function canonicalTree(records: SourceTreeRecord[]): { digest: string; fileCount: number } {
  records.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return {
    digest: createHash("sha256")
      .update("ai-assistant-release-source-tree-v1\n")
      .update(JSON.stringify(records))
      .digest("hex"),
    fileCount: records.length,
  };
}

function gitSourceTree(
  repositoryRoot: string,
  sourceCandidateSha: string,
): { digest: string; fileCount: number; objectFormat: "sha1" | "sha256" } {
  const rawFormat = gitText(repositoryRoot, ["rev-parse", "--show-object-format"]);
  if (rawFormat !== "sha1" && rawFormat !== "sha256") {
    throw new ReleaseArtifactIdentityError("source_candidate_unverified");
  }
  const raw = git(repositoryRoot, [
    "ls-tree",
    "-r",
    "-z",
    "-l",
    "--full-tree",
    sourceCandidateSha,
  ], null) as Buffer;
  const records: SourceTreeRecord[] = [];
  for (const entry of raw.toString("utf8").split("\0").filter(Boolean)) {
    const match = /^(100644|100755|120000) blob ([a-f0-9]+)\s+(\d+)\t(.+)$/u.exec(entry);
    if (!match) throw new ReleaseArtifactIdentityError("source_candidate_unverified");
    const [, mode, gitBlobId, rawBytes, path] = match;
    if (
      path === undefined
      || path.startsWith("/")
      || path.split("/").includes("..")
      || rawBytes === undefined
      || !Number.isSafeInteger(Number(rawBytes))
    ) {
      throw new ReleaseArtifactIdentityError("source_candidate_unverified");
    }
    records.push({
      path,
      mode: mode as SourceTreeRecord["mode"],
      bytes: Number(rawBytes),
      gitBlobId: gitBlobId ?? "",
    });
  }
  const tree = canonicalTree(records);
  return { ...tree, objectFormat: rawFormat };
}

function gitBlobId(bytes: Buffer, objectFormat: "sha1" | "sha256"): string {
  return createHash(objectFormat)
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}

function filesystemSourceTree(
  sourceRoot: string,
  objectFormat: "sha1" | "sha256",
): { digest: string; fileCount: number } {
  const root = resolve(sourceRoot);
  const records: SourceTreeRecord[] = [];
  const excluded = (path: string): boolean => (
    path === ".git" || path.startsWith(".git/")
    || path === "node_modules" || path.startsWith("node_modules/")
    || path === "dist" || path.startsWith("dist/")
    || path === RELEASE_SOURCE_BINDING_PATH
  );
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      if (excluded(path)) continue;
      const info = lstatSync(absolute);
      if (info.isDirectory()) {
        visit(absolute);
        continue;
      }
      let bytes: Buffer;
      let mode: SourceTreeRecord["mode"];
      if (info.isSymbolicLink()) {
        bytes = Buffer.from(readlinkSync(absolute));
        mode = "120000";
      } else if (info.isFile()) {
        bytes = readFileSync(absolute);
        mode = (info.mode & 0o111) === 0 ? "100644" : "100755";
      } else {
        throw new ReleaseArtifactIdentityError("source_tree_mismatch");
      }
      records.push({
        path,
        mode,
        bytes: bytes.byteLength,
        gitBlobId: gitBlobId(bytes, objectFormat),
      });
    }
  };
  try {
    visit(root);
  } catch (error) {
    if (error instanceof ReleaseArtifactIdentityError) throw error;
    throw new ReleaseArtifactIdentityError("source_tree_mismatch");
  }
  return canonicalTree(records);
}

function sourceBindingBytes(binding: ReleaseSourceBinding): Buffer {
  return Buffer.from(`${JSON.stringify(binding, null, 2)}\n`);
}

export function writeReleaseSourceBindingFromGit(input: {
  repositoryRoot: string;
  sourceRoot: string;
  sourceCandidateSha: string;
  releaseBuildHash: string;
}): { binding: ReleaseSourceBinding; sha256: string } {
  assertHash(input.sourceCandidateSha, SHA_PATTERN, "release_identity_required");
  assertHash(input.releaseBuildHash, SHA256_PATTERN, "release_identity_required");
  const repositoryRoot = resolve(input.repositoryRoot);
  const actualArchive = archiveSha256(repositoryRoot, input.sourceCandidateSha);
  if (actualArchive !== input.releaseBuildHash) {
    throw new ReleaseArtifactIdentityError("source_archive_mismatch");
  }
  const tree = gitSourceTree(repositoryRoot, input.sourceCandidateSha);
  const binding: ReleaseSourceBinding = {
    schemaVersion: 1,
    kind: "release-source-binding",
    sourceCandidateSha: input.sourceCandidateSha,
    sourceArchiveSha256: input.releaseBuildHash,
    gitObjectFormat: tree.objectFormat,
    canonicalSourceTreeSha256: tree.digest,
    fileCount: tree.fileCount,
  };
  const bytes = sourceBindingBytes(binding);
  const output = resolve(input.sourceRoot, RELEASE_SOURCE_BINDING_PATH);
  mkdirSync(resolve(input.sourceRoot, ".release"), { recursive: true });
  writeFileSync(output, bytes, { mode: 0o644 });
  return { binding, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function verifyReleaseSourceBinding(input: {
  sourceRoot: string;
  releaseSha: string;
  releaseBuildHash: string;
  sourceBindingSha256: string;
}): { binding: ReleaseSourceBinding; sha256: string } {
  assertHash(input.releaseSha, SHA_PATTERN, "release_identity_required");
  assertHash(input.releaseBuildHash, SHA256_PATTERN, "release_identity_required");
  assertHash(input.sourceBindingSha256, SHA256_PATTERN, "source_binding_required");
  let bytes: Buffer;
  let binding: ReleaseSourceBinding;
  try {
    bytes = readFileSync(resolve(input.sourceRoot, RELEASE_SOURCE_BINDING_PATH));
    binding = JSON.parse(bytes.toString("utf8")) as ReleaseSourceBinding;
  } catch {
    throw new ReleaseArtifactIdentityError("source_binding_invalid");
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== input.sourceBindingSha256) {
    throw new ReleaseArtifactIdentityError("source_binding_mismatch");
  }
  if (
    binding.schemaVersion !== 1
    || binding.kind !== "release-source-binding"
    || binding.sourceCandidateSha !== input.releaseSha
    || binding.sourceArchiveSha256 !== input.releaseBuildHash
    || (binding.gitObjectFormat !== "sha1" && binding.gitObjectFormat !== "sha256")
    || !SHA256_PATTERN.test(binding.canonicalSourceTreeSha256)
    || !Number.isSafeInteger(binding.fileCount)
    || binding.fileCount <= 0
  ) {
    throw new ReleaseArtifactIdentityError("source_binding_invalid");
  }
  const actual = filesystemSourceTree(input.sourceRoot, binding.gitObjectFormat);
  if (
    actual.digest !== binding.canonicalSourceTreeSha256
    || actual.fileCount !== binding.fileCount
  ) {
    throw new ReleaseArtifactIdentityError("source_tree_mismatch");
  }
  return { binding, sha256: digest };
}

function serverArtifactSha256(repositoryRoot: string): string {
  const artifactRoot = resolve(repositoryRoot, SERVER_ARTIFACT_PATH);
  const records: Array<{ path: string; bytes: number; sha256: string }> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) {
        throw new ReleaseArtifactIdentityError("server_artifact_invalid");
      }
      if (info.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!info.isFile()) {
        throw new ReleaseArtifactIdentityError("server_artifact_invalid");
      }
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
      throw new ReleaseArtifactIdentityError("server_artifact_invalid");
    }
    visit(artifactRoot);
  } catch (error) {
    if (error instanceof ReleaseArtifactIdentityError) throw error;
    throw new ReleaseArtifactIdentityError("server_artifact_invalid");
  }
  records.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (records.length === 0 || !records.some((record) => record.path === "server.js")) {
    throw new ReleaseArtifactIdentityError("server_artifact_invalid");
  }
  return createHash("sha256")
    .update("ai-assistant-dist-server-v1\n")
    .update(JSON.stringify(records))
    .digest("hex");
}

function parseManifest(repositoryRoot: string): ReleaseArtifactManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(repositoryRoot, MANIFEST_PATH), "utf8")) as unknown;
  } catch {
    throw new ReleaseArtifactIdentityError("release_manifest_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ReleaseArtifactIdentityError("release_manifest_invalid");
  }
  const manifest = parsed as Partial<ReleaseArtifactManifest>;
  if (
    manifest.schemaVersion !== 1
    || manifest.kind !== "release-artifact-identity"
    || typeof manifest.sourceCandidateSha !== "string"
    || !SHA_PATTERN.test(manifest.sourceCandidateSha)
    || typeof manifest.sourceArchiveSha256 !== "string"
    || !SHA256_PATTERN.test(manifest.sourceArchiveSha256)
    || (manifest.sourceRelationship === "source_bound_builder"
      ? manifest.buildHeadSha !== null
      : typeof manifest.buildHeadSha !== "string" || !SHA_PATTERN.test(manifest.buildHeadSha))
    || !["exact_head", "evidence_descendant", "source_bound_builder", "unbound"].includes(manifest.sourceRelationship ?? "")
    || manifest.serverArtifact !== SERVER_ARTIFACT_PATH
    || typeof manifest.serverArtifactSha256 !== "string"
    || !SHA256_PATTERN.test(manifest.serverArtifactSha256)
    || (manifest.sourceRelationship === "source_bound_builder"
      ? typeof manifest.sourceBindingSha256 !== "string" || !SHA256_PATTERN.test(manifest.sourceBindingSha256)
      : manifest.sourceBindingSha256 !== null)
  ) {
    throw new ReleaseArtifactIdentityError("release_manifest_invalid");
  }
  return manifest as ReleaseArtifactManifest;
}

/**
 * Write a deterministic post-build manifest. A dirty checkout is deliberately
 * recorded as `unbound`: ordinary development builds continue to work, but the
 * artifact can never become restore/deployment evidence. `RELEASE_SHA` may name
 * an earlier source candidate only when the clean checked-out descendant changes
 * exclusively immutable evidence paths.
 */
export function writeReleaseArtifactManifest(input: {
  repositoryRoot: string;
  sourceCandidateSha?: string;
}): ReleaseArtifactManifest {
  const repositoryRoot = resolve(input.repositoryRoot);
  const sourceCandidateSha = input.sourceCandidateSha
    ?? gitText(repositoryRoot, ["rev-parse", "HEAD"]);
  assertHash(sourceCandidateSha, SHA_PATTERN, "release_identity_required");
  const sourceArchiveSha256 = archiveSha256(repositoryRoot, sourceCandidateSha);
  const source = sourceRelationship(repositoryRoot, sourceCandidateSha);
  const manifest: ReleaseArtifactManifest = {
    schemaVersion: 1,
    kind: "release-artifact-identity",
    sourceCandidateSha,
    sourceArchiveSha256,
    buildHeadSha: source.buildHeadSha,
    sourceRelationship: source.relationship,
    serverArtifact: SERVER_ARTIFACT_PATH,
    serverArtifactSha256: serverArtifactSha256(repositoryRoot),
    sourceBindingSha256: null,
  };
  const output = resolve(repositoryRoot, MANIFEST_PATH);
  mkdirSync(resolve(repositoryRoot, "dist"), { recursive: true });
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  return manifest;
}

/** Git-less deployment builders cannot independently inspect the uploaded
 * archive, but they still bind the supplied release identity to the exact bytes
 * they produced. Production startup rechecks this manifest and byte hash; the
 * stronger restore verifier deliberately refuses this relationship. */
export function writeSourceBoundBuilderReleaseArtifactManifest(input: {
  repositoryRoot: string;
  releaseSha: string;
  releaseBuildHash: string;
  sourceBindingSha256: string;
}): ReleaseArtifactManifest {
  assertHash(input.releaseSha, SHA_PATTERN, "release_identity_required");
  assertHash(input.releaseBuildHash, SHA256_PATTERN, "release_identity_required");
  const verifiedBinding = verifyReleaseSourceBinding({
    sourceRoot: input.repositoryRoot,
    releaseSha: input.releaseSha,
    releaseBuildHash: input.releaseBuildHash,
    sourceBindingSha256: input.sourceBindingSha256,
  });
  const repositoryRoot = resolve(input.repositoryRoot);
  const manifest: ReleaseArtifactManifest = {
    schemaVersion: 1,
    kind: "release-artifact-identity",
    sourceCandidateSha: input.releaseSha,
    sourceArchiveSha256: input.releaseBuildHash,
    buildHeadSha: null,
    sourceRelationship: "source_bound_builder",
    serverArtifact: SERVER_ARTIFACT_PATH,
    serverArtifactSha256: serverArtifactSha256(repositoryRoot),
    sourceBindingSha256: verifiedBinding.sha256,
  };
  const output = resolve(repositoryRoot, MANIFEST_PATH);
  mkdirSync(resolve(repositoryRoot, "dist"), { recursive: true });
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  return manifest;
}

/**
 * Independently re-check the manifest against Git and the bytes that will be
 * spawned. Supplying two well-formed environment strings is therefore
 * insufficient: they must identify a real source candidate, its exact archive,
 * a permitted clean checkout, and this exact complete `dist/server` tree.
 */
export function verifyBuiltReleaseArtifact(input: {
  repositoryRoot: string;
  releaseSha: string;
  releaseBuildHash: string;
}): VerifiedReleaseArtifact {
  assertHash(input.releaseSha, SHA_PATTERN, "release_identity_required");
  assertHash(input.releaseBuildHash, SHA256_PATTERN, "release_identity_required");
  const repositoryRoot = resolve(input.repositoryRoot);
  const manifest = parseManifest(repositoryRoot);
  if (
    manifest.sourceCandidateSha !== input.releaseSha
    || manifest.sourceArchiveSha256 !== input.releaseBuildHash
  ) {
    throw new ReleaseArtifactIdentityError("release_identity_mismatch");
  }
  if (
    manifest.sourceRelationship === "unbound"
    || manifest.sourceRelationship === "source_bound_builder"
  ) {
    throw new ReleaseArtifactIdentityError("source_candidate_unbound");
  }
  const actualArchiveSha256 = archiveSha256(repositoryRoot, input.releaseSha);
  if (actualArchiveSha256 !== input.releaseBuildHash) {
    throw new ReleaseArtifactIdentityError("source_archive_mismatch");
  }
  const actualSource = sourceRelationship(repositoryRoot, input.releaseSha);
  if (
    actualSource.relationship === "unbound"
    || actualSource.relationship !== manifest.sourceRelationship
    || actualSource.buildHeadSha !== manifest.buildHeadSha
  ) {
    throw new ReleaseArtifactIdentityError("source_candidate_unbound");
  }
  const actualServerArtifactSha256 = serverArtifactSha256(repositoryRoot);
  if (actualServerArtifactSha256 !== manifest.serverArtifactSha256) {
    throw new ReleaseArtifactIdentityError("server_artifact_mismatch");
  }
  return {
    sourceCandidateSha: manifest.sourceCandidateSha,
    sourceArchiveSha256: manifest.sourceArchiveSha256,
    sourceRelationship: manifest.sourceRelationship,
    serverArtifact: manifest.serverArtifact,
    serverArtifactSha256: manifest.serverArtifactSha256,
  };
}
