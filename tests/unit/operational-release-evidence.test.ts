import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  validateOperationalReleaseEvidence,
  type OperationalReleaseEvidenceInput,
} from "../../scripts/evidence/operational-release-evidence.js";
import { hashCanonicalJson } from "../../scripts/lib/live-evidence.js";
import { CLOCKIFY_SCOPE_ENFORCEMENT_SHA256 } from "../../src/addon/scope-contract.js";
import { LATEST_SCHEMA_VERSION } from "../../src/db/schema.js";

const SHA = {
  candidate: "a".repeat(40),
  evidence: "b".repeat(40),
  archive: "c".repeat(64),
  server: "d".repeat(64),
  sourceBinding: "9".repeat(64),
  manifest: createHash("sha256")
    .update('{"name":"AI Assistant","version":"1.0.0"}')
    .digest("hex"),
  checksum: "f".repeat(64),
  workspace: "1".repeat(64),
};

function passingInput(): OperationalReleaseEvidenceInput {
  const attestationPayload = {
    workspaceSha256: SHA.workspace,
    installationGeneration: 1,
    releaseSha: SHA.candidate,
    releaseBuildHash: SHA.archive,
    serverArtifactSha256: SHA.server,
    sourceRelationship: "source_bound_builder",
    sourceBindingSha256: SHA.sourceBinding,
    manifestSha256: SHA.manifest,
    installedAt: "2026-07-18T10:00:00.000Z",
  };
  const attestationSha256 = hashCanonicalJson(attestationPayload);
  return {
    sourceCandidateSha: SHA.candidate,
    evidenceCommitSha: SHA.evidence,
    deployedVersion: {
      version: "1.0.0",
      releaseSha: SHA.candidate,
      buildHash: SHA.archive,
      serverArtifactSha256: SHA.server,
      sourceRelationship: "source_bound_builder",
      sourceBindingSha256: SHA.sourceBinding,
    },
    deployedManifest: { name: "AI Assistant", version: "1.0.0" },
    attestationVerification: {
      valid: true,
      attestationSha256,
      releaseSha: SHA.candidate,
      releaseBuildHash: SHA.archive,
      serverArtifactSha256: SHA.server,
      sourceRelationship: "source_bound_builder",
      sourceBindingSha256: SHA.sourceBinding,
      manifestSha256: SHA.manifest,
    },
    restoreEvidence: {
      format: 1,
      conclusion: "passed",
      checks: {
        checksum: { status: "passed", algorithm: "sha256", bytes: 42, digest: SHA.checksum },
        metadata: {
          status: "passed",
          format: 2,
          dataAsOf: "2026-07-18T09:55:00.000Z",
          backupCreatedAt: "2026-07-18T10:00:00.000Z",
        },
        integrity: { status: "passed", sourceResult: "ok", migratedResult: "ok" },
        schema: {
          status: "passed",
          sourceUserVersion: 7,
          userVersion: LATEST_SCHEMA_VERSION,
          migration: "candidate_private_clone",
          requiredTables: 11,
          requiredColumns: 43,
        },
        installation: { status: "passed", activeCount: 1 },
        tokenBackedRead: {
          status: "passed",
          endpoint: "GET /user",
          httpStatus: 200,
          redirects: "blocked",
        },
        applicationReadiness: {
          status: "passed",
          endpoint: "GET /health",
          httpStatus: 200,
          startupInitialization: "production",
          serverArtifact: "dist/server/server.js",
          portBinding: "child_ephemeral_ipc",
          releaseSha: SHA.candidate,
          releaseBuildHash: SHA.archive,
          serverArtifactSha256: SHA.server,
          shutdownVerification: {
            childExitCode: 0,
            databaseIntegrity: "ok",
            writerLock: "available",
          },
        },
      },
      timingsMs: {
        checksum: 10,
        integrity: 10,
        schema: 10,
        tokenBackedRead: 10,
        applicationReadiness: 10,
        total: 50,
      },
      recovery: {
        drillStartedAt: "2026-07-18T10:00:00.000Z",
        incidentAt: "2026-07-18T10:00:00.000Z",
        dataAsOf: "2026-07-18T09:55:00.000Z",
        backupCreatedAt: "2026-07-18T10:00:00.000Z",
        readinessConfirmedAt: "2026-07-18T10:00:15.000Z",
        rtoMs: 15_000,
        rpoMs: 300_000,
      },
    },
    scopeEvidence: {
      schemaVersion: 2,
      conclusion: "passed",
      releaseSha: SHA.candidate,
      releaseBuildHash: SHA.archive,
      serverArtifactSha256: SHA.server,
      sourceRelationship: "source_bound_builder",
      sourceBindingSha256: SHA.sourceBinding,
      manifestSha256: SHA.manifest,
      auth: "X-Addon-Token",
      workspaceBound: true,
      tokenIncluded: false,
      startedAt: "2026-07-18T10:00:30.000Z",
      finishedAt: "2026-07-18T10:01:00.000Z",
      coverage: {
        mode: "exact_endpoint_per_scope_fresh_install",
        perScopeNecessity: "platform_resource_action_contract",
        platformContract: {
          source: "https://dev-docs.marketplace.cake.com/clockify/build/manifest#scopes",
          sha256: CLOCKIFY_SCOPE_ENFORCEMENT_SHA256,
        },
      },
      freshInstall: {
        method: "authenticated_server_installation_attestation",
        ...attestationPayload,
        ageSeconds: 30,
        attestationSha256,
        remoteVerification: "passed",
        verificationEnvelope: {
          schemaVersion: 1,
          algorithm: "HMAC-SHA256",
          payload: attestationPayload,
          signature: "server-verified-signature",
        },
      },
      results: [
        { key: "workspace_read", scope: "WORKSPACE_READ", host: "api", method: "GET", status: "2xx", verdict: "AUTH_OK" },
      ],
      auditHost: {
        key: "workspace_read_audit_host",
        scope: "WORKSPACE_READ",
        host: "audit",
        method: "POST",
        status: "2xx",
        verdict: "AUTH_OK",
      },
    },
    requiredScopes: ["WORKSPACE_READ"],
  };
}

describe("operational release evidence", () => {
  it("accepts a candidate-bound measured restore and authenticated scope/AUDIT proof", () => {
    const input = passingInput();
    const result = validateOperationalReleaseEvidence(input);

    expect(result).toMatchObject({
      schemaVersion: 1,
      conclusion: "passed",
      sourceCandidateSha: SHA.candidate,
      evidenceCommitSha: SHA.evidence,
      backupRestore: { rtoMs: 15_000, rpoMs: 300_000 },
      scopeAndAudit: { retainedScopeCount: 1, auditHost: "AUTH_OK" },
    });
  });

  it("rejects circular builder-attested deployment identity", () => {
    const input = passingInput();
    input.deployedVersion = { ...input.deployedVersion, sourceRelationship: "builder_attested" };
    expect(() => validateOperationalReleaseEvidence(input)).toThrow(/source relationship/u);
  });

  it("rejects restore evidence for different deployed bytes or fabricated RTO/RPO", () => {
    const input = passingInput();
    (input.restoreEvidence as any).checks.applicationReadiness.serverArtifactSha256 = "0".repeat(64);
    expect(() => validateOperationalReleaseEvidence(input)).toThrow(/restore.*artifact/u);

    const timing = passingInput();
    (timing.restoreEvidence as any).recovery.rtoMs = 1;
    expect(() => validateOperationalReleaseEvidence(timing)).toThrow(/RTO/u);
  });

  it("rejects restore evidence that did not prove the source-to-candidate migration boundary", () => {
    const unmigrated = passingInput();
    (unmigrated.restoreEvidence as any).checks.schema.userVersion = 7;
    expect(() => validateOperationalReleaseEvidence(unmigrated)).toThrow(/migrated schema/u);

    const contradictory = passingInput();
    (contradictory.restoreEvidence as any).checks.schema.migration = "not_required";
    expect(() => validateOperationalReleaseEvidence(contradictory)).toThrow(/migration mode/u);
  });

  it("rejects missing retained scopes and a non-AUDIT-host clearance", () => {
    const input = passingInput();
    input.requiredScopes = ["WORKSPACE_READ", "PROJECT_READ"];
    expect(() => validateOperationalReleaseEvidence(input)).toThrow(/scope coverage/u);

    const wrongHost = passingInput();
    (wrongHost.scopeEvidence as any).auditHost.host = "api";
    expect(() => validateOperationalReleaseEvidence(wrongHost)).toThrow(/AUDIT host/u);

    const routedButNotSuccessful = passingInput();
    (routedButNotSuccessful.scopeEvidence as any).auditHost.status = 400;
    (routedButNotSuccessful.scopeEvidence as any).auditHost.verdict = "AUTH_OK";
    expect(() => validateOperationalReleaseEvidence(routedButNotSuccessful)).toThrow(/AUDIT host.*2xx/u);
  });

  it("requires the platform scope contract and one exact fresh-install endpoint per retained scope", () => {
    const input = passingInput();
    (input.scopeEvidence as any).coverage.platformContract.sha256 = "0".repeat(64);
    expect(() => validateOperationalReleaseEvidence(input)).toThrow(/platform scope contract/u);

    const unlabeled = passingInput();
    delete (unlabeled.scopeEvidence as any).coverage;
    expect(() => validateOperationalReleaseEvidence(unlabeled)).toThrow(/scope coverage/u);
  });

  it("rejects self-authored install-event evidence and secret-bearing artifacts", () => {
    const input = passingInput();
    (input.scopeEvidence as any).freshInstall.method = "immutable_install_event";
    expect(() => validateOperationalReleaseEvidence(input)).toThrow(/installation attestation/u);

    const secret = passingInput();
    (secret.scopeEvidence as any).addonToken = "not-a-secret-fixture";
    expect(() => validateOperationalReleaseEvidence(secret)).toThrow(/secret-free/u);
  });

  it("rejects a manifest that differs from the production scope proof", () => {
    const input = passingInput();
    (input.scopeEvidence as any).manifestSha256 = "0".repeat(64);
    expect(() => validateOperationalReleaseEvidence(input)).toThrow(/manifest/u);
  });

  it("binds freshness fields to the remotely verified envelope payload", () => {
    const ageTamper = passingInput();
    (ageTamper.scopeEvidence as any).freshInstall.ageSeconds = 0;
    expect(() => validateOperationalReleaseEvidence(ageTamper)).toThrow(/fresh installation age calculation/u);

    const envelopeTamper = passingInput();
    (envelopeTamper.scopeEvidence as any).freshInstall.verificationEnvelope.payload.installedAt =
      "2026-07-18T09:59:00.000Z";
    expect(() => validateOperationalReleaseEvidence(envelopeTamper)).toThrow(/attestation envelope hash/u);
  });
});
