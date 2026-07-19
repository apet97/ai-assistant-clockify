import {
  ClockifyHeaders,
  ClockifyQueryParams,
  ClockifySignatureParser,
  type ClockifyAddonClaims,
} from "@apet97/clockify-addon-sdk";

/**
 * Clockify signed-token verification seam (ARCHITECTURE "Component Load" /
 * "Lifecycle Install"). Component requests carry the token in the `auth_token`
 * query param; lifecycle requests carry it in the `x-addon-lifecycle-token`
 * header. Both are RS256 add-on JWTs verified by the same parser.
 */
export { ClockifyHeaders, ClockifyQueryParams };
export type { ClockifyAddonClaims };

export function createSignatureParser(
  addonKey: string,
  publicKeyPem: string,
): ClockifySignatureParser {
  return new ClockifySignatureParser(addonKey, publicKeyPem);
}

/**
 * Verify a Clockify add-on token, returning the claims on success or
 * `undefined` on any failure. Never throws and never logs the token.
 */
export async function verifyAddonToken(
  parser: ClockifySignatureParser,
  token: string | undefined | null,
): Promise<ClockifyAddonClaims | undefined> {
  if (!token) return undefined;
  try {
    const claims = await parser.parseClaims(token);
    // jose validates expiry when present; require the claim as well so an
    // otherwise valid indefinitely replayable token is never accepted on any
    // component or lifecycle surface.
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return undefined;
    return claims;
  } catch {
    return undefined;
  }
}
