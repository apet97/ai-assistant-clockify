export type ClockifyService = "api" | "reports" | "audit";

const ALLOWED_PATHS: Record<ClockifyService, ReadonlySet<string>> = {
  api: new Set(["/", "/api", "/api/v1", "/v1"]),
  reports: new Set(["/", "/report", "/report/v1", "/v1"]),
  audit: new Set(["/v1"]),
};

function clockifyHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "clockify.me" || lower.endsWith(".clockify.me");
}

/**
 * Parse and validate a Clockify-published service URL before it is persisted or
 * used. This is the egress allow-list: HTTPS only, Clockify-owned DNS only,
 * default HTTPS port, no credentials/query/fragment, and a service-specific
 * path. A hostname allow-list also rejects IP, localhost, private and link-local
 * origins without relying on DNS resolution.
 */
export function validateClockifyServiceUrl(raw: string, service: ClockifyService): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid Clockify service URL for ${service}.`);
  }
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (
    url.protocol !== "https:" ||
    (url.port !== "" && url.port !== "443") ||
    url.username !== "" ||
    url.password !== "" ||
    !clockifyHostname(url.hostname) ||
    url.search !== "" ||
    url.hash !== "" ||
    !ALLOWED_PATHS[service].has(path)
  ) {
    throw new Error(`Invalid Clockify service URL for ${service}.`);
  }
  url.pathname = path;
  return url;
}

export function canonicalClockifyServiceUrl(raw: string, service: ClockifyService): string {
  const url = validateClockifyServiceUrl(raw, service);
  return `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;
}
