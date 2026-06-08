import { createHash, createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CLOCKIFY_PLATFORM_PUBLIC_KEY_PEM } from "../../src/addon/clockify-public-key.js";

/**
 * The embedded default key MUST be exactly Clockify's production platform public
 * key, or every install/lifecycle/component token fails verification. We pin the
 * SPKI sha256 fingerprint so a stray edit can never silently substitute a wrong
 * key. The same key body is present in the official add-on SDK docs and in every
 * sibling Clockify add-on under addons-me.
 */
describe("CLOCKIFY_PLATFORM_PUBLIC_KEY_PEM", () => {
  it("is a parseable RSA SPKI public key", () => {
    const key = createPublicKey(CLOCKIFY_PLATFORM_PUBLIC_KEY_PEM);
    expect(key.asymmetricKeyType).toBe("rsa");
  });

  it("matches Clockify's pinned production key fingerprint", () => {
    const der = createPublicKey(CLOCKIFY_PLATFORM_PUBLIC_KEY_PEM).export({
      type: "spki",
      format: "der",
    });
    const fingerprint = createHash("sha256").update(der).digest("hex");
    expect(fingerprint).toBe(
      "0cebc449014cf940ad0763e204b29b3a2263abfa1ccd298347c9bd2db2708b16",
    );
  });
});
