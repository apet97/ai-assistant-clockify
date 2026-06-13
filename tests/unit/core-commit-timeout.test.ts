import { describe, expect, it, vi } from "vitest";
import { createRestCore } from "../../src/clockify/rest/core.js";

/**
 * r1-concurrency-races-01 prerequisite: the commit path (POST/GET/PUT to the
 * Clockify host) had NO timeout, so commit latency was effectively unbounded.
 * The atomic-claim TTL is only provably above worst-case if commit latency has a
 * real ceiling, so doFetch carries an AbortSignal. This pins that the signal is
 * wired and bounds a hung host with a clean "timed out" error.
 */

/** A fetchImpl that hangs forever UNLESS the passed AbortSignal fires. */
function hangingFetch(): typeof fetch {
  return vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason));
      }
    });
  }) as unknown as typeof fetch;
}

describe("rest core commit timeout", () => {
  it("aborts a hung host call with a clean timed-out error (not a hang)", async () => {
    const core = createRestCore({
      apiBase: "https://api.clockify.me/api/v1",
      auth: { addonToken: "tok" },
      fetchImpl: hangingFetch(),
      commitTimeoutMs: 40,
    });
    await expect(core.call("api", "POST", "/workspaces/ws-1/invoices", { a: 1 })).rejects.toThrow(
      /timed out/i,
    );
  });

  it("also bounds getBinary", async () => {
    const core = createRestCore({
      apiBase: "https://api.clockify.me/api/v1",
      auth: { addonToken: "tok" },
      fetchImpl: hangingFetch(),
      commitTimeoutMs: 40,
    });
    await expect(core.getBinary("api", "/workspaces/ws-1/invoices/x/export")).rejects.toThrow(
      /timed out/i,
    );
  });
});
