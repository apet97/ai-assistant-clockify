import { MAX_GET_RETRIES } from "./rest/core.js";

/**
 * Sustained-throttling alerting for Clockify (D3; `DEPLOYMENT.md` "Required
 * alerts" row 6, "sustained Clockify 429/5xx responses").
 *
 * Both halves of this path were silent: `rest/core.ts` fed a 429 straight into
 * the governor's cooldown and a 5xx into a bounded GET retry, and neither the
 * core nor the governor counted anything. A workspace could spend an hour being
 * rate-limited into failed turns with nothing in the log but individual request
 * errors.
 *
 * TWO triggers, because either one alone gets "sustained" wrong:
 *
 * - A rolling WINDOW (N failures within M ms) is what makes the word true. A
 *   consecutive-only streak that any success resets can never fire on a partial
 *   outage — a workspace answering 50% 5xx never gets two failures in a row,
 *   which is the ordinary degradation shape and the one an operator most needs
 *   to hear about. Successes do not clear this window; only time does.
 * - A consecutive FAST-TRIP still exists because the window needs volume: a
 *   low-traffic workspace in a TOTAL outage would take a long time to
 *   accumulate N failures, and that case is both unambiguous and urgent.
 *
 * Each trigger LATCHES: it fires once and re-arms only after the rolling window
 * drains completely — sustained health, not one lucky response — so a long
 * outage produces at most two lines rather than thousands. Counting is per workspace,
 * which has a deliberate consequence worth naming: a storm confined to ONE
 * endpoint is measured together with every other call for that workspace. A
 * per-path streak would alert on a single flaky endpoint and would never reset
 * for one that is simply unused — the same trade `token-rejection-monitor.ts`
 * makes.
 */
export interface HostThrottleMonitor {
  /** Clockify answered 429 or 5xx on an authenticated request. */
  throttled(workspaceId: string, status: number): void;
  /** Clockify answered anything else — the host is responding. */
  healthy(workspaceId: string): void;
}

/**
 * Consecutive throttled responses before the fast-trip fires.
 *
 * DERIVED, not chosen: a single GET produces at most `1 + MAX_GET_RETRIES`
 * throttled observations, because the core retries a retryable status that many
 * times before giving up. One above that maximum means a single blip — even one
 * that exhausts its own retry budget — can never page an operator; reaching it
 * requires a SECOND request to be failing too. Importing the retry constant
 * instead of writing `4` keeps the two from drifting apart.
 */
export const SUSTAINED_HOST_CONSECUTIVE_THRESHOLD = 1 + MAX_GET_RETRIES + 1;

/** Rolling window over which the sustained-rate trigger counts failures. */
export const SUSTAINED_HOST_WINDOW_MS = 60_000;

/**
 * Failures within {@link SUSTAINED_HOST_WINDOW_MS} before the sustained-rate
 * trigger fires, however many successes are interleaved.
 *
 * Twelve is four times one request's maximum retry chain (3), so it takes at
 * least four DISTINCT failing requests inside the minute — no single flaky call
 * can reach it. Against the per-workspace governor ceiling (10 req/s, so ~600
 * requests per minute) twelve is ~2% of maximum throughput: high enough that
 * ordinary noise does not page, low enough that a real partial outage is caught
 * inside one window. A total outage trips the consecutive fast-trip in under a
 * second and never waits for this.
 */
export const SUSTAINED_HOST_WINDOW_THRESHOLD = 12;

interface WorkspaceThrottleState {
  streak: number;
  /** Newest-last failure timestamps, capped at the window threshold. */
  failures: number[];
  windowAlerted: boolean;
  consecutiveAlerted: boolean;
}

export function createHostThrottleMonitor(input: {
  /** Privacy alias for the log line — the raw workspace id is never logged. */
  aliasFor: (workspaceId: string) => string;
  consecutiveThreshold?: number;
  windowThreshold?: number;
  windowMs?: number;
  /** Injectable clock; tests drive the rolling window instead of sleeping. */
  now?: () => number;
  log?: (line: string) => void;
}): HostThrottleMonitor {
  const consecutiveThreshold = input.consecutiveThreshold ?? SUSTAINED_HOST_CONSECUTIVE_THRESHOLD;
  const windowThreshold = input.windowThreshold ?? SUSTAINED_HOST_WINDOW_THRESHOLD;
  const windowMs = input.windowMs ?? SUSTAINED_HOST_WINDOW_MS;
  const now = input.now ?? Date.now;
  const log = input.log ?? ((line: string) => console.warn(line));
  const states = new Map<string, WorkspaceThrottleState>();

  /** Drop failures that have aged out. Only time clears the window. */
  const pruneWindow = (state: WorkspaceThrottleState, timestamp: number): void => {
    while (state.failures.length > 0 && state.failures[0]! <= timestamp - windowMs) {
      state.failures.shift();
    }
  };

  return {
    throttled(workspaceId, status) {
      const timestamp = now();
      const state = states.get(workspaceId)
        ?? { streak: 0, failures: [], windowAlerted: false, consecutiveAlerted: false };
      states.set(workspaceId, state);
      state.streak += 1;
      state.failures.push(timestamp);
      // Only the newest `windowThreshold` timestamps can ever matter, so memory
      // stays O(1) per workspace however long an outage runs.
      if (state.failures.length > windowThreshold) state.failures.shift();
      pruneWindow(state, timestamp);

      const alias = input.aliasFor(workspaceId);
      // Exactly one line per condition: at the crossing, not per response.
      //
      // The LATCH is load-bearing, not tidiness. `healthy()` zeroes the streak,
      // so without it a partial outage re-fires every time four failures happen
      // to land in a row: measured at 2-of-3 GETs failing, ~600 lines/hour at 30
      // req/min and ~4,000/hour at 200 req/min. An alert that floods during the
      // incident it reports is worse than no alert. It clears only when the
      // rolling window drains completely (see `healthy`), i.e. after SUSTAINED
      // health rather than one lucky response.
      if (state.streak === consecutiveThreshold && !state.consecutiveAlerted) {
        state.consecutiveAlerted = true;
        log(
          `[clockify-host] event=host_throttled_sustained workspace=${alias} status=${status} trigger=consecutive count=${state.streak}`,
        );
      }
      const sustained = state.failures.length >= windowThreshold;
      if (!sustained) {
        state.windowAlerted = false;
      } else if (!state.windowAlerted) {
        state.windowAlerted = true;
        log(
          `[clockify-host] event=host_throttled_sustained workspace=${alias} status=${status} trigger=window count=${state.failures.length} windowMs=${windowMs}`,
        );
      }
    },
    healthy(workspaceId) {
      const state = states.get(workspaceId);
      if (!state) return;
      state.streak = 0;
      pruneWindow(state, now());
      if (state.failures.length < windowThreshold) state.windowAlerted = false;
      // An empty window is the definition of sustained health: no failure at all
      // in the last `windowMs`. Dropping the row clears BOTH latches, so the next
      // outage alerts again — and a workspace that is simply behaving costs no
      // memory. A workspace whose traffic stops ON a failure keeps one small row
      // until it is called again, so the map is bounded by installation count,
      // not by outage length.
      if (state.failures.length === 0) states.delete(workspaceId);
    },
  };
}
