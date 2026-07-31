import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createShutdownHandler } from "../../src/server.js";
import { createReadinessAlertMonitor, logSqliteUnavailable } from "../../src/readiness-alerts.js";
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
import { logOutcomeUnknown, logOutcomeUnknownRecovered } from "../../src/log-outcome-unknown.js";
import {
  OPERATOR_HEALTH_PHASES,
  OPERATOR_HEALTH_SNAPSHOT_INTERVAL_MS,
  createOperatorHealthSnapshotEmitter,
  type OperatorHealthCounts,
  type OperatorHealthPhase,
} from "../../src/operator-health.js";
import { logArtifactOversizeRejected } from "../../src/log-artifact-oversize.js";
import { createTokenRejectionMonitor } from "../../src/clockify/token-rejection-monitor.js";
import { createModelClient } from "../../src/assistant/model-client.js";

/**
 * D3: `DEPLOYMENT.md` "Required alerts" promises an operator a set of greppable
 * strings. A documented string that no code emits is WORSE than no alert — the
 * operator configures it, it never fires, and the silence reads as health.
 *
 * So this test does not check prose against prose. For every documented row it
 * INVOKES THE REAL EMITTER and asserts the produced line carries the documented
 * match string. Renaming an event, retagging a subsystem, or deleting an emitter
 * fails here instead of silently orphaning the alert.
 *
 * Three strings cannot be invoked: they are literal arguments to `console.error`
 * inside `process.once("uncaughtException"| "unhandledRejection")` and the
 * module-scope `start().catch` — installing those in a test would hijack the
 * runner's own fatal handling. They are pinned by SOURCE instead, with the
 * tighter rule that the string must sit on a line that also contains `console.`,
 * so a match cannot be satisfied by a comment.
 */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DOC = readFileSync(`${REPO_ROOT}DEPLOYMENT.md`, "utf8");

const SOURCE_PINNED = new Set(["unhandledRejection:", "uncaughtException:", "startup failed:"]);

interface AlertRow {
  number: number;
  condition: string;
  matches: string[];
  emitters: string[];
  companions: string[];
}

function backticked(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
}

function parseRows(): AlertRow[] {
  const section = /\n## Required alerts\n([\s\S]*?)\n## /.exec(DOC)?.[1];
  if (section === undefined) throw new Error("DEPLOYMENT.md has no '## Required alerts' section");
  const rows: AlertRow[] = [];
  for (const line of section.split("\n")) {
    const cells = /^\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|$/.exec(line);
    if (!cells) continue;
    const number = Number(cells[1]!.trim());
    if (!Number.isInteger(number)) continue; // header / separator row
    rows.push({
      number,
      condition: cells[2]!.trim(),
      matches: backticked(cells[3]!),
      emitters: backticked(cells[4]!),
      companions: backticked(cells[5]!),
    });
  }
  return rows;
}

const ROWS = parseRows();

/**
 * Lines each row's emitters really produce, from the real functions. `undefined`
 * marks a row whose strings are source-pinned (see the file header).
 */
function producedLines(row: number): string[] {
  const lines: string[] = [];
  const log = (line: string): void => void lines.push(line);
  switch (row) {
    case 1: {
      const monitor = createReadinessAlertMonitor({ log });
      monitor.notReady("sqlite_busy");
      monitor.ready();
      return lines;
    }
    case 2: {
      // Only the draining line is invocable; the three fatal-exit strings are
      // source-pinned. An injected exit/close keeps the runner alive.
      createShutdownHandler({
        server: { close: (cb) => { cb(); } },
        store: { close: () => undefined },
        exit: () => undefined,
        log,
      })("SIGTERM");
      return lines;
    }
    case 3: {
      const monitor = createRetentionAlertMonitor({ log });
      monitor.swept({ backlog: true, batches: 500 });
      monitor.swept({ backlog: false, batches: 1 });
      for (let i = 0; i < RETENTION_PRUNE_FAILURE_THRESHOLD; i += 1) monitor.failed();
      return lines;
    }
    case 4: {
      logSqliteUnavailable({ kind: "busy", site: "request", log });
      logSqliteUnavailable({ kind: "full", site: "readiness", log });
      logSqliteUnavailable({ kind: "readonly", site: "readiness", log });
      return lines;
    }
    case 5: {
      logOutcomeUnknown({ action: "clockify_tags_create", operationId: "op-1", log });
      logOutcomeUnknownRecovered({ steps: 1, operations: 1, log });
      return lines;
    }
    case 6: {
      // Enough to trip BOTH triggers, so each line shape is checked against the doc.
      const monitor = createHostThrottleMonitor({ aliasFor: () => "ws-aliasedvalue", log });
      for (let i = 0; i < SUSTAINED_HOST_WINDOW_THRESHOLD; i += 1) monitor.throttled("ws", 429);
      return lines;
    }
    case 8: {
      logArtifactOversizeRejected({ site: "persist", limitBytes: 1_000_000, bytes: 2_000_000, log });
      return lines;
    }
    case 9: {
      const monitor = createTokenRejectionMonitor({ aliasFor: () => "ws-aliasedvalue", log });
      for (let i = 0; i < 3; i += 1) monitor.rejected("ws");
      return lines;
    }
    case 10: {
      // Both shapes, so the heartbeat AND its degraded form are checked against
      // the doc. Every count is 1 rather than 0 so a formatter that dropped a
      // field could not be mistaken for an idle fleet.
      const emitter = createOperatorHealthSnapshotEmitter({ log });
      emitter.emit({
        windowMs: OPERATOR_HEALTH_SNAPSHOT_INTERVAL_MS,
        counts: {
          runsStarted: 1, runsCompleted: 1, runsFailed: 1,
          budgetDeniedTools: 1, budgetDeniedRuns: 1,
          inFlight: OPERATOR_HEALTH_PHASES.length,
          inFlightByPhase: Object.fromEntries(
            OPERATOR_HEALTH_PHASES.map((phase) => [phase, 1]),
          ) as Record<OperatorHealthPhase, number>,
          stalled: 1, outcomeUnknown: 1, outcomeUnknownUnreconciled: 1, retentionBacklog: true,
        } satisfies OperatorHealthCounts,
      });
      emitter.unavailable();
      return lines;
    }
    default:
      throw new Error(`no invocation registered for alert row ${row}`);
  }
}

/** Row 7's emitter writes straight to console.warn, so capture that instead. */
async function producedProviderLines(): Promise<string[]> {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const client = createModelClient({
    baseUrl: "https://provider.invalid/v1/chat/completions",
    apiKey: "test-key",
    model: "test-model",
    sleepImpl: async () => undefined,
    fetchImpl: async () => new Response("upstream exploded", { status: 503 }),
  });
  await expect(client.complete([{ role: "user", content: "hi" }])).rejects.toThrow();
  return warn.mock.calls.map((call) => call.map(String).join(" "));
}

afterEach(() => vi.restoreAllMocks());

describe("DEPLOYMENT.md required-alert contract", () => {
  it("parses a complete, well-formed table (a silently empty parse would pass everything)", () => {
    expect(ROWS.length).toBeGreaterThanOrEqual(9);
    expect(ROWS.map((row) => row.number)).toEqual(ROWS.map((_row, index) => index + 1));
    for (const row of ROWS) {
      expect(row.condition.length, `row ${row.number} condition`).toBeGreaterThan(0);
      expect(row.matches.length, `row ${row.number} match strings`).toBeGreaterThan(0);
      expect(row.emitters.length, `row ${row.number} emitters`).toBeGreaterThan(0);
      for (const match of row.matches) {
        // A bare tag would alert on unrelated lines from the same subsystem.
        expect(match.trim(), `row ${row.number} match "${match}"`).toBe(match);
        expect(match.length, `row ${row.number} match "${match}"`).toBeGreaterThan(6);
      }
    }
  });

  it("keeps every documented emitter path real", () => {
    for (const row of ROWS) {
      for (const path of row.emitters) {
        expect(() => readFileSync(`${REPO_ROOT}${path}`, "utf8"), `row ${row.number} ${path}`).not.toThrow();
      }
    }
  });

  it("keeps match strings mutually unambiguous", () => {
    const all = ROWS.flatMap((row) => row.matches.map((match) => ({ match, row: row.number })));
    for (const a of all) {
      for (const b of all) {
        if (a === b) continue;
        // One alert's string must never be a prefix of another's, or a single
        // grep silently fires for two different conditions.
        expect(
          b.match.startsWith(a.match),
          `alert ${a.row} match "${a.match}" is a prefix of alert ${b.row} match "${b.match}"`,
        ).toBe(false);
      }
    }
  });

  it("finds every documented match string in its documented emitter source", () => {
    for (const row of ROWS) {
      const sources = row.emitters.map((path) => readFileSync(`${REPO_ROOT}${path}`, "utf8"));
      for (const match of row.matches) {
        const hit = sources.some((source) => source.includes(match));
        expect(hit, `alert ${row.number}: "${match}" is in no emitter listed for it`).toBe(true);
        if (!SOURCE_PINNED.has(match)) continue;
        // Tighter rule for the three uninvocable process handlers: the string
        // must be on a line that also calls console, so prose cannot satisfy it.
        const emitted = sources.some((source) =>
          source.split("\n").some((line) => line.includes(match) && line.includes("console.")),
        );
        expect(emitted, `alert ${row.number}: "${match}" appears only as prose`).toBe(true);
      }
    }
  });

  it("produces every documented match string by RUNNING the emitter", async () => {
    for (const row of ROWS) {
      const invocable = row.matches.filter((match) => !SOURCE_PINNED.has(match));
      if (invocable.length === 0) continue;
      const lines = row.number === 7 ? await producedProviderLines() : producedLines(row.number);
      expect(lines.length, `alert ${row.number} emitted nothing`).toBeGreaterThan(0);
      for (const match of invocable) {
        expect(
          lines.some((line) => line.includes(match)),
          `alert ${row.number}: nothing emitted "${match}" — emitted ${JSON.stringify(lines)}`,
        ).toBe(true);
      }
    }
  });

  it("documents every line those emitters produce (no undocumented event)", async () => {
    for (const row of ROWS) {
      const lines = row.number === 7 ? await producedProviderLines() : producedLines(row.number);
      const known = [...row.matches, ...row.companions];
      for (const line of lines) {
        expect(
          known.some((token) => line.includes(token)),
          `alert ${row.number} emitted "${line}" but neither its match strings nor its `
          + "suppression note mention it — document it or the operator sees an unexplained line",
        ).toBe(true);
      }
    }
  });

  it("pins the 'repeated' and 'sustained' thresholds to the exported constants", () => {
    const documented = (name: string): number => {
      // `12` and `60_000` both appear; the underscore form is accepted so the
      // doc can stay readable without letting the pin match a stray number.
      const found = new RegExp(`\`${name}\`\\s*=\\s*([\\d_]+)`).exec(DOC);
      if (!found) throw new Error(`DEPLOYMENT.md never states \`${name}\` = <number>`);
      return Number(found[1]!.replace(/_/g, ""));
    };
    expect(documented("RETENTION_PRUNE_FAILURE_THRESHOLD")).toBe(RETENTION_PRUNE_FAILURE_THRESHOLD);
    expect(documented("SUSTAINED_HOST_CONSECUTIVE_THRESHOLD")).toBe(SUSTAINED_HOST_CONSECUTIVE_THRESHOLD);
    expect(documented("SUSTAINED_HOST_WINDOW_THRESHOLD")).toBe(SUSTAINED_HOST_WINDOW_THRESHOLD);
    expect(documented("SUSTAINED_HOST_WINDOW_MS")).toBe(SUSTAINED_HOST_WINDOW_MS);
  });
});
