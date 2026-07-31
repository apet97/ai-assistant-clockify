/**
 * Run a side effect (audit write, telemetry, nonce rotation, …) that must NEVER
 * fail the caller. The change it accompanies has already been applied — a throw
 * here is logged as the fixed call-site label ONLY, with no error detail at
 * all, and swallowed, never rethrown. A failed audit/telemetry write must not
 * turn a succeeded operation into a 500 the admin would retry.
 */
export function bestEffort(label: string, fn: () => void): void {
  try {
    fn();
  } catch {
    // Store/driver errors can embed SQL values or serialized payloads. The label
    // is a fixed call-site string; exception text is intentionally suppressed.
    console.error(`${label} (change already applied; preserved; error details suppressed)`);
  }
}
