/**
 * Run a side effect (audit write, telemetry, nonce rotation, …) that must NEVER
 * fail the caller. The change it accompanies has already been applied — a throw
 * here is logged (message only, honoring the no-secrets-in-logs rule) and
 * swallowed, never rethrown. A failed audit/telemetry write must not turn a
 * succeeded operation into a 500 the admin would retry.
 */
export function bestEffort(label: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    console.error(
      `${label} (change already applied; preserved): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
