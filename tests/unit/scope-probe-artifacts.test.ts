import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  requireScopeProbeArtifactPaths,
  writeScopeProbeArtifacts,
} from "../../scripts/lib/scope-probe-artifacts.js";

const SHA = {
  release: "a".repeat(40),
  archive: "b".repeat(64),
  server: "c".repeat(64),
  binding: "d".repeat(64),
  manifest: "e".repeat(64),
  attestation: "f".repeat(64),
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "scope-probe-artifacts-"));
  const checkout = join(root, "checkout");
  const evidence = join(root, "evidence");
  mkdirSync(checkout, { mode: 0o700 });
  mkdirSync(evidence, { mode: 0o700 });
  const paths = {
    scopeEvidence: join(evidence, "scope.json"),
    deployedManifest: join(evidence, "manifest.json"),
    attestationVerification: join(evidence, "attestation-verification.json"),
  };
  const environment = {
    SCOPE_PROBE_EVIDENCE_PATH: paths.scopeEvidence,
    DEPLOYED_MANIFEST_EVIDENCE_PATH: paths.deployedManifest,
    ATTESTATION_VERIFICATION_EVIDENCE_PATH: paths.attestationVerification,
  };
  return { checkout, evidence, paths, environment };
}

function artifacts() {
  return {
    scopeEvidence: {
      schemaVersion: 2,
      conclusion: "passed",
      releaseSha: SHA.release,
      tokenIncluded: false,
      freshInstall: { verificationEnvelope: { signature: "required-signed-proof" } },
    },
    deployedManifest: {
      name: "AI Assistant",
      version: "1.0.0",
      baseUrl: "https://ai-assistant-production-c2e6.up.railway.app",
    },
    remoteVerification: {
      valid: true,
      attestationSha256: SHA.attestation,
      releaseSha: SHA.release,
      releaseBuildHash: SHA.archive,
      serverArtifactSha256: SHA.server,
      sourceRelationship: "source_bound_builder",
      sourceBindingSha256: SHA.binding,
      manifestSha256: SHA.manifest,
    },
  };
}

describe("standalone live scope-probe artifacts", () => {
  it("requires three distinct, nonexistent, external paths before live work", () => {
    const { checkout, evidence, environment } = fixture();
    expect(() => requireScopeProbeArtifactPaths({}, checkout)).toThrow(/SCOPE_PROBE_EVIDENCE_PATH/u);
    expect(() => requireScopeProbeArtifactPaths({
      ...environment,
      DEPLOYED_MANIFEST_EVIDENCE_PATH: join(checkout, "manifest.json"),
    }, checkout)).toThrow(/outside the checkout/u);
    expect(() => requireScopeProbeArtifactPaths({
      ...environment,
      ATTESTATION_VERIFICATION_EVIDENCE_PATH: join(evidence, "scope.json"),
    }, checkout)).toThrow(/distinct/u);
    const canonicalEvidence = realpathSync(evidence);
    expect(requireScopeProbeArtifactPaths(environment, checkout)).toEqual({
      scopeEvidence: join(canonicalEvidence, "scope.json"),
      deployedManifest: join(canonicalEvidence, "manifest.json"),
      attestationVerification: join(canonicalEvidence, "attestation-verification.json"),
    });
  });

  it("requires an owned mode-0700 parent and rejects canonical aliases through symlinked ancestors", () => {
    const { checkout, evidence, environment } = fixture();
    chmodSync(evidence, 0o500);
    expect(() => requireScopeProbeArtifactPaths(environment, checkout)).toThrow(/mode 0700/u);
    chmodSync(evidence, 0o700);

    const canonicalAncestor = join(dirname(evidence), "canonical-ancestor");
    const canonicalParent = join(canonicalAncestor, "nested");
    mkdirSync(canonicalParent, { recursive: true, mode: 0o700 });
    const aliasAncestor = join(dirname(evidence), "alias-ancestor");
    symlinkSync(canonicalAncestor, aliasAncestor, "dir");
    expect(() => requireScopeProbeArtifactPaths({
      ...environment,
      SCOPE_PROBE_EVIDENCE_PATH: join(canonicalParent, "scope.json"),
      ATTESTATION_VERIFICATION_EVIDENCE_PATH: join(aliasAncestor, "nested", "scope.json"),
    }, checkout)).toThrow(/distinct/u);
  });

  it("atomically writes exact mode-0600 standalone shapes after complete success", () => {
    const { checkout, paths, environment } = fixture();
    const resolved = requireScopeProbeArtifactPaths(environment, checkout);
    const values = artifacts();

    writeScopeProbeArtifacts(resolved, values);

    expect(JSON.parse(readFileSync(paths.scopeEvidence, "utf8"))).toEqual(values.scopeEvidence);
    expect(JSON.parse(readFileSync(paths.deployedManifest, "utf8"))).toEqual(values.deployedManifest);
    expect(JSON.parse(readFileSync(paths.attestationVerification, "utf8"))).toEqual(values.remoteVerification);
    for (const path of Object.values(paths)) {
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(paths.deployedManifest, "utf8")).not.toMatch(/token|verificationEnvelope/u);
    expect(readFileSync(paths.attestationVerification, "utf8")).not.toMatch(/token|verificationEnvelope/u);
  });

  it("fails closed without writing any canonical artifact when one shape is unsafe", () => {
    const { checkout, paths, environment } = fixture();
    const resolved = requireScopeProbeArtifactPaths(environment, checkout);
    const values = artifacts();

    expect(() => writeScopeProbeArtifacts(resolved, {
      ...values,
      remoteVerification: {
        ...values.remoteVerification,
        VerificationEnvelope: { AddonToken: "must-not-persist" },
      },
    })).toThrow(/remote verification/u);
    for (const path of Object.values(paths)) expect(existsSync(path)).toBe(false);
  });
});
