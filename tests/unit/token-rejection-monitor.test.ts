import { describe, expect, it } from "vitest";
import { createTokenRejectionMonitor } from "../../src/clockify/token-rejection-monitor.js";

/**
 * Closure-plan PR 11 (F15 forward rule): repeated authenticated 401s alert the
 * operator with an ALIASED `suspect` line; authority is never changed and the
 * raw workspace id never reaches the log.
 */
describe("token rejection monitor", () => {
  function build(threshold?: number): { lines: string[]; monitor: ReturnType<typeof createTokenRejectionMonitor> } {
    const lines: string[] = [];
    const monitor = createTokenRejectionMonitor({
      aliasFor: () => "ws-aliasedvalue",
      log: (line) => lines.push(line),
      ...(threshold !== undefined ? { threshold } : {}),
    });
    return { lines, monitor };
  }

  it("alerts exactly once when a streak crosses the threshold", () => {
    const { lines, monitor } = build();
    monitor.rejected("64ad1305c701cc5be7c26fe4");
    monitor.rejected("64ad1305c701cc5be7c26fe4");
    expect(lines).toEqual([]);
    monitor.rejected("64ad1305c701cc5be7c26fe4");
    expect(lines).toEqual([
      "[install-authority] event=token_rejected_suspect workspace=ws-aliasedvalue consecutive=3",
    ]);
    monitor.rejected("64ad1305c701cc5be7c26fe4");
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("64ad1305c701cc5be7c26fe4");
  });

  it("an accepted response resets the streak; a fresh streak alerts again", () => {
    const { lines, monitor } = build(2);
    monitor.rejected("ws-a");
    monitor.accepted("ws-a");
    monitor.rejected("ws-a");
    expect(lines).toEqual([]);
    monitor.rejected("ws-a");
    expect(lines).toHaveLength(1);
    monitor.accepted("ws-a");
    monitor.rejected("ws-a");
    monitor.rejected("ws-a");
    expect(lines).toHaveLength(2);
  });

  it("streaks are per-workspace", () => {
    const { lines, monitor } = build(2);
    monitor.rejected("ws-a");
    monitor.rejected("ws-b");
    expect(lines).toEqual([]);
    monitor.rejected("ws-a");
    expect(lines).toHaveLength(1);
  });
});
