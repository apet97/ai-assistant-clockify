import { describe, expect, it } from "vitest";
import {
  FEATURE_GROUPS,
  applyPolicyPatch,
  canRead,
  canWrite,
  defaultAdminPolicy,
} from "../../src/harness/permissions.js";

describe("permissions", () => {
  it("default policy is read_write for every feature group", () => {
    const policy = defaultAdminPolicy();
    for (const group of FEATURE_GROUPS) {
      expect(policy.groups[group]).toBe("read_write");
      expect(canRead(policy, group)).toBe(true);
      expect(canWrite(policy, group)).toBe(true);
    }
  });

  it("off blocks read and write", () => {
    const policy = defaultAdminPolicy();
    policy.groups.invoices = "off";
    expect(canRead(policy, "invoices")).toBe(false);
    expect(canWrite(policy, "invoices")).toBe(false);
  });

  it("read allows read and blocks write", () => {
    const policy = defaultAdminPolicy();
    policy.groups.invoices = "read";
    expect(canRead(policy, "invoices")).toBe(true);
    expect(canWrite(policy, "invoices")).toBe(false);
  });

  it("read_write allows read and write", () => {
    const policy = defaultAdminPolicy();
    policy.groups.invoices = "read_write";
    expect(canRead(policy, "invoices")).toBe(true);
    expect(canWrite(policy, "invoices")).toBe(true);
  });

  it("applyPolicyPatch updates only the patched groups and returns a new policy", () => {
    const policy = defaultAdminPolicy();
    const patched = applyPolicyPatch(policy, { groups: { invoices: "off", reports: "read" } });
    expect(patched.groups.invoices).toBe("off");
    expect(patched.groups.reports).toBe("read");
    expect(patched.groups.time_tracking).toBe("read_write");
    // original is not mutated
    expect(policy.groups.invoices).toBe("read_write");
  });

  it("applyPolicyPatch rejects unknown groups and invalid levels", () => {
    const policy = defaultAdminPolicy();
    expect(() =>
      applyPolicyPatch(policy, { groups: { not_a_group: "off" } as never }),
    ).toThrow();
    expect(() =>
      applyPolicyPatch(policy, { groups: { invoices: "yes" } as never }),
    ).toThrow();
  });
});
