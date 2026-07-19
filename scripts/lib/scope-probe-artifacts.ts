import { randomUUID } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PATH_ENVIRONMENT = {
  scopeEvidence: "SCOPE_PROBE_EVIDENCE_PATH",
  deployedManifest: "DEPLOYED_MANIFEST_EVIDENCE_PATH",
  attestationVerification: "ATTESTATION_VERIFICATION_EVIDENCE_PATH",
} as const;

export interface ScopeProbeArtifactPaths {
  scopeEvidence: string;
  deployedManifest: string;
  attestationVerification: string;
}

export interface ScopeProbeArtifacts {
  scopeEvidence: unknown;
  deployedManifest: unknown;
  remoteVerification: unknown;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function existingPath(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function externalOutputPath(raw: string | undefined, name: string, checkoutRoot: string): string {
  const value = raw?.trim();
  if (!value) throw new Error(`${name} is required`);
  if (!isAbsolute(value)) throw new Error(`${name} must be absolute`);
  const absolute = resolve(value);
  if (absolute !== value) throw new Error(`${name} must be normalized`);
  if (existingPath(absolute)) throw new Error(`${name} must not already exist`);
  const parent = dirname(absolute);
  const parentInfo = lstatSync(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new Error(`${name} parent must be a real directory`);
  }
  const parentStatus = statSync(parent);
  if ((parentStatus.mode & 0o777) !== 0o700) {
    throw new Error(`${name} parent must have mode 0700`);
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && parentStatus.uid !== currentUid) {
    throw new Error(`${name} parent must be owned by the current user`);
  }
  const checkout = realpathSync(checkoutRoot);
  const realParent = realpathSync(parent);
  const relationship = relative(checkout, realParent);
  if (relationship === "" || (!relationship.startsWith("..") && !isAbsolute(relationship))) {
    throw new Error(`${name} must be outside the checkout`);
  }
  const canonicalTarget = join(realParent, basename(absolute));
  if (existingPath(canonicalTarget)) throw new Error(`${name} must not already exist`);
  return canonicalTarget;
}

export function requireScopeProbeArtifactPaths(
  environment: Record<string, string | undefined>,
  checkoutRoot: string,
): ScopeProbeArtifactPaths {
  const paths = Object.fromEntries(Object.entries(PATH_ENVIRONMENT).map(([key, name]) => [
    key,
    externalOutputPath(environment[name], name, checkoutRoot),
  ])) as unknown as ScopeProbeArtifactPaths;
  if (new Set(Object.values(paths)).size !== Object.keys(paths).length) {
    throw new Error("scope probe artifact paths must be distinct");
  }
  return paths;
}

function containsForbiddenStandaloneKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenStandaloneKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as JsonObject).some(([key, nested]) =>
    /token|verificationEnvelope/iu.test(key) || containsForbiddenStandaloneKey(nested));
}

function validatedArtifacts(input: ScopeProbeArtifacts): Array<{ pathKey: keyof ScopeProbeArtifactPaths; value: unknown }> {
  const scope = object(input.scopeEvidence, "scope evidence");
  if (scope.schemaVersion !== 2 || scope.conclusion !== "passed" || scope.tokenIncluded !== false) {
    throw new Error("scope evidence must be a passed secret-free schema-2 result");
  }
  const manifest = object(input.deployedManifest, "deployed manifest");
  if (containsForbiddenStandaloneKey(manifest)) {
    throw new Error("deployed manifest contains a forbidden token or verification envelope");
  }
  const verification = object(input.remoteVerification, "remote verification");
  const exactKeys = [
    "attestationSha256",
    "manifestSha256",
    "releaseBuildHash",
    "releaseSha",
    "serverArtifactSha256",
    "sourceBindingSha256",
    "sourceRelationship",
    "valid",
  ].sort();
  const actualKeys = Object.keys(verification).sort();
  if (
    actualKeys.length !== exactKeys.length
    || actualKeys.some((key, index) => key !== exactKeys[index])
    || verification.valid !== true
    || typeof verification.releaseSha !== "string" || !SHA_PATTERN.test(verification.releaseSha)
    || typeof verification.releaseBuildHash !== "string" || !SHA256_PATTERN.test(verification.releaseBuildHash)
    || typeof verification.serverArtifactSha256 !== "string" || !SHA256_PATTERN.test(verification.serverArtifactSha256)
    || typeof verification.manifestSha256 !== "string" || !SHA256_PATTERN.test(verification.manifestSha256)
    || typeof verification.attestationSha256 !== "string" || !SHA256_PATTERN.test(verification.attestationSha256)
    || !["exact_head", "evidence_descendant", "source_bound_builder"].includes(String(verification.sourceRelationship))
    || (verification.sourceRelationship === "source_bound_builder"
      ? typeof verification.sourceBindingSha256 !== "string" || !SHA256_PATTERN.test(verification.sourceBindingSha256)
      : verification.sourceBindingSha256 !== null)
    || containsForbiddenStandaloneKey(verification)
  ) throw new Error("remote verification artifact is invalid or unsafe");
  return [
    { pathKey: "scopeEvidence", value: scope },
    { pathKey: "deployedManifest", value: manifest },
    { pathKey: "attestationVerification", value: verification },
  ];
}

export function writeScopeProbeArtifacts(paths: ScopeProbeArtifactPaths, input: ScopeProbeArtifacts): void {
  const artifacts = validatedArtifacts(input);
  const staged: Array<{ target: string; temporary: string }> = [];
  const committed: string[] = [];
  try {
    for (const artifact of artifacts) {
      const target = paths[artifact.pathKey];
      if (existingPath(target)) throw new Error("scope probe artifact target already exists");
      const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
      writeFileSync(temporary, `${JSON.stringify(artifact.value, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      chmodSync(temporary, 0o600);
      JSON.parse(readFileSync(temporary, "utf8"));
      staged.push({ target, temporary });
    }
    for (const { target, temporary } of staged) {
      linkSync(temporary, target);
      committed.push(target);
      unlinkSync(temporary);
      chmodSync(target, 0o600);
    }
  } catch (error) {
    for (const target of committed) rmSync(target, { force: true });
    throw error;
  } finally {
    for (const { temporary } of staged) rmSync(temporary, { force: true });
  }
}
