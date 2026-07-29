import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

/**
 * F24: the ADR-001 fresh-database boundary, enforced at BOOT. A deploy that
 * claims `DATABASE_PATH_DISPOSITION=new_unused` must be pointing at a path
 * that has never held data: the 2026-07-27 cutover violated the accepted ADR
 * by reusing the v1 production database in place, and nothing at runtime
 * could have refused it. Now it can.
 *
 * Freshness proof: a genuinely fresh path either does not exist yet or is an
 * empty file. The FIRST successful boot under `new_unused` writes a sidecar
 * marker (`<db>.fresh-cutover.json`) recording that this path was born under
 * the fresh boundary — later restarts of the same deployment find the marker
 * and boot normally. A nonempty database with NO marker (e.g. the retained v1
 * database) can never be claimed `new_unused`; the process refuses to start
 * before opening it. `existing_expected` and absent dispositions change
 * nothing.
 */
export function freshCutoverMarkerPath(databasePath: string): string {
  return `${databasePath}.fresh-cutover.json`;
}

export interface FreshBoundaryVerdict {
  /** True exactly when this boot is creating the fresh path (write the marker
   * after the store opens successfully). */
  firstBoot: boolean;
}

export function assertFreshDatabaseBoundary(
  databasePath: string,
  disposition: "new_unused" | "existing_expected" | undefined,
): FreshBoundaryVerdict {
  if (disposition !== "new_unused" || databasePath === ":memory:") {
    return { firstBoot: false };
  }
  if (!existsSync(databasePath) || statSync(databasePath).size === 0) {
    return { firstBoot: true };
  }
  const markerPath = freshCutoverMarkerPath(databasePath);
  if (existsSync(markerPath)) {
    try {
      JSON.parse(readFileSync(markerPath, "utf8"));
      return { firstBoot: false };
    } catch {
      // fall through to the refusal: a corrupt marker proves nothing.
    }
  }
  throw new Error(
    "database_path_not_fresh: DATABASE_PATH_DISPOSITION=new_unused but the "
      + "database file already contains data and carries no fresh-cutover marker. "
      + "The ADR-001 v2 boundary requires a previously unused path — refusing to boot.",
  );
}

/** Record that the fresh path was born under the `new_unused` boundary. */
export function writeFreshCutoverMarker(
  databasePath: string,
  identity: { releaseSha?: string; createdAt: string },
): void {
  writeFileSync(
    freshCutoverMarkerPath(databasePath),
    `${JSON.stringify({ bornDisposition: "new_unused", ...identity }, null, 2)}\n`,
  );
}
