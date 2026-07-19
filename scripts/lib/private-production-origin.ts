export const PRIVATE_PRODUCTION_HOST = "ai-assistant-production-c2e6.up.railway.app";
export const PRIVATE_PRODUCTION_ORIGIN = `https://${PRIVATE_PRODUCTION_HOST}`;

/**
 * Accept only the root public Railway origin used by the private production
 * service. Live launchers call this before any network request so a typo,
 * preview path, custom port, or attacker-controlled host can never receive an
 * exchanged Clockify user credential.
 */
export function privateProductionRailwayOrigin(raw: string): URL | undefined {
  if (raw !== PRIVATE_PRODUCTION_ORIGIN && raw !== `${PRIVATE_PRODUCTION_ORIGIN}/`) return undefined;
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
    || url.hostname !== PRIVATE_PRODUCTION_HOST
  ) return undefined;
  return url;
}
