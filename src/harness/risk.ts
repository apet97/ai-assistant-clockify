/**
 * Risk classification (SAFETY_AND_PERMISSIONS "Risk Classes"). The backend, not
 * the model, decides risk. Any action carrying a confirmation-required label
 * must go through dry-run preview + button confirmation before it can mutate.
 */
export type RiskLabel =
  | "read"
  | "safe_write"
  | "high_risk_write"
  | "destructive"
  | "billing"
  | "payment"
  | "permission_change"
  | "external_side_effect"
  | "bulk";

/**
 * Labels that force dry-run + button confirmation. Mirrors the safety doc's
 * required-confirmation set, plus `high_risk_write` (a strictly-safer default —
 * an elevated write should never execute on first proposal).
 */
const CONFIRMATION_REQUIRED: ReadonlySet<RiskLabel> = new Set<RiskLabel>([
  "high_risk_write",
  "destructive",
  "billing",
  "payment",
  "permission_change",
  "external_side_effect",
  "bulk",
]);

export function requiresConfirmation(risks: RiskLabel[]): boolean {
  return risks.some((risk) => CONFIRMATION_REQUIRED.has(risk));
}

export function isSafeWrite(risks: RiskLabel[]): boolean {
  return risks.includes("safe_write") && !requiresConfirmation(risks);
}
