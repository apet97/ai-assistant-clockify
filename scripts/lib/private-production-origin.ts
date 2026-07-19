const RAILWAY_PUBLIC_HOST_SUFFIX = ".up.railway.app";

/**
 * Accept only the root public Railway origin used by the private production
 * service. Live launchers call this before any network request so a typo,
 * preview path, custom port, or attacker-controlled host can never receive an
 * exchanged Clockify user credential.
 */
export function privateProductionRailwayOrigin(raw: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw.endsWith("/") ? raw : `${raw}/`);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.port !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
    || !url.hostname.endsWith(RAILWAY_PUBLIC_HOST_SUFFIX)
    || url.hostname.length <= RAILWAY_PUBLIC_HOST_SUFFIX.length
  ) return undefined;
  return url;
}
