import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CLOCKIFY_SCOPE_ENFORCEMENT_SHA256,
  REQUIRED_SCOPES,
} from "../../src/addon/scope-contract.js";
import { FEATURE_GROUPS } from "../../src/harness/permissions.js";
import {
  CANONICAL_RELEASE_EVIDENCE_PATHS,
  importReleaseEvidence,
} from "../../scripts/evidence/import-release-evidence.js";
import { buildPrivateProductionEvidence } from "../../scripts/performance/private-production-contract.js";
import { hashCanonicalJson } from "../../scripts/lib/live-evidence.js";

const SHA = {
  candidate: "a".repeat(40),
  archive: "b".repeat(64),
  server: "c".repeat(64),
  sourceBinding: "d".repeat(64),
  checksum: "e".repeat(64),
  workspace: "f".repeat(64),
};

function samples(value: number): number[] {
  return Array.from({ length: 20 }, () => value);
}

function releaseInputs() {
  const deployedManifest = { version: "1.0.0", name: "AI Assistant" };
  const manifestSha256 = hashCanonicalJson(deployedManifest);
  const deployedVersion = {
    version: "1.0.0",
    releaseSha: SHA.candidate,
    buildHash: SHA.archive,
    serverArtifactSha256: SHA.server,
    sourceRelationship: "source_bound_builder",
    sourceBindingSha256: SHA.sourceBinding,
  };
  const payload = {
    workspaceSha256: SHA.workspace,
    installationGeneration: 1,
    releaseSha: SHA.candidate,
    releaseBuildHash: SHA.archive,
    serverArtifactSha256: SHA.server,
    sourceRelationship: "source_bound_builder",
    sourceBindingSha256: SHA.sourceBinding,
    manifestSha256,
    installedAt: "2026-07-19T00:00:00.000Z",
  };
  const attestationSha256 = hashCanonicalJson(payload);
  const privateProduction = buildPrivateProductionEvidence({
    measurementStartedAt: "2026-07-19T00:02:00.000Z",
    generatedAt: "2026-07-19T00:03:00.000Z",
    commitSha: SHA.candidate,
    deployed: {
      releaseBuildHash: SHA.archive,
      serverArtifactSha256: SHA.server,
      sourceRelationship: "source_bound_builder",
      sourceBindingSha256: SHA.sourceBinding,
    },
    node: "v22.21.0",
    browserVersion: "140.0.0.0",
    samples: {
      warmIframeInteractiveMs: samples(900),
      coldFast4gInteractiveMs: samples(1_900),
      historyApiMs: samples(240),
      localStatusMs: samples(90),
      confirmationFirstReceiptMs: samples(7_900),
    },
    cleanup: { created: 20, deletionProven: 20, pendingPreviews: 0 },
  });
  const restore = {
    format: 1,
    conclusion: "passed",
    checks: {
      checksum: { status: "passed", algorithm: "sha256", bytes: 42, digest: SHA.checksum },
      metadata: {
        status: "passed",
        format: 2,
        dataAsOf: "2026-07-18T23:55:00.000Z",
        backupCreatedAt: "2026-07-19T00:00:00.000Z",
      },
      integrity: { status: "passed", sourceResult: "ok", migratedResult: "ok" },
      schema: {
        status: "passed",
        sourceUserVersion: 7,
        userVersion: 11,
        migration: "candidate_private_clone",
        requiredTables: 11,
        requiredColumns: 43,
      },
      installation: { status: "passed", activeCount: 1 },
      tokenBackedRead: { status: "passed", endpoint: "GET /user", httpStatus: 200, redirects: "blocked" },
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
        shutdownVerification: { childExitCode: 0, databaseIntegrity: "ok", writerLock: "available" },
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
      drillStartedAt: "2026-07-19T00:00:00.000Z",
      incidentAt: "2026-07-19T00:00:00.000Z",
      dataAsOf: "2026-07-18T23:55:00.000Z",
      backupCreatedAt: "2026-07-19T00:00:00.000Z",
      readinessConfirmedAt: "2026-07-19T00:00:15.000Z",
      rtoMs: 15_000,
      rpoMs: 300_000,
    },
  };
  const scope = {
    schemaVersion: 2,
    conclusion: "passed",
    releaseSha: SHA.candidate,
    releaseBuildHash: SHA.archive,
    serverArtifactSha256: SHA.server,
    sourceRelationship: "source_bound_builder",
    sourceBindingSha256: SHA.sourceBinding,
    manifestSha256,
    startedAt: "2026-07-19T00:00:30.000Z",
    finishedAt: "2026-07-19T00:01:00.000Z",
    freshInstall: {
      method: "authenticated_server_installation_attestation",
      ...payload,
      ageSeconds: 30,
      attestationSha256,
      remoteVerification: "passed",
      verificationEnvelope: {
        schemaVersion: 1,
        algorithm: "HMAC-SHA256",
        payload,
        signature: "server-verified-signature",
      },
    },
    auth: "X-Addon-Token",
    workspaceBound: true,
    tokenIncluded: false,
    coverage: {
      mode: "exact_endpoint_per_scope_fresh_install",
      perScopeNecessity: "platform_resource_action_contract",
      platformContract: {
        source: "https://dev-docs.marketplace.cake.com/clockify/build/manifest#scopes",
        sha256: CLOCKIFY_SCOPE_ENFORCEMENT_SHA256,
      },
    },
    results: REQUIRED_SCOPES.map((scopeName) => ({
      key: scopeName.toLowerCase(),
      scope: scopeName,
      host: "api",
      method: "GET",
      status: "2xx",
      verdict: "AUTH_OK",
    })),
    auditHost: {
      key: "workspace_read_audit_host",
      scope: "WORKSPACE_READ",
      host: "audit",
      method: "POST",
      status: "2xx",
      verdict: "AUTH_OK",
    },
  };
  const attestationVerification = {
    valid: true,
    attestationSha256,
    releaseSha: SHA.candidate,
    releaseBuildHash: SHA.archive,
    serverArtifactSha256: SHA.server,
    sourceRelationship: "source_bound_builder",
    sourceBindingSha256: SHA.sourceBinding,
    manifestSha256,
  };
  const memberDenial = {
    schemaVersion: 1,
    kind: "production_member_denial",
    conclusion: "passed",
    source: {
      commitSha: SHA.candidate,
      releaseBuildHash: SHA.archive,
      serverArtifactSha256: SHA.server,
      sourceRelationship: "source_bound_builder",
      sourceBindingSha256: SHA.sourceBinding,
    },
    observedAt: "2026-07-19T00:02:30.000Z",
    role: "MEMBER",
    authorityPath: "verified_installation_to_member_exchange",
    componentStatus: 403,
    sessionCookieIssued: false,
    adminOnlyResponse: true,
  };
  const browser = {
    schemaVersion: 1,
    kind: "production_browser_acceptance",
    conclusion: "passed",
    source: memberDenial.source,
    startedAt: "2026-07-19T00:02:00.000Z",
    completedAt: "2026-07-19T00:04:00.000Z",
    deployedVersionObservedAt: "2026-07-19T00:02:01.000Z",
    runtime: {
      browser: "Google Chrome",
      browserVersion: "140.0.7339.42",
      surface: "clockify_embedded_iframe",
    },
    journeys: {
      firstRun: {
        disclosureVisible: true,
        permissionsSaved: true,
        permissionGroupCount: FEATURE_GROUPS.length,
      },
      admin: { componentLoaded: true, role: "OWNER" },
      read: { receiptVisible: true },
      safeWrite: { receiptVisible: true },
      undo: { receiptVisible: true, effectAbsent: true },
      riskyCancel: { previewVisible: true, cancelled: true, effectPreserved: true },
      riskyConfirm: { previewVisible: true, confirmed: true, receiptVisible: true, effectAbsent: true },
      history: { conversationSwitched: true, contentRestored: true },
      reload: { contentRestored: true, operationCardsRestored: true },
      pdf: {
        actionVisible: true,
        downloadCompleted: true,
        filenameExtension: ".pdf",
        contentType: "application/pdf",
        signature: "%PDF-",
        bytes: 128,
        authenticatedStatus: 200,
        unauthenticatedStatus: 401,
      },
    },
    cleanup: {
      resourcePrefix: "AIASSIST_SMOKE_",
      created: 4,
      deletionProven: 4,
      remaining: 0,
      pendingPreviews: 0,
    },
    capture: {
      artifactType: "browser_automation_trace",
      sha256: "",
      secretReview: "passed",
    },
    memberDenialEvidenceSha256: hashCanonicalJson(memberDenial),
  };
  const browserTrace = {
    schemaVersion: 1,
    kind: "sanitized_browser_automation_trace",
    startedAt: browser.startedAt,
    completedAt: browser.completedAt,
    deployedVersionObservedAt: browser.deployedVersionObservedAt,
    runtime: browser.runtime,
    journeys: browser.journeys,
    cleanup: browser.cleanup,
  };
  browser.capture.sha256 = createHash("sha256")
    .update(`${JSON.stringify(browserTrace)}\n`, "utf8")
    .digest("hex");
  return {
    deployedManifest,
    deployedVersion,
    privateProduction,
    restore,
    scope,
    attestationVerification,
    browser,
    browserTrace,
    memberDenial,
  };
}

function writeInputs(root: string, input = releaseInputs()) {
  const source = join(root, "timestamped-source");
  const paths = {
    privateProductionPath: join(source, "private-production-aabbccddeeff-20260719000300.json"),
    restorePath: join(source, "restore-verification-20260719T000015Z.json"),
    scopePath: join(source, "scope-probe-20260719T000100Z.json"),
    browserPath: join(source, "browser-acceptance-20260719T000400Z.json"),
    browserTracePath: join(source, "browser-trace-20260719T000400Z.json"),
    memberDenialPath: join(source, "member-denial-20260719T000230Z.json"),
    deployedVersionPath: join(source, "deployed-version.json"),
    deployedManifestPath: join(source, "deployed-manifest.json"),
    attestationVerificationPath: join(source, "attestation-verification.json"),
  };
  mkdirSync(source, { recursive: true });
  for (const [key, path] of Object.entries(paths)) {
    const value = ({
      privateProductionPath: input.privateProduction,
      restorePath: input.restore,
      scopePath: input.scope,
      browserPath: input.browser,
      browserTracePath: input.browserTrace,
      memberDenialPath: input.memberDenial,
      deployedVersionPath: input.deployedVersion,
      deployedManifestPath: input.deployedManifest,
      attestationVerificationPath: input.attestationVerification,
    } as Record<string, unknown>)[key];
    writeFileSync(path, `${JSON.stringify(value)}\n`);
  }
  return paths;
}

describe("canonical release-evidence import", () => {
  it("validates timestamped sources and writes only the exact deterministic workflow filenames", () => {
    const root = mkdtempSync(join(tmpdir(), "release-evidence-import-"));
    const paths = writeInputs(root);
    const result = importReleaseEvidence({ root, sourceCandidateSha: SHA.candidate, ...paths });

    for (const path of Object.values(CANONICAL_RELEASE_EVIDENCE_PATHS)) {
      expect(existsSync(join(root, path))).toBe(true);
    }
    expect(result.operationalValidation.sourceCandidateSha).toBe(SHA.candidate);
    expect(result.privateProductionValidation.sourceCandidateSha).toBe(SHA.candidate);
    expect(readFileSync(join(root, CANONICAL_RELEASE_EVIDENCE_PATHS.privateProduction), "utf8"))
      .toBe(`${JSON.stringify(result.privateProduction, null, 2)}\n`);
    expect(readFileSync(join(root, CANONICAL_RELEASE_EVIDENCE_PATHS.privateProductionMarkdown), "utf8"))
      .toContain("Private-production performance gate");
    expect(readFileSync(join(root, CANONICAL_RELEASE_EVIDENCE_PATHS.browserTrace), "utf8"))
      .toBe(`${JSON.stringify(releaseInputs().browserTrace)}\n`);
  });

  it("fails before writing canonical files on source mismatch, invalid schema, or secret leakage", () => {
    for (const mutate of [
      (input: ReturnType<typeof releaseInputs>) => { input.privateProduction.source.commitSha = "9".repeat(40); },
      (input: ReturnType<typeof releaseInputs>) => { input.restore.format = 2 as never; },
      (input: ReturnType<typeof releaseInputs>) => { (input.scope as Record<string, unknown>).addonToken = "not-a-secret-fixture"; },
      (input: ReturnType<typeof releaseInputs>) => { delete (input.browser.journeys as Record<string, unknown>).undo; },
      (input: ReturnType<typeof releaseInputs>) => { (input.browser as Record<string, unknown>).componentUrl = "https://private.example/component"; },
      (input: ReturnType<typeof releaseInputs>) => { input.browserTrace.journeys.read.receiptVisible = false as true; },
    ]) {
      const root = mkdtempSync(join(tmpdir(), "release-evidence-import-fail-"));
      const input = releaseInputs();
      mutate(input);
      const paths = writeInputs(root, input);
      expect(() => importReleaseEvidence({ root, sourceCandidateSha: SHA.candidate, ...paths })).toThrow();
      expect(existsSync(join(root, CANONICAL_RELEASE_EVIDENCE_PATHS.privateProduction))).toBe(false);
    }
  });

  it("canonicalizes object-key order without changing evidence hashes", () => {
    const leftRoot = mkdtempSync(join(tmpdir(), "release-evidence-order-left-"));
    const rightRoot = mkdtempSync(join(tmpdir(), "release-evidence-order-right-"));
    const left = releaseInputs();
    const right = releaseInputs();
    const reverse = (value: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(value).reverse());
    right.privateProduction = reverse(right.privateProduction as unknown as Record<string, unknown>) as never;
    right.restore = reverse(right.restore as Record<string, unknown>) as never;
    right.scope = reverse(right.scope as Record<string, unknown>) as never;
    right.browser = reverse(right.browser as Record<string, unknown>) as never;
    right.memberDenial = reverse(right.memberDenial as Record<string, unknown>) as never;
    right.deployedManifest = reverse(right.deployedManifest) as never;

    importReleaseEvidence({ root: leftRoot, sourceCandidateSha: SHA.candidate, ...writeInputs(leftRoot, left) });
    importReleaseEvidence({ root: rightRoot, sourceCandidateSha: SHA.candidate, ...writeInputs(rightRoot, right) });
    for (const path of Object.values(CANONICAL_RELEASE_EVIDENCE_PATHS)) {
      expect(readFileSync(join(leftRoot, path), "utf8")).toBe(readFileSync(join(rightRoot, path), "utf8"));
    }
  });
});
