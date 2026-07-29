/**
 * Suspect-authority alerting for repeated installation-token rejections (F15).
 *
 * When Clockify answers an authenticated request with 401 the installation's
 * persisted authority and external reality may disagree — but ONE transient
 * response proves nothing, and authority must NEVER change automatically from
 * a wire signal. This monitor only counts CONSECUTIVE token rejections per
 * workspace and emits one aliased operator alert when a streak crosses the
 * threshold; a later accepted response resets the streak (and a repeat streak
 * alerts again). Retiring the row is a separate, deliberate operator act
 * through `scripts/maintenance/retire-stale-installation.ts`.
 *
 * Family-restriction 401s ("API is not accessible" — endpoints the add-on
 * token class can never call) are excluded at the observation seam in
 * RestCore, so blocked-endpoint probes cannot masquerade as a dying token.
 */
export interface TokenRejectionMonitor {
  /** An authenticated Clockify response rejected the installation token. */
  rejected(workspaceId: string): void;
  /** An authenticated Clockify response accepted the installation token. */
  accepted(workspaceId: string): void;
}

export const TOKEN_REJECTION_SUSPECT_THRESHOLD = 3;

export function createTokenRejectionMonitor(input: {
  /** Privacy alias for the log line — the raw workspace id is never logged. */
  aliasFor: (workspaceId: string) => string;
  threshold?: number;
  log?: (line: string) => void;
}): TokenRejectionMonitor {
  const threshold = input.threshold ?? TOKEN_REJECTION_SUSPECT_THRESHOLD;
  const log = input.log ?? ((line: string) => console.warn(line));
  const streaks = new Map<string, number>();
  return {
    rejected(workspaceId) {
      const streak = (streaks.get(workspaceId) ?? 0) + 1;
      streaks.set(workspaceId, streak);
      // Exactly one alert per streak: at the crossing, not on every rejection.
      if (streak === threshold) {
        log(
          `[install-authority] event=token_rejected_suspect workspace=${input.aliasFor(workspaceId)} consecutive=${streak}`,
        );
      }
    },
    accepted(workspaceId) {
      streaks.delete(workspaceId);
    },
  };
}
