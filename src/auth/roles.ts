/**
 * Admin-only access gate (SAFETY_AND_PERMISSIONS "Admin Access").
 *
 * Accepts only OWNER / ADMIN (case-insensitive). Every other value — including
 * empty, whitespace, undefined, null, or non-string — is rejected.
 */
export function isAdminRole(role: unknown): boolean {
  const normalized = String(role ?? "").trim().toLowerCase();
  return normalized === "owner" || normalized === "admin";
}
