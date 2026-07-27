import { describe, expect, it } from "vitest";
import {
  isSweepableName,
  sweepIsClean,
  sweepLeftovers,
  SWEEP_PREFIXES,
} from "../../scripts/live-sweep.js";
import { LIVE_V2_PREFIX } from "../../scripts/live-v2-full.js";

/**
 * T17-F: the sweep's ownership predicate and zero-leftover contract, proven
 * without any Clockify call. The sweep is the safety net behind every live run,
 * so it must (a) cover the v2 harness prefix as well as the v1 one, and (b) never
 * touch a resource it does not own.
 */

describe("T17-F: the sweep owns exactly the harness fixture prefixes", () => {
  it("covers both the v1 smoke prefix and the v2 acceptance prefix", () => {
    expect([...SWEEP_PREFIXES]).toEqual(["AIASSIST_SMOKE_", "AIASSIST_V2_"]);
    // The v2 harness prefix and the sweep must agree, or an acceptance run could
    // leave resources no cleanup job looks for.
    expect(SWEEP_PREFIXES).toContain(LIVE_V2_PREFIX);
  });

  it("matches a fixture name under either prefix", () => {
    expect(isSweepableName("AIASSIST_SMOKE_project")).toBe(true);
    expect(isSweepableName("AIASSIST_V2_project")).toBe(true);
  });

  it("never matches a real workspace resource", () => {
    for (const name of [
      "Website relaunch",
      "aiassist_smoke_lowercase",
      " AIASSIST_V2_leading_space",
      "Client AIASSIST_V2_ in the middle",
      "",
    ]) {
      expect(isSweepableName(name), name).toBe(false);
    }
  });

  it("never matches a non-string field", () => {
    for (const value of [undefined, null, 42, {}, ["AIASSIST_V2_x"]]) {
      expect(isSweepableName(value)).toBe(false);
    }
  });
});

describe("T17-F: a sweep is clean only with zero leftovers and zero failures", () => {
  it("passes when everything matched was removed", () => {
    expect(sweepIsClean({ matched: 3, removed: 3, failures: 0, scanFailures: 0 })).toBe(true);
    expect(sweepLeftovers({ matched: 3, removed: 3 })).toBe(0);
  });

  it("passes trivially when nothing matched", () => {
    expect(sweepIsClean({ matched: 0, removed: 0, failures: 0, scanFailures: 0 })).toBe(true);
  });

  it("fails when a matched resource survived", () => {
    expect(sweepIsClean({ matched: 3, removed: 2, failures: 0, scanFailures: 0 })).toBe(false);
    expect(sweepLeftovers({ matched: 3, removed: 2 })).toBe(1);
  });

  it("fails on a cleanup failure even when the counts balance", () => {
    expect(sweepIsClean({ matched: 2, removed: 2, failures: 1, scanFailures: 0 })).toBe(false);
  });

  it("fails on a SCAN failure: an incomplete scan can never prove absence", () => {
    expect(sweepIsClean({ matched: 0, removed: 0, failures: 0, scanFailures: 1 })).toBe(false);
  });
});
