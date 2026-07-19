import { randomUUID } from "node:crypto";
import { hashCanonicalAttestationJson } from "../../src/addon/install-attestation.js";

export type ProbeHttpStatus = number | "2xx" | "transport";
export type AuthProbeVerdict = "AUTH_OK" | "AUTH_BLOCKED" | "INCONCLUSIVE";

/**
 * An auth probe proves authentication only with a real success or a specifically
 * anticipated 4xx response from an intentionally invalid request. Rate limits,
 * server failures, unexpected client errors, and transport failures prove
 * nothing and therefore fail closed as inconclusive.
 */
export function classifyAuthProbe(
  status: ProbeHttpStatus,
  expected4xx: readonly number[],
): AuthProbeVerdict {
  if (status === "2xx" || (typeof status === "number" && status >= 200 && status < 300)) {
    return "AUTH_OK";
  }
  if (status === 401 || status === 403) return "AUTH_BLOCKED";
  if (
    typeof status === "number"
    && status >= 400
    && status < 500
    && status !== 429
    && expected4xx.includes(status)
  ) {
    return "AUTH_OK";
  }
  return "INCONCLUSIVE";
}

/** Extract only the numeric status needed for classification; discard detail. */
export function extractHttpStatus(error: unknown): number | "transport" {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/-> (\d{3}):/);
  return match ? Number(match[1]) : "transport";
}

interface InternalProbeResult {
  key: string;
  scope?: string;
  host: string;
  method: string;
  status: ProbeHttpStatus;
  expected4xx: readonly number[];
  /** Accepted so callers can keep request construction local; deliberately dropped. */
  workspaceId?: string;
  /** Deliberately dropped from evidence and console-safe results. */
  path?: string;
  /** Deliberately dropped from evidence and console-safe results. */
  error?: unknown;
}

export interface SecretFreeProbeResult {
  key: string;
  scope?: string;
  host: string;
  method: string;
  status: ProbeHttpStatus;
  verdict: AuthProbeVerdict;
}

/** Produce the only probe shape that may be logged or written as evidence. */
export function toSecretFreeProbeResult(input: InternalProbeResult): SecretFreeProbeResult {
  return {
    key: input.key,
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    host: input.host,
    method: input.method,
    status: input.status,
    verdict: classifyAuthProbe(input.status, input.expected4xx),
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** One UUID per logical chat turn. Serialize once and reuse it for HTTP retries. */
export function createChatRequestBody(
  message: string,
  createRequestId: () => string = randomUUID,
): { message: string; requestId: string } {
  const requestId = createRequestId();
  if (!UUID_PATTERN.test(requestId)) throw new Error("live_chat_request_id_invalid");
  return { message, requestId };
}

export interface FreshInstallExpectedBinding {
  releaseSha: string;
  releaseBuildHash: string;
  serverArtifactSha256: string;
  sourceRelationship: "exact_head" | "evidence_descendant" | "source_bound_builder";
  sourceBindingSha256: string | null;
  manifestSha256: string;
}

export interface AuthenticatedInstallAttestationResponse extends FreshInstallExpectedBinding {
  method: "authenticated_server_installation_attestation";
  workspaceSha256: string;
  installationGeneration: number;
  installedAt: string;
  attestationSha256: string;
  verificationEnvelope: Record<string, unknown>;
}

export interface AuthenticatedFreshInstallEvidence extends AuthenticatedInstallAttestationResponse {
  remoteVerification: "passed";
  ageSeconds: number;
}

const FRESH_INSTALL_MAX_AGE_SECONDS = 15 * 60;

export function hashCanonicalJson(value: unknown): string {
  return hashCanonicalAttestationJson(value);
}

export function verifyDeployedReleaseBinding(input: {
  expectedReleaseSha: string;
  expectedManifestSha256: string;
  deployedManifest: unknown;
  deployedVersion: unknown;
}): { releaseSha: string; manifestSha256: string } {
  if (!/^[0-9a-f]{40}$/.test(input.expectedReleaseSha)) {
    throw new Error("deployed_release_mismatch");
  }
  if (!/^[0-9a-f]{64}$/.test(input.expectedManifestSha256)) {
    throw new Error("deployed_manifest_mismatch");
  }
  const deployedVersion = input.deployedVersion;
  if (
    !deployedVersion
    || typeof deployedVersion !== "object"
    || Array.isArray(deployedVersion)
    || (deployedVersion as Record<string, unknown>).releaseSha !== input.expectedReleaseSha
  ) {
    throw new Error("deployed_release_mismatch");
  }
  let deployedManifestSha256: string;
  try {
    deployedManifestSha256 = hashCanonicalJson(input.deployedManifest);
  } catch {
    throw new Error("deployed_manifest_mismatch");
  }
  if (deployedManifestSha256 !== input.expectedManifestSha256) {
    throw new Error("deployed_manifest_mismatch");
  }
  return {
    releaseSha: input.expectedReleaseSha,
    manifestSha256: deployedManifestSha256,
  };
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function matchesExpectedBinding(value: Record<string, unknown>, expected: FreshInstallExpectedBinding): boolean {
  return value.releaseSha === expected.releaseSha
    && value.releaseBuildHash === expected.releaseBuildHash
    && value.serverArtifactSha256 === expected.serverArtifactSha256
    && value.sourceRelationship === expected.sourceRelationship
    && value.sourceBindingSha256 === expected.sourceBindingSha256
    && value.manifestSha256 === expected.manifestSha256;
}

/** Convert only a server-authenticated, remotely re-verified envelope into
 * checked-in fresh-install evidence. No local install-event/operator JSON is
 * accepted: both objects are fetched from the deployed service by the caller. */
export function createAuthenticatedFreshInstallEvidence(input: {
  expected: FreshInstallExpectedBinding;
  authenticatedResponse: unknown;
  remoteVerification: unknown;
  now?: Date;
}): AuthenticatedFreshInstallEvidence {
  const response = input.authenticatedResponse;
  const remote = input.remoteVerification;
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("authenticated_install_attestation_invalid");
  }
  if (!remote || typeof remote !== "object" || Array.isArray(remote)) {
    throw new Error("authenticated_install_attestation_verification_failed");
  }
  const attestation = response as Record<string, unknown>;
  const verification = remote as Record<string, unknown>;
  if (!exactKeys(attestation, [
    "attestationSha256",
    "installationGeneration",
    "installedAt",
    "manifestSha256",
    "method",
    "releaseBuildHash",
    "releaseSha",
    "serverArtifactSha256",
    "sourceBindingSha256",
    "sourceRelationship",
    "verificationEnvelope",
    "workspaceSha256",
  ])) throw new Error("authenticated_install_attestation_invalid");
  if (
    attestation.method !== "authenticated_server_installation_attestation"
    || typeof attestation.workspaceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(attestation.workspaceSha256)
    || typeof attestation.attestationSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(attestation.attestationSha256)
    || typeof attestation.installationGeneration !== "number"
    || !Number.isSafeInteger(attestation.installationGeneration)
    || attestation.installationGeneration < 1
    || !attestation.verificationEnvelope
    || typeof attestation.verificationEnvelope !== "object"
    || Array.isArray(attestation.verificationEnvelope)
    || typeof attestation.installedAt !== "string"
  ) throw new Error("authenticated_install_attestation_invalid");
  if (!matchesExpectedBinding(attestation, input.expected)) {
    throw new Error("authenticated_install_attestation_binding_mismatch");
  }
  if (!exactKeys(verification, [
    "attestationSha256",
    "manifestSha256",
    "releaseBuildHash",
    "releaseSha",
    "serverArtifactSha256",
    "sourceBindingSha256",
    "sourceRelationship",
    "valid",
  ]) || verification.valid !== true) {
    throw new Error("authenticated_install_attestation_verification_failed");
  }
  if (
    !matchesExpectedBinding(verification, input.expected)
    || verification.attestationSha256 !== attestation.attestationSha256
  ) throw new Error("authenticated_install_attestation_verification_failed");
  const installedAtMs = Date.parse(attestation.installedAt);
  if (
    Number.isNaN(installedAtMs)
    || new Date(installedAtMs).toISOString() !== attestation.installedAt
  ) throw new Error("authenticated_install_attestation_invalid");
  const nowMs = (input.now ?? new Date()).getTime();
  const age = Math.floor((nowMs - installedAtMs) / 1000);
  if (age < -60 || age > FRESH_INSTALL_MAX_AGE_SECONDS) {
    throw new Error("authenticated_install_attestation_stale");
  }
  return {
    ...(attestation as unknown as AuthenticatedInstallAttestationResponse),
    remoteVerification: "passed",
    ageSeconds: Math.max(0, age),
  };
}
