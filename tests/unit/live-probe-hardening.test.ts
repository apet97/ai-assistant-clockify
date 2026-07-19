import { describe, expect, it } from "vitest";
import {
  classifyAuthProbe,
  createChatRequestBody,
  createAuthenticatedFreshInstallEvidence,
  extractHttpStatus,
  hashCanonicalJson,
  toSecretFreeProbeResult,
  verifyDeployedReleaseBinding,
} from "../../scripts/lib/live-evidence.js";

describe("live evidence auth classification", () => {
  it.each([200, 201, 204])("accepts the successful HTTP status %s", (status) => {
    expect(classifyAuthProbe(status, [])).toBe("AUTH_OK");
  });

  it("accepts only explicitly expected 4xx routing outcomes", () => {
    expect(classifyAuthProbe(400, [400, 404])).toBe("AUTH_OK");
    expect(classifyAuthProbe(404, [400, 404])).toBe("AUTH_OK");
    expect(classifyAuthProbe(405, [400, 404])).toBe("INCONCLUSIVE");
  });

  it.each([401, 403])("classifies %s as an authentication failure", (status) => {
    expect(classifyAuthProbe(status, [status])).toBe("AUTH_BLOCKED");
  });

  it.each([429, 500, 502, 503, "transport" as const])(
    "never promotes %s to AUTH_OK",
    (status) => {
      expect(classifyAuthProbe(status, [429, 500, 502, 503])).toBe("INCONCLUSIVE");
    },
  );

  it("extracts only the HTTP status from a REST failure", () => {
    expect(extractHttpStatus(new Error("GET /secret/workspaces/ws-sensitive -> 429: token=secret"))).toBe(429);
    expect(extractHttpStatus(new Error("socket closed for workspace ws-sensitive"))).toBe("transport");
  });

  it("emits a result that cannot contain workspace ids, request paths, or raw errors", () => {
    const result = toSecretFreeProbeResult({
      key: "client-read",
      scope: "CLIENT_READ",
      host: "api",
      method: "GET",
      status: 404,
      expected4xx: [404],
      workspaceId: "ws-sensitive",
      path: "/workspaces/ws-sensitive/clients/secret-client",
      error: new Error("token=secret and customer details"),
    });

    expect(result).toEqual({
      key: "client-read",
      scope: "CLIENT_READ",
      host: "api",
      method: "GET",
      status: 404,
      verdict: "AUTH_OK",
    });
    expect(JSON.stringify(result)).not.toMatch(/ws-sensitive|secret-client|token=secret|customer details/);
  });
});

describe("live HTTP chat request contract", () => {
  it("adds a client UUID to every logical chat request", () => {
    const body = createChatRequestBody("show my projects", () => "d577203b-a67d-4ff2-8b2e-e63f237770f3");
    expect(body).toEqual({
      message: "show my projects",
      requestId: "d577203b-a67d-4ff2-8b2e-e63f237770f3",
    });
  });

  it("rejects a non-UUID request id before a smoke request can be sent", () => {
    expect(() => createChatRequestBody("show my projects", () => "not-a-uuid")).toThrow(
      "live_chat_request_id_invalid",
    );
  });
});

describe("fresh-install evidence", () => {
  const now = new Date("2026-07-18T20:00:00.000Z");
  const expected = {
    releaseSha: "a".repeat(40),
    releaseBuildHash: "f".repeat(64),
    serverArtifactSha256: "c".repeat(64),
    sourceRelationship: "source_bound_builder" as const,
    sourceBindingSha256: "d".repeat(64),
    manifestSha256: "b".repeat(64),
  };
  const authenticatedResponse = {
    method: "authenticated_server_installation_attestation" as const,
    workspaceSha256: "1".repeat(64),
    installationGeneration: 1,
    ...expected,
    installedAt: "2026-07-18T19:57:00.000Z",
    attestationSha256: "2".repeat(64),
    verificationEnvelope: {
      schemaVersion: 1,
      algorithm: "HMAC-SHA256",
      payload: { proof: "server-signed" },
      signature: "server-signature",
    },
  };
  const remoteVerification = {
    valid: true,
    attestationSha256: authenticatedResponse.attestationSha256,
    ...expected,
  };

  it("accepts only a recent server-authenticated install bound to the exact deployment", () => {
    const evidence = createAuthenticatedFreshInstallEvidence({
      expected,
      authenticatedResponse,
      remoteVerification,
      now,
    });
    expect(evidence).toMatchObject({
      method: "authenticated_server_installation_attestation",
      ageSeconds: 180,
      releaseSha: expected.releaseSha,
      releaseBuildHash: expected.releaseBuildHash,
      manifestSha256: expected.manifestSha256,
      installationGeneration: 1,
      remoteVerification: "passed",
    });
    expect(evidence.workspaceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.attestationSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.verificationEnvelope).toEqual(authenticatedResponse.verificationEnvelope);
  });

  it("rejects local assertions, stale proof, remote verification failure, or binding drift", () => {
    expect(() => createAuthenticatedFreshInstallEvidence({
      expected,
      authenticatedResponse: { ...authenticatedResponse, method: "immutable_install_event" } as never,
      remoteVerification,
      now,
    })).toThrow(/authenticated_install_attestation_invalid/);
    expect(() => createAuthenticatedFreshInstallEvidence({
      expected,
      authenticatedResponse: { ...authenticatedResponse, installedAt: "2026-07-18T19:00:00.000Z" },
      remoteVerification,
      now,
    })).toThrow(/authenticated_install_attestation_stale/);
    expect(() => createAuthenticatedFreshInstallEvidence({
      expected,
      authenticatedResponse,
      remoteVerification: { ...remoteVerification, valid: false },
      now,
    })).toThrow(/authenticated_install_attestation_verification_failed/);
    expect(() => createAuthenticatedFreshInstallEvidence({
      expected,
      authenticatedResponse: { ...authenticatedResponse, releaseSha: "9".repeat(40) },
      remoteVerification,
      now,
    })).toThrow(/authenticated_install_attestation_binding_mismatch/);
  });

  it("requires the deployed version and manifest to match the exact local release binding", () => {
    const deployedManifest = { baseUrl: "https://assistant.example", scopes: ["PROJECT_READ"] };
    const manifestSha256 = hashCanonicalJson(deployedManifest);
    expect(verifyDeployedReleaseBinding({
      expectedReleaseSha: expected.releaseSha,
      expectedManifestSha256: manifestSha256,
      deployedManifest,
      deployedVersion: { releaseSha: expected.releaseSha },
    })).toEqual({ releaseSha: expected.releaseSha, manifestSha256 });

    expect(() => verifyDeployedReleaseBinding({
      expectedReleaseSha: expected.releaseSha,
      expectedManifestSha256: manifestSha256,
      deployedManifest: { ...deployedManifest, scopes: [] },
      deployedVersion: { releaseSha: expected.releaseSha },
    })).toThrow(/deployed_manifest_mismatch/);
    expect(() => verifyDeployedReleaseBinding({
      expectedReleaseSha: expected.releaseSha,
      expectedManifestSha256: manifestSha256,
      deployedManifest,
      deployedVersion: { releaseSha: "c".repeat(40) },
    })).toThrow(/deployed_release_mismatch/);
  });
});
