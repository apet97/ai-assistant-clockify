import { testing } from "@apet97/clockify-addon-sdk";

/**
 * Memoized RSA test keys. RSA-2048 keygen is ~46ms and CPU-heavy; generating it
 * PER TEST saturates the Vitest fork pool and intermittently TIMES OUT unrelated
 * test files under load — the flaky-CI root cause. The key material is identical
 * across every test, so generate it once per module graph and share the promise.
 * Vitest isolation gives each test file a fresh module registry, so this memoizes
 * once per file (the same effect as the prior inline `keysPromise` pattern, DRY).
 */
let keysPromise: ReturnType<typeof testing.generateTestKeys> | undefined;
export function testKeys(): ReturnType<typeof testing.generateTestKeys> {
  if (!keysPromise) keysPromise = testing.generateTestKeys();
  return keysPromise;
}
