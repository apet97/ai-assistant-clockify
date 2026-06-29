import type { KeyObject } from "node:crypto";
import { testing } from "@apet97/clockify-addon-sdk";

/**
 * ONE RSA keypair for the WHOLE test suite (flaky-gate fix — plan finding F1).
 *
 * RSA-2048 keygen is ~46ms and CPU-heavy. Generating it per test FILE (~15
 * integration files each calling generateTestKeys in beforeAll) saturated the
 * Vitest fork pool; under the concurrent build+test CPU contention of
 * `npm run verify` that intermittently skewed UNRELATED files' auth/session
 * request timing (observed: /api/me 401->200, an expired-session open 404->200,
 * a valid confirm 200->403). globalSetup runs ONCE in the main process — the key
 * material is identical for every test, so we generate it here and hand workers
 * serializable PEMs. testKeys() (tests/helpers/test-keys.ts) re-imports the
 * private key per file via a cheap createPrivateKey — zero RSA keygen in the pool.
 */
export default async function setup({
  provide,
}: {
  provide: (key: "addonPublicKeyPem" | "addonPrivateKeyPem", value: string) => void;
}): Promise<void> {
  const keys = await testing.generateTestKeys();
  const privatePem = (keys.privateKey as KeyObject).export({ type: "pkcs8", format: "pem" }) as string;
  provide("addonPublicKeyPem", keys.pem);
  provide("addonPrivateKeyPem", privatePem);
}

declare module "vitest" {
  interface ProvidedContext {
    addonPublicKeyPem: string;
    addonPrivateKeyPem: string;
  }
}
