import { createHmac } from "node:crypto";

/**
 * Domain-separated HMAC aliases for operational identifiers (F14). Workspace,
 * admin, and add-on ids are customer-linked identifiers; the hosting platform's
 * log plane retains them beyond the application database's scoped data model,
 * so operational log lines must never carry them raw. An alias is:
 *
 * - stable within one deployment (keyed on the session secret), so an operator
 *   can still correlate lines across events, restarts, and generations;
 * - domain-separated per identifier kind, so a workspace alias can never be
 *   joined against an admin alias even for an equal underlying id;
 * - short (12 base64url chars = 72 bits), one-way, and free of the raw id.
 *
 * The alias key is the session secret because it is the one always-present,
 * never-logged deployment secret; aliases are correlation handles, not
 * authenticators, so sharing the key with cookie signing is acceptable.
 */
export type LogAliasKind = "workspace" | "admin" | "addon";

const ALIAS_PREFIX: Record<LogAliasKind, string> = {
  workspace: "ws",
  admin: "adm",
  addon: "addon",
};

export function logAlias(secret: string, kind: LogAliasKind, id: string): string {
  if (!id) return `${ALIAS_PREFIX[kind]}-absent`;
  const digest = createHmac("sha256", secret)
    // The NUL delimiter keeps the domain tag unforgeable by id content.
    .update(`log-alias:v1:${kind}\u0000`)
    .update(id)
    .digest("base64url");
  return `${ALIAS_PREFIX[kind]}-${digest.slice(0, 12)}`;
}
