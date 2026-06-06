import { describe, expect, it } from "vitest";
import { isSafeWrite, requiresConfirmation } from "../../src/harness/risk.js";

describe("risk", () => {
  it("safe_write does not require confirmation", () => {
    expect(requiresConfirmation(["safe_write"])).toBe(false);
  });

  it("read does not require confirmation", () => {
    expect(requiresConfirmation(["read"])).toBe(false);
  });

  it.each([
    "destructive",
    "billing",
    "payment",
    "permission_change",
    "external_side_effect",
    "bulk",
  ] as const)("%s requires confirmation", (risk) => {
    expect(requiresConfirmation([risk])).toBe(true);
  });

  it("any risky label among safe ones still requires confirmation", () => {
    expect(requiresConfirmation(["safe_write", "destructive"])).toBe(true);
  });

  it("isSafeWrite is true only for a non-confirming safe_write", () => {
    expect(isSafeWrite(["safe_write"])).toBe(true);
    expect(isSafeWrite(["safe_write", "destructive"])).toBe(false);
    expect(isSafeWrite(["read"])).toBe(false);
    expect(isSafeWrite(["destructive"])).toBe(false);
  });
});
