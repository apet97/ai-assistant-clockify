/**
 * Operator alerts for the readiness probe and the storage failures behind it
 * (D3; `DEPLOYMENT.md` "Required alerts" rows 1 and 4).
 *
 * These two live in ONE module because they are one question. `/health`'s only
 * substantive check is `store.healthCheck()` — a bounded COMMITTED SQLite write
 * — so a readiness failure that is not a drain IS a storage failure, and the
 * readiness `cause=` is literally the SQLite classification. Before this, the
 * probe's `catch {}` returned 503 and logged nothing at all: a container could
 * be rotated out of service repeatedly, for a full or read-only volume, and the
 * only evidence anywhere was the platform's own restart count.
 *
 * Two deliberate properties:
 *
 * - The line carries the CLASSIFICATION, never `err.message`. A better-sqlite3
 *   message quotes the failing SQL, which on this schema means customer row
 *   values and ciphertext. Classification is read from the driver's `code` only.
 * - The readiness alert fires on a STATE CHANGE, not per probe. Railway polls
 *   `/health` on a seconds-scale interval, so a per-probe line would turn a
 *   10-second drain into a burst and a genuinely stuck volume into an unbounded
 *   flood — the two moments an operator most needs a readable log.
 *
 * Neither emitter takes a workspace: the readiness probe is public, unauthenticated,
 * and process-wide, so there is no workspace or admin in scope to alias (and none
 * is threaded in merely to log).
 */

/** The three SQLite conditions `DEPLOYMENT.md` names, and nothing else. */
export type SqliteFailureKind = "busy" | "full" | "readonly";

/** Where the failure was observed. Both seams share one classifier. */
export type SqliteFailureSite = "readiness" | "request";

/**
 * Primary SQLite result codes, mapped to the alert's vocabulary. Matched as a
 * PREFIX because better-sqlite3 returns the EXTENDED code wherever SQLite
 * defines one — verified live against the pinned 12.10.0 driver, which answers
 * `SQLITE_CONSTRAINT_PRIMARYKEY` for a duplicate key while answering the bare
 * `SQLITE_BUSY` / `SQLITE_READONLY` for the two conditions reproduced in the
 * test. An extended form (`SQLITE_BUSY_SNAPSHOT`, `SQLITE_READONLY_DBMOVED`)
 * must classify like its primary code instead of falling through and losing the
 * alert exactly when the failure is most unusual.
 */
const SQLITE_CODE_PREFIXES: ReadonlyArray<readonly [string, SqliteFailureKind]> = [
  ["SQLITE_BUSY", "busy"],
  ["SQLITE_FULL", "full"],
  ["SQLITE_READONLY", "readonly"],
];

/**
 * Classify a thrown store error from the driver's `code` ONLY.
 *
 * The message is never inspected: it is attacker- and data-influenced text, and
 * a substring match on it ("database is locked") would both leak and lie — a
 * caller-supplied string can contain that phrase without any lock existing.
 * Anything unrecognized returns `undefined` and is reported as a generic
 * storage error rather than being misfiled under a specific alert.
 */
export function classifySqliteFailure(error: unknown): SqliteFailureKind | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") return undefined;
  for (const [prefix, kind] of SQLITE_CODE_PREFIXES) {
    if (code === prefix || code.startsWith(`${prefix}_`)) return kind;
  }
  return undefined;
}

export function logSqliteUnavailable(input: {
  kind: SqliteFailureKind;
  site: SqliteFailureSite;
  log?: (line: string) => void;
}): void {
  const log = input.log ?? ((line: string) => console.warn(line));
  log(`[storage] event=sqlite_unavailable kind=${input.kind} site=${input.site}`);
}

/**
 * Why readiness failed. `draining` is the expected, benign deploy case;
 * `sqlite_*` is a classified storage failure; `storage_error` is a
 * `healthCheck()` throw the driver did not label (so the specific alert must
 * NOT claim a cause it cannot prove).
 */
export type ReadinessFailureCause = "draining" | "storage_error" | `sqlite_${SqliteFailureKind}`;

export interface ReadinessAlertMonitor {
  /**
   * Record a failed probe. Returns true when this is a NEW state — the caller
   * uses that to keep companion lines (the storage classification) on the same
   * crossing instead of once per poll.
   */
  notReady(cause: ReadinessFailureCause): boolean;
  /** Record a passing probe; closes an open alert exactly once. */
  ready(): void;
}

export function createReadinessAlertMonitor(input: { log?: (line: string) => void } = {}): ReadinessAlertMonitor {
  const log = input.log ?? ((line: string) => console.warn(line));
  // undefined = ready. Holding the CAUSE (not a boolean) means a drain that
  // turns into a real storage failure re-alerts instead of hiding behind the
  // benign state that happened to be reported first.
  let openCause: ReadinessFailureCause | undefined;
  return {
    notReady(cause) {
      if (openCause === cause) return false;
      openCause = cause;
      log(`[readiness] event=not_ready cause=${cause}`);
      return true;
    },
    ready() {
      if (openCause === undefined) return;
      openCause = undefined;
      log("[readiness] event=ready_recovered");
    },
  };
}
