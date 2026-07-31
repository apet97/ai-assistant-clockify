import { describe, expect, it, vi } from "vitest";
import {
  createLiveClockifyFactory,
  createRetentionPruneLoop,
} from "../../src/server.js";
import type { RestWorkspaceOptions } from "../../src/clockify/rest-workspace.js";
import type { WorkspaceClient } from "../../src/clockify/client.js";
import type { Installation } from "../../src/db/store.js";
import type { PruneCounts } from "../../src/db/store.js";
import {
  SUSTAINED_HOST_CONSECUTIVE_THRESHOLD,
  createHostThrottleMonitor,
} from "../../src/clockify/host-throttle-monitor.js";
import { createTokenRejectionMonitor } from "../../src/clockify/token-rejection-monitor.js";
import {
  RETENTION_PRUNE_FAILURE_THRESHOLD,
  createRetentionAlertMonitor,
} from "../../src/retention-alerts.js";

/**
 * An emitter that production never calls is an alert that can never fire, and
 * unit-testing the emitter proves nothing about that.
 *
 * This gap was real: a mutation battery deleted `alerts.swept()`,
 * `alerts.failed()` and the throttle monitor's argument SIMULTANEOUSLY and the
 * whole suite still passed, because both lived inside `start()` — which loads
 * env config, opens a real database, verifies the release artifact and listens,
 * so no test can import it.
 *
 * The fix has two halves, and this file is the second:
 *   1. The monitors are now REQUIRED fields of both factories, so dropping one
 *      at the `start()` call site is a type error rather than a silent hole.
 *   2. Everything below the call site — the composition that actually reaches
 *      the emitters — is exercised here through the exported factories.
 */
function counts(overrides: Partial<PruneCounts> = {}): PruneCounts {
  return {
    pendingConfirmations: 0, idempotencyKeys: 0, undoRecords: 0, turnTelemetry: 0,
    chatMessages: 0, auditEvents: 0, artifacts: 0, operationSteps: 0, operationRuns: 0,
    intentCapabilities: 0, actionResults: 0, turnRuns: 0, assistantRuns: 0, chatSessions: 0,
    retentionRuns: 0, expiredConfirmations: 0, expiredConfirmationBatches: 0,
    expiredUndoRecords: 0, expiredClarifications: 0, deletedTotal: 0, expiredTotal: 0,
    total: 0, batches: 0, durationMs: 0, backlog: false,
    walCheckpoint: { mode: "PASSIVE", busy: 0, log: 0, checkpointed: 0 },
    ...overrides,
  };
}

describe("retention prune loop reaches the alert emitters (row 3)", () => {
  it("emits the backlog alert from a real sweep result", async () => {
    const lines: string[] = [];
    const prune = createRetentionPruneLoop({
      store: { pruneExpired: async () => counts({ backlog: true, batches: 500, total: 500 }) },
      alerts: createRetentionAlertMonitor({ log: (line) => lines.push(line) }),
      log: () => undefined,
      // The real loop re-arms itself through setImmediate while a backlog
      // persists; swallow the continuation so the test stays finite.
      scheduleContinuation: () => undefined,
    });
    await prune();
    expect(lines).toEqual(["[retention] event=prune_backlog_started batches=500"]);
  });

  it("emits the repeated-failure alert when the sweep keeps throwing", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const prune = createRetentionPruneLoop({
      store: { pruneExpired: async () => { throw new Error("locked"); } },
      alerts: createRetentionAlertMonitor({ log: (line) => lines.push(line) }),
      log: () => undefined,
    });
    for (let sweep = 1; sweep < RETENTION_PRUNE_FAILURE_THRESHOLD; sweep += 1) {
      await prune();
      expect(lines).toEqual([]);
    }
    await prune();
    expect(lines).toEqual([
      `[retention] event=prune_failing_repeatedly consecutive=${RETENTION_PRUNE_FAILURE_THRESHOLD}`,
    ]);
    vi.restoreAllMocks();
  });

  it("clears the failure streak once a sweep succeeds", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let failing = true;
    const prune = createRetentionPruneLoop({
      store: {
        pruneExpired: async () => {
          if (failing) throw new Error("locked");
          return counts();
        },
      },
      alerts: createRetentionAlertMonitor({ log: (line) => lines.push(line) }),
      log: () => undefined,
    });
    for (let sweep = 1; sweep < RETENTION_PRUNE_FAILURE_THRESHOLD; sweep += 1) await prune();
    failing = false;
    await prune();
    failing = true;
    for (let sweep = 1; sweep < RETENTION_PRUNE_FAILURE_THRESHOLD; sweep += 1) await prune();
    expect(lines).toEqual([]);
    vi.restoreAllMocks();
  });
});

describe("live Clockify factory reaches the alert emitters (rows 6 and 9)", () => {
  const installation = {
    workspaceId: "64ad1305c701cc5be7c26fe4",
    addonToken: "addon-token",
    apiUrl: "https://api.clockify.me/api",
  } as unknown as Installation;

  /** Build the factory the way `start()` does, capturing the adapter options. */
  function composed(): { options: RestWorkspaceOptions; lines: string[] } {
    const lines: string[] = [];
    const log = (line: string): void => void lines.push(line);
    const alias = (workspaceId: string): string => `ws-${workspaceId.slice(-4)}`;
    let captured: RestWorkspaceOptions | undefined;
    const factory = createLiveClockifyFactory({
      requestGovernorFor: () => undefined as unknown as ReturnType<typeof Object>,
      tokenRejectionMonitor: createTokenRejectionMonitor({ aliasFor: alias, log }),
      hostThrottleMonitor: createHostThrottleMonitor({ aliasFor: alias, log }),
      createClient: (options) => {
        captured = options;
        return {} as WorkspaceClient;
      },
    });
    factory(installation);
    if (!captured) throw new Error("factory never constructed a client");
    return { options: captured, lines };
  }

  it("wires the throttle observation seams to the throttle monitor", () => {
    const { options, lines } = composed();
    expect(options.onHostThrottled).toBeTypeOf("function");
    for (let i = 0; i < SUSTAINED_HOST_CONSECUTIVE_THRESHOLD; i += 1) options.onHostThrottled?.(429);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[clockify-host] event=host_throttled_sustained");
    // The raw workspace id must not survive the composition either.
    expect(lines[0]).not.toContain(installation.workspaceId);
  });

  it("wires the healthy seam, so the streak the production client builds can reset", () => {
    const { options, lines } = composed();
    expect(options.onHostHealthy).toBeTypeOf("function");
    for (let i = 1; i < SUSTAINED_HOST_CONSECUTIVE_THRESHOLD; i += 1) options.onHostThrottled?.(503);
    options.onHostHealthy?.();
    for (let i = 1; i < SUSTAINED_HOST_CONSECUTIVE_THRESHOLD; i += 1) options.onHostThrottled?.(503);
    expect(lines).toEqual([]);
    options.onHostThrottled?.(503);
    expect(lines).toHaveLength(1);
  });

  it("wires the installation-token seams to the rejection monitor (row 9)", () => {
    const { options, lines } = composed();
    expect(options.onAuthRejected).toBeTypeOf("function");
    expect(options.onAuthAccepted).toBeTypeOf("function");
    for (let i = 0; i < 3; i += 1) options.onAuthRejected?.();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[install-authority] event=token_rejected_suspect");
    options.onAuthAccepted?.();
    for (let i = 0; i < 2; i += 1) options.onAuthRejected?.();
    expect(lines).toHaveLength(1);
  });

  it("keeps the add-on token out of everything except the auth field", () => {
    const { options } = composed();
    expect(options.auth).toEqual({ addonToken: "addon-token" });
    expect(options.workspaceId).toBe(installation.workspaceId);
  });
});
