/**
 * Resolve the Clockify REST base URL for an installation.
 *
 * Per the marketplace docs (08-auth / 09-environments): the add-on must read the
 * API host from the install context, never hardcode it — dev/sandbox and other
 * regions use their own hosts. Two gotchas this encodes:
 *
 *  1. The INSTALLED payload carries `apiUrl` (e.g. `https://developer.clockify.me/api`),
 *     but the *lifecycle* token usually OMITS the `backendUrl` claim — so the stored
 *     `backendUrl` is often undefined. Prefer the payload `apiUrl`.
 *  2. `apiUrl`/`backendUrl` already end with `/api`; the REST version path is `/v1`,
 *     NOT `/api/v1`. Appending `/api/v1` yields `…/api/api/v1` (404), and falling back
 *     to the production host with a dev token yields 401 "Token is not valid" (4017).
 */
export function resolveClockifyApiBase(installation: {
  apiUrl?: string;
  backendUrl?: string;
}): string {
  const root = (installation.apiUrl ?? installation.backendUrl ?? "https://api.clockify.me/api")
    .replace(/\/+$/, "");
  return root.endsWith("/v1") ? root : `${root}/v1`;
}

/**
 * Resolve the REPORTS host base from the token's `reportsUrl` claim (+ `/v1`).
 *
 * The reports host is NOT derivable from the api host: prod uses a subdomain
 * (`https://reports.api.clockify.me`) while dev uses a path on the same host
 * (`https://developer.clockify.me/report`). The docs are explicit — read it from
 * the claim. Returns undefined when we have not captured it yet, in which case
 * the REST core falls back to deriving the prod subdomain.
 */
export function resolveClockifyReportsBase(installation: {
  reportsUrl?: string;
}): string | undefined {
  if (!installation.reportsUrl) return undefined;
  const root = installation.reportsUrl.replace(/\/+$/, "");
  return root.endsWith("/v1") ? root : `${root}/v1`;
}

/**
 * Resolve the AUDIT host base, or `undefined` when this environment has none.
 *
 * Unlike reports, Clockify publishes NO audit URL claim: the documented and
 * live-observed token URL claims are exactly `backendUrl`, `reportsUrl`,
 * `locationsUrl`, `screenshotsUrl` (+ `ptoUrl`) — see MARKETPLACE_OCS 08/09 and
 * the decoded live install/user tokens. So there is nothing to capture; the
 * audit host can only be derived.
 *
 * The audit log lives solely on the `auditlog-api.api.<tenant>` subdomain, which
 * exists only where the API itself is served from the `api.<tenant>` subdomain
 * (production / regional hosts). Dev, subdomain and path-based environments serve
 * the API from a path (e.g. `https://developer.clockify.me/api`) and have no
 * audit host. For those we return `undefined` so the REST core surfaces a clean
 * "audit log not available in this environment" error instead of fetching a
 * guessed `auditlog-api.api.developer.clockify.me` that does not resolve (the raw
 * "fetch failed" the dev environment used to produce).
 */
export function resolveClockifyAuditBase(installation: {
  apiUrl?: string;
  backendUrl?: string;
}): string | undefined {
  const root = installation.apiUrl ?? installation.backendUrl;
  if (!root) return undefined;
  let url: URL;
  try {
    url = new URL(root);
  } catch {
    return undefined;
  }
  if (!url.host.startsWith("api.")) return undefined;
  const tenant = url.host.slice("api.".length);
  return `${url.protocol}//auditlog-api.api.${tenant}/v1`;
}
