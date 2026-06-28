import { describe, expect, it } from "vitest";
import { fromMinor, toMinor } from "../../src/harness/money.js";

describe("toMinor", () => {
  it("scales major units by 100", () => {
    expect(toMinor(50, "major")).toBe(5000);
    expect(toMinor(0, "major")).toBe(0);
    expect(toMinor(1234.56, "major")).toBe(123456);
  });

  it("passes minor units through, rounding to an integer", () => {
    expect(toMinor(5000, "minor")).toBe(5000);
    expect(toMinor(5000.4, "minor")).toBe(5000);
  });

  it("rounds the major conversion rather than truncating", () => {
    // 19.999 * 100 = 1999.9 -> 2000, not 1999
    expect(toMinor(19.999, "major")).toBe(2000);
  });
});

describe("edge cases", () => {
  it("maps zero to zero in both units", () => {
    expect(toMinor(0, "major")).toBe(0);
    expect(toMinor(0, "minor")).toBe(0);
  });

  it("passes negative amounts through (no abs/clamp)", () => {
    // -10.5 * 100 = -1050: a credit/refund must keep its sign.
    expect(toMinor(-10.5, "major")).toBe(-1050);
  });

  it("rounds sub-cent major amounts half-up via Math.round", () => {
    // 10.005 * 100 = 1000.5000000000001 -> 1001 (rounds up);
    // 10.004 * 100 = 1000.4 -> 1000 (rounds down).
    expect(toMinor(10.005, "major")).toBe(1001);
    expect(toMinor(10.004, "major")).toBe(1000);
  });

  it("rounds an already-minor float to the nearest integer", () => {
    expect(toMinor(1000.5, "minor")).toBe(1001);
  });

  it("handles a large value without precision loss", () => {
    expect(toMinor(1_000_000, "major")).toBe(100_000_000);
  });
});

describe("fromMinor", () => {
  it("renders zero, negative, and sub-dollar minor units as a 2-decimal major string", () => {
    expect(fromMinor(0)).toBe("0.00");
    expect(fromMinor(-1050)).toBe("-10.50");
    expect(fromMinor(1)).toBe("0.01");
  });
});
