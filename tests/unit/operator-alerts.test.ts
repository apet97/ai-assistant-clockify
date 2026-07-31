import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  classifySqliteFailure,
  createReadinessAlertMonitor,
  logSqliteUnavailable,
} from "../../src/readiness-alerts.js";
import {
  RETENTION_PRUNE_FAILURE_THRESHOLD,
  createRetentionAlertMonitor,
} from "../../src/retention-alerts.js";
import {
  SUSTAINED_HOST_CONSECUTIVE_THRESHOLD,
  SUSTAINED_HOST_WINDOW_MS,
  SUSTAINED_HOST_WINDOW_THRESHOLD,
  createHostThrottleMonitor,
} from "../../src/clockify/host-throttle-monitor.js";
import { MAX_GET_RETRIES } from "../../src/clockify/rest/core.js";
import { logArtifactOversizeRejected } from "../../src/log-artifact-oversize.js";

/**
 * D3: the emitters behind `DEPLOYMENT.md` "Required alerts" rows 1, 3, 4, 6 and
 * 8. Every documented alert needs a line that actually fires, and every
 * threshold word ("repeated", "sustained") needs a number that fires at N and
 * not at N-1 — an alert nobody can trigger is worse than no alert, because the
 * runbook promises it.
 */
function capture(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = [];
  return { lines, log: (line) => lines.push(line) };
}

describe("readiness alerts (row 1) + SQLite classification (row 4)", () => {
  it("classifies a REAL better-sqlite3 read-only failure, not a parsed message", () => {
    // Ground truth over assumption: drive the actual driver. `query_only`
    // reproduces the read-only VOLUME case (a restored/remounted /data) without
    // needing one.
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    db.prepare("INSERT INTO t (id, v) VALUES (1, 'x')").run();
    db.pragma("query_only = 1");
    let thrown: unknown;
    try {
      db.prepare("UPDATE t SET v = ? WHERE id = 1").run("y");
    } catch (error) {
      thrown = error;
    } finally {
      db.close();
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(classifySqliteFailure(thrown)).toBe("readonly");
  });

  it("classifies primary AND extended result codes, and nothing else", () => {
    // better-sqlite3 12.x returns the EXTENDED code where SQLite has one
    // (`SQLITE_CONSTRAINT_PRIMARYKEY` observed live), so a locked-page BUSY or a
    // moved-database READONLY must classify like its primary code instead of
    // silently falling through to "unclassified" and losing the alert.
    expect(classifySqliteFailure(Object.assign(new Error("x"), { code: "SQLITE_BUSY" }))).toBe("busy");
    expect(classifySqliteFailure(Object.assign(new Error("x"), { code: "SQLITE_BUSY_SNAPSHOT" }))).toBe("busy");
    expect(classifySqliteFailure(Object.assign(new Error("x"), { code: "SQLITE_FULL" }))).toBe("full");
    expect(classifySqliteFailure(Object.assign(new Error("x"), { code: "SQLITE_READONLY" }))).toBe("readonly");
    expect(classifySqliteFailure(Object.assign(new Error("x"), { code: "SQLITE_READONLY_DBMOVED" }))).toBe("readonly");
    // Not a storage failure: no code, an unrelated code, or a non-error.
    expect(classifySqliteFailure(new Error("database is locked"))).toBeUndefined();
    expect(classifySqliteFailure(Object.assign(new Error("x"), { code: "SQLITE_CONSTRAINT" }))).toBeUndefined();
    expect(classifySqliteFailure("SQLITE_BUSY")).toBeUndefined();
    expect(classifySqliteFailure(undefined)).toBeUndefined();
  });

  it("emits the storage line with the CLASSIFICATION and the site, never a message", () => {
    const { lines, log } = capture();
    logSqliteUnavailable({ kind: "full", site: "request", log });
    expect(lines).toEqual(["[storage] event=sqlite_unavailable kind=full site=request"]);
  });

  it("alerts once per readiness state, so a 5s platform poller cannot burst", () => {
    const { lines, log } = capture();
    const monitor = createReadinessAlertMonitor({ log });
    expect(monitor.notReady("draining")).toBe(true);
    expect(monitor.notReady("draining")).toBe(false);
    expect(monitor.notReady("draining")).toBe(false);
    expect(lines).toEqual(["[readiness] event=not_ready cause=draining"]);
  });

  it("re-alerts when the CAUSE changes (draining is benign, a full disk is not)", () => {
    const { lines, log } = capture();
    const monitor = createReadinessAlertMonitor({ log });
    monitor.notReady("draining");
    expect(monitor.notReady("sqlite_full")).toBe(true);
    expect(lines).toEqual([
      "[readiness] event=not_ready cause=draining",
      "[readiness] event=not_ready cause=sqlite_full",
    ]);
  });

  it("closes the alert on recovery, and stays silent when it never fired", () => {
    const { lines, log } = capture();
    const monitor = createReadinessAlertMonitor({ log });
    monitor.ready();
    monitor.ready();
    expect(lines).toEqual([]);
    monitor.notReady("sqlite_readonly");
    monitor.ready();
    monitor.ready();
    expect(lines).toEqual([
      "[readiness] event=not_ready cause=sqlite_readonly",
      "[readiness] event=ready_recovered",
    ]);
    // A fresh failure after recovery alerts again — recovery is not a mute.
    monitor.notReady("sqlite_readonly");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("[readiness] event=not_ready cause=sqlite_readonly");
  });
});

describe("retention alerts (row 3)", () => {
  it("fires the repeated-failure alert at the threshold, not before", () => {
    const { lines, log } = capture();
    const monitor = createRetentionAlertMonitor({ log });
    for (let i = 1; i < RETENTION_PRUNE_FAILURE_THRESHOLD; i += 1) {
      monitor.failed();
      expect(lines).toEqual([]);
    }
    monitor.failed();
    expect(lines).toEqual([
      `[retention] event=prune_failing_repeatedly consecutive=${RETENTION_PRUNE_FAILURE_THRESHOLD}`,
    ]);
  });

  it("alerts exactly once per streak, so an hourly failure loop is not a log flood", () => {
    const { lines, log } = capture();
    const monitor = createRetentionAlertMonitor({ log });
    for (let i = 0; i < RETENTION_PRUNE_FAILURE_THRESHOLD + 5; i += 1) monitor.failed();
    expect(lines).toHaveLength(1);
  });

  it("resets the streak on a successful sweep and alerts again on a fresh one", () => {
    const { lines, log } = capture();
    const monitor = createRetentionAlertMonitor({ log });
    for (let i = 1; i < RETENTION_PRUNE_FAILURE_THRESHOLD; i += 1) monitor.failed();
    monitor.swept({ backlog: false, batches: 1 });
    expect(lines).toEqual([]);
    for (let i = 1; i < RETENTION_PRUNE_FAILURE_THRESHOLD; i += 1) monitor.failed();
    expect(lines).toEqual([]);
    monitor.failed();
    expect(lines).toHaveLength(1);
  });

  it("alerts on entering a backlog once, not once per continuation pass", () => {
    const { lines, log } = capture();
    const monitor = createRetentionAlertMonitor({ log });
    monitor.swept({ backlog: true, batches: 500 });
    monitor.swept({ backlog: true, batches: 500 });
    monitor.swept({ backlog: true, batches: 500 });
    expect(lines).toEqual(["[retention] event=prune_backlog_started batches=500"]);
    monitor.swept({ backlog: false, batches: 12 });
    expect(lines).toEqual([
      "[retention] event=prune_backlog_started batches=500",
      "[retention] event=prune_backlog_cleared",
    ]);
  });

  it("stays silent for ordinary clean sweeps", () => {
    const { lines, log } = capture();
    const monitor = createRetentionAlertMonitor({ log });
    monitor.swept({ backlog: false, batches: 0 });
    monitor.swept({ backlog: false, batches: 3 });
    expect(lines).toEqual([]);
  });
});

describe("sustained Clockify throttling (row 6)", () => {
  const aliasFor = (workspaceId: string): string => `ws-alias-${workspaceId.slice(-2)}`;
  /** Controllable clock so the rolling window is tested, not slept through. */
  function windowed(): { lines: string[]; monitor: ReturnType<typeof createHostThrottleMonitor>; advance: (ms: number) => void } {
    const { lines, log } = capture();
    let clock = 1_000_000;
    const monitor = createHostThrottleMonitor({ aliasFor, log, now: () => clock });
    return { lines, monitor, advance: (ms) => { clock += ms; } };
  }

  it("sets the fast-trip strictly above one request's maximum retry chain", () => {
    // One GET produces at most 1 + MAX_GET_RETRIES throttled observations. If the
    // fast-trip were <= that, a single blip that merely exhausted its own retries
    // would page an operator; above it, a SECOND failing request is required.
    expect(SUSTAINED_HOST_CONSECUTIVE_THRESHOLD).toBeGreaterThan(1 + MAX_GET_RETRIES);
    // The window must need more than the fast-trip, or it is the same alert.
    expect(SUSTAINED_HOST_WINDOW_THRESHOLD).toBeGreaterThan(SUSTAINED_HOST_CONSECUTIVE_THRESHOLD);
  });

  it("DETECTS A PARTIAL OUTAGE: alternating success/failure still alerts", () => {
    // The defect this pins: a consecutive-only streak that any success resets
    // can never fire on a 50% degradation — the ordinary partial-outage shape,
    // and the one an operator most needs to hear about. The rolling window must
    // fire even though no two failures are ever adjacent.
    const { lines, monitor, advance } = windowed();
    for (let i = 0; i < SUSTAINED_HOST_WINDOW_THRESHOLD; i += 1) {
      monitor.throttled("64ad1305c701cc5be7c26fe4", 503);
      monitor.healthy("64ad1305c701cc5be7c26fe4");
      advance(1_000);
    }
    expect(lines).toEqual([
      `[clockify-host] event=host_throttled_sustained workspace=ws-alias-e4 status=503 trigger=window count=${SUSTAINED_HOST_WINDOW_THRESHOLD} windowMs=${SUSTAINED_HOST_WINDOW_MS}`,
    ]);
  });

  it("does not fire when the same failure count is spread beyond the window", () => {
    const { lines, monitor, advance } = windowed();
    // Same total failures, but each one ages out before the next arrives.
    for (let i = 0; i < SUSTAINED_HOST_WINDOW_THRESHOLD * 2; i += 1) {
      monitor.throttled("ws-aa", 503);
      monitor.healthy("ws-aa");
      advance(SUSTAINED_HOST_WINDOW_MS + 1);
    }
    expect(lines).toEqual([]);
  });

  it("fast-trips on a consecutive run, at the threshold and not at N-1", () => {
    const { lines, monitor } = windowed();
    for (let i = 1; i < SUSTAINED_HOST_CONSECUTIVE_THRESHOLD; i += 1) {
      monitor.throttled("64ad1305c701cc5be7c26fe4", 429);
      expect(lines).toEqual([]);
    }
    monitor.throttled("64ad1305c701cc5be7c26fe4", 503);
    expect(lines).toEqual([
      `[clockify-host] event=host_throttled_sustained workspace=ws-alias-e4 status=503 trigger=consecutive count=${SUSTAINED_HOST_CONSECUTIVE_THRESHOLD}`,
    ]);
  });

  it("alerts once per condition during an UNBROKEN run of failures", () => {
    const { lines, monitor } = windowed();
    for (let i = 0; i < SUSTAINED_HOST_WINDOW_THRESHOLD * 3; i += 1) monitor.throttled("ws-aa", 429);
    // One fast-trip line and one window line — not one per response. Note this
    // case never calls healthy(), so on its own it does NOT prove the latch;
    // the interleaved test below is the one that does.
    expect(lines).toHaveLength(2);
    expect(lines.filter((line) => line.includes("trigger=consecutive"))).toHaveLength(1);
    expect(lines.filter((line) => line.includes("trigger=window"))).toHaveLength(1);
  });

  it("does NOT re-fire the fast-trip every time four failures happen to land in a row", () => {
    // The defect this pins: `healthy()` zeroes the streak, so without a latch a
    // partial outage re-fires the fast-trip on every run of four — measured at
    // ~600 lines/hour with 2-of-3 GETs failing at 30 req/min, ~4,000/hour at
    // 200 req/min. Flooding the log during the incident it reports is worse
    // than staying silent.
    const { lines, monitor, advance } = windowed();
    // 20 rounds of "four failures then one success", well past the fast-trip.
    for (let round = 0; round < 20; round += 1) {
      for (let i = 0; i < SUSTAINED_HOST_CONSECUTIVE_THRESHOLD; i += 1) {
        monitor.throttled("ws-aa", 503);
        advance(100);
      }
      monitor.healthy("ws-aa");
      advance(100);
    }
    expect(lines.filter((line) => line.includes("trigger=consecutive"))).toHaveLength(1);
    // The window trigger latches too: one line, not one per crossing.
    expect(lines.filter((line) => line.includes("trigger=window"))).toHaveLength(1);
    expect(lines).toHaveLength(2);
  });

  it("re-arms the fast-trip only after the window drains, not on one good response", () => {
    const { lines, monitor, advance } = windowed();
    for (let i = 0; i < SUSTAINED_HOST_CONSECUTIVE_THRESHOLD; i += 1) monitor.throttled("ws-aa", 429);
    expect(lines).toHaveLength(1);
    // One healthy response is NOT recovery — the failures are still in-window.
    monitor.healthy("ws-aa");
    for (let i = 0; i < SUSTAINED_HOST_CONSECUTIVE_THRESHOLD; i += 1) monitor.throttled("ws-aa", 429);
    expect(lines).toHaveLength(1);
    // Sustained health: the whole window passes with no failure at all.
    advance(SUSTAINED_HOST_WINDOW_MS + 1);
    monitor.healthy("ws-aa");
    for (let i = 0; i < SUSTAINED_HOST_CONSECUTIVE_THRESHOLD; i += 1) monitor.throttled("ws-aa", 429);
    expect(lines).toHaveLength(2);
  });

  it("re-arms after recovery, so a second outage is not swallowed", () => {
    const { lines, monitor, advance } = windowed();
    for (let i = 0; i < SUSTAINED_HOST_CONSECUTIVE_THRESHOLD; i += 1) monitor.throttled("ws-aa", 429);
    expect(lines).toHaveLength(1);
    monitor.healthy("ws-aa");
    advance(SUSTAINED_HOST_WINDOW_MS + 1);
    monitor.healthy("ws-aa");
    for (let i = 0; i < SUSTAINED_HOST_CONSECUTIVE_THRESHOLD; i += 1) monitor.throttled("ws-aa", 429);
    expect(lines).toHaveLength(2);
  });

  it("counts per workspace, so two half-storms never add up to a false alert", () => {
    const { lines, monitor } = windowed();
    for (let i = 0; i < SUSTAINED_HOST_CONSECUTIVE_THRESHOLD; i += 1) {
      monitor.throttled(i % 2 === 0 ? "ws-aa" : "ws-bb", 429);
    }
    expect(lines).toEqual([]);
  });
});

describe("artifact oversize rejects (row 8)", () => {
  it("emits the size and the limit, and omits an unknown size rather than guessing", () => {
    const { lines, log } = capture();
    logArtifactOversizeRejected({ site: "persist", limitBytes: 1_000_000, bytes: 1_048_577, log });
    logArtifactOversizeRejected({ site: "download", limitBytes: 1_000_000, log });
    expect(lines).toEqual([
      "[storage] event=artifact_oversize_rejected site=persist limit=1000000 bytes=1048577",
      "[storage] event=artifact_oversize_rejected site=download limit=1000000",
    ]);
  });
});
