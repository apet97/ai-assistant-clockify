import { describe, expect, it } from "vitest";

import {
  createInstallationAttestationEnvelope,
  deriveInstallationAttestationKey,
  hashCanonicalAttestationJson,
  hashInstallationToken,
  hashRetiredInstallationToken,
  verifyInstallationAttestationEnvelope,
  type InstallationAttestationRecord,
} from "../../src/addon/install-attestation.js";

const record: InstallationAttestationRecord = {
  workspaceSha256: "1".repeat(64),
  installationGeneration: 1,
  releaseSha: "a".repeat(40),
  releaseBuildHash: "b".repeat(64),
  serverArtifactSha256: "c".repeat(64),
  sourceRelationship: "source_bound_builder",
  sourceBindingSha256: "d".repeat(64),
  manifestSha256: "e".repeat(64),
  installedAt: "2026-07-19T08:00:00.000Z",
};

describe("fresh installation attestation envelope", () => {
  it("uses unlinkable domains for active and retired token fingerprints", () => {
    const token = "same-high-entropy-installation-token";
    const active = hashInstallationToken(token);
    const retired = hashRetiredInstallationToken(token);

    expect(active).toMatch(/^[a-f0-9]{64}$/u);
    expect(retired).toMatch(/^[a-f0-9]{64}$/u);
    expect(retired).not.toBe(active);
    expect(active).not.toContain(token);
    expect(retired).not.toContain(token);
  });

  it("mints a deterministic, secret-free, tamper-proof envelope", () => {
    const key = deriveInstallationAttestationKey("session-secret-with-enough-entropy");
    const first = createInstallationAttestationEnvelope(record, key);
    const second = createInstallationAttestationEnvelope(record, key);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: 1,
      algorithm: "HMAC-SHA256",
      payload: record,
    });
    expect(first.signature).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(JSON.stringify(first)).not.toMatch(/session-secret/u);
    expect(verifyInstallationAttestationEnvelope(first, key)).toEqual({
      valid: true,
      attestationSha256: hashCanonicalAttestationJson(record),
      ...record,
    });
  });

  it("rejects arbitrary JSON, a wrong key, extra claims, and a modified binding", () => {
    const key = deriveInstallationAttestationKey("session-secret-with-enough-entropy");
    const envelope = createInstallationAttestationEnvelope(record, key);

    expect(verifyInstallationAttestationEnvelope({ payload: record }, key)).toEqual({ valid: false });
    expect(verifyInstallationAttestationEnvelope(
      envelope,
      deriveInstallationAttestationKey("different-session-secret-value"),
    )).toEqual({ valid: false });
    expect(verifyInstallationAttestationEnvelope({
      ...envelope,
      payload: { ...envelope.payload, releaseSha: "f".repeat(40) },
    }, key)).toEqual({ valid: false });
    expect(verifyInstallationAttestationEnvelope({
      ...envelope,
      operatorAssertion: true,
    }, key)).toEqual({ valid: false });
  });
});
