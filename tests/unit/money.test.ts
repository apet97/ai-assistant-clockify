import { describe, expect, it } from "vitest";
import { toMinor } from "../../src/harness/money.js";

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
