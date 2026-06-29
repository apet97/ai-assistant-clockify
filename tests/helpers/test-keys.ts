import { inject } from "vitest";
import { createPrivateKey, type KeyObject } from "node:crypto";

/**
 * The suite-wide RSA test keypair: generated ONCE in tests/global-setup.ts and
 * handed to workers as PEMs (provide/inject). RSA-2048 keygen is ~46ms and
 * CPU-heavy; doing it per test FILE (~15 integration files) saturated the Vitest
 * fork pool and, under the concurrent build+test CPU contention of
 * `npm run verify`, intermittently skewed unrelated files' auth/session timing
 * (the flaky-gate root cause). Here we only RE-IMPORT the shared private key
 * (cheap; no keygen) and memoize per file. The shape matches what every caller
 * reads: { privateKey, pem } (pem is the SPKI public-key PEM).
 */
export interface TestKeys {
  privateKey: KeyObject;
  pem: string;
}

let cached: TestKeys | undefined;

export function testKeys(): Promise<TestKeys> {
  if (!cached) {
    cached = {
      pem: inject("addonPublicKeyPem"),
      privateKey: createPrivateKey(inject("addonPrivateKeyPem")),
    };
  }
  return Promise.resolve(cached);
}
