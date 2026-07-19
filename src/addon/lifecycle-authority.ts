import { createHash } from "node:crypto";

/** Lifecycle JWTs outside this age/skew envelope are rejected at the route. */
export const MAX_LIFECYCLE_AGE_SECONDS = 24 * 60 * 60;
export const LIFECYCLE_CLOCK_SKEW_SECONDS = 60;

/**
 * A deleted installation row cannot carry its issuer watermark. Retain only a
 * domain-separated workspace fingerprint and ordering metadata until every JWT
 * which could predate that deletion has necessarily expired.
 */
export const LIFECYCLE_LINEAGE_RETENTION_SECONDS =
  MAX_LIFECYCLE_AGE_SECONDS + 2 * LIFECYCLE_CLOCK_SKEW_SECONDS + 1;

export type LifecycleAuthorityState = "active" | "inactive" | "deleted";

export function hashLifecycleWorkspace(workspaceId: string): string {
  return createHash("sha256")
    .update("ai-assistant:lifecycle-workspace-lineage:v1\n")
    .update(workspaceId)
    .digest("hex");
}

export function lifecycleLineageExpiresAt(now: Date): string {
  return new Date(
    now.getTime() + LIFECYCLE_LINEAGE_RETENTION_SECONDS * 1000,
  ).toISOString();
}
