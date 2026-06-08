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
