/**
 * B6 — the one deployed-`/version` binding shared by the v2 evidence siblings.
 *
 * Every v2 release validation must prove the same two facts about production:
 * the deployment serves the exact tested candidate, and the engine it serves is
 * `v2`. The v1 validators each pin the full historical `/version` payload; the
 * v2 siblings deliberately bind only the identity subset (`releaseSha`,
 * `buildHash`, `serverArtifactSha256`, `modelConfiguration.assistantEngine`)
 * because no v2 model configuration has been released yet — pinning a model
 * setting here would fabricate a contract nothing has evaluated. The payload
 * shape is owned by `src/server.ts` (`GET /version`).
 */

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface DeployedV2ReleaseIdentity {
  releaseSha: string;
  buildHash: string;
  serverArtifactSha256: string;
}

/**
 * Verify a deployed `/version` payload serves the expected candidate on the v2
 * engine. The engine check has its own error so an engine mismatch can never be
 * reported as a release-binding mismatch.
 */
export function verifyDeployedV2Engine(
  value: unknown,
  expectedCandidateSha: string,
): DeployedV2ReleaseIdentity {
  if (!SHA_PATTERN.test(expectedCandidateSha)) {
    throw new Error("expected candidate SHA must be a full lowercase commit SHA");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("deployed version payload is malformed");
  }
  const deployed = value as Record<string, unknown>;
  const configuration = deployed.modelConfiguration;
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    throw new Error("deployed model configuration is malformed");
  }
  if ((configuration as Record<string, unknown>).assistantEngine !== "v2") {
    throw new Error("deployed assistant engine is not v2");
  }
  if (deployed.releaseSha !== expectedCandidateSha) {
    throw new Error("deployed release does not match the tested candidate SHA");
  }
  const { buildHash, serverArtifactSha256 } = deployed;
  if (typeof buildHash !== "string" || !SHA256_PATTERN.test(buildHash)) {
    throw new Error("deployed release build hash is missing or invalid");
  }
  if (typeof serverArtifactSha256 !== "string" || !SHA256_PATTERN.test(serverArtifactSha256)) {
    throw new Error("deployed runtime artifact hash is missing or invalid");
  }
  return { releaseSha: expectedCandidateSha, buildHash, serverArtifactSha256 };
}
