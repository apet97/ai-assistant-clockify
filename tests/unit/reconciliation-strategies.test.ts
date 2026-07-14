import { describe, expect, it, vi } from "vitest";
import { reconcileExternalMutation } from "../../src/harness/reconciliation.js";

const binding = {
  operationId: "operation-1",
  stepId: "step-1",
  actionName: "clockify_test_write",
  actionFingerprint: "action-fingerprint",
  catalogHash: "catalog-hash",
};

describe("read-only external mutation reconciliation", () => {
  it.each([
    ["create", 1],
    ["update", 1],
    ["state-command", 1],
    ["composed", 1],
    ["delete", 0],
  ] as const)("authoritatively reconciles %s only at its exact cardinality", async (strategy, successCount) => {
    for (const count of [0, 1, 2]) {
      const result = await reconcileExternalMutation({
        strategy,
        binding,
        expected: { actionFingerprint: binding.actionFingerprint, catalogHash: binding.catalogHash },
        readEvidence: vi.fn().mockResolvedValue({
          rows: Array.from({ length: count }, (_, index) => ({ ref: { type: "thing", id: `id-${index}` }, projection: { value: "expected" } })),
          truncated: false,
        }),
        matches: (candidate) => (candidate.projection as { value: string }).value === "expected",
      });
      expect(result.authoritative).toBe(count === successCount);
      expect(result.binding).toEqual(binding);
    }
  });

  it.each(["create", "update", "delete", "state-command", "composed"] as const)(
    "rejects truncated and failed %s reads without throwing",
    async (strategy) => {
      const truncated = await reconcileExternalMutation({
        strategy,
        binding,
        expected: { actionFingerprint: binding.actionFingerprint, catalogHash: binding.catalogHash },
        readEvidence: vi.fn().mockResolvedValue({ rows: [], truncated: true }),
        matches: () => true,
      });
      expect(truncated).toMatchObject({ authoritative: false, reason: "incomplete_evidence" });

      const failed = await reconcileExternalMutation({
        strategy,
        binding,
        expected: { actionFingerprint: binding.actionFingerprint, catalogHash: binding.catalogHash },
        readEvidence: vi.fn().mockRejectedValue(new Error("Authorization: Bearer secret")),
        matches: () => true,
      });
      expect(failed).toMatchObject({ authoritative: false, reason: "read_failed" });
      expect(JSON.stringify(failed)).not.toContain("secret");
    },
  );

  it.each([
    [{ actionFingerprint: "drift", catalogHash: binding.catalogHash }, "action_fingerprint_drift"],
    [{ actionFingerprint: binding.actionFingerprint, catalogHash: "drift" }, "catalog_hash_drift"],
  ] as const)("rejects compatibility drift before reading", async (expected, reason) => {
    const readEvidence = vi.fn();
    const result = await reconcileExternalMutation({
      strategy: "create",
      binding,
      expected,
      readEvidence,
      matches: () => true,
    });
    expect(result).toMatchObject({ authoritative: false, reason });
    expect(readEvidence).not.toHaveBeenCalled();
  });

  it("bounds and sanitizes persisted evidence", async () => {
    const result = await reconcileExternalMutation({
      strategy: "create",
      binding,
      expected: { actionFingerprint: binding.actionFingerprint, catalogHash: binding.catalogHash },
      readEvidence: vi.fn().mockResolvedValue({
        rows: [{ ref: { type: "thing", id: "id-1" }, projection: { note: "x".repeat(200_000), token: "secret", bytes: new Uint8Array(100) } }],
        truncated: false,
      }),
      matches: () => true,
    });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65_536);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result.binding).toEqual(binding);
  });

  it("delete ignores unrelated complete rows and proves absence only for matching target rows", async () => {
    const result = await reconcileExternalMutation({
      strategy: "delete",
      binding,
      expected: { actionFingerprint: binding.actionFingerprint, catalogHash: binding.catalogHash },
      readEvidence: vi.fn().mockResolvedValue({
        rows: [{ ref: { type: "thing", id: "unrelated" }, projection: { id: "unrelated" } }],
        truncated: false,
      }),
      matches: (candidate) => candidate.ref.id === "target",
    });
    expect(result).toMatchObject({ authoritative: true, reason: "authoritative_match" });
  });

  it.each([
    { ref: { type: "thing" }, projection: {} },
    { ref: { type: "", id: "id-1" }, projection: {} },
    { ref: { type: "thing", id: 7 }, projection: {} },
  ])("rejects malformed candidate refs as invalid evidence", async (candidate) => {
    const result = await reconcileExternalMutation({
      strategy: "create",
      binding,
      expected: { actionFingerprint: binding.actionFingerprint, catalogHash: binding.catalogHash },
      readEvidence: vi.fn().mockResolvedValue({ rows: [candidate], truncated: false }),
      matches: () => true,
    });
    expect(result).toMatchObject({ authoritative: false, reason: "invalid_evidence" });
  });

  it("fails closed when the matcher throws or the persisted strategy binding differs", async () => {
    const matcherFailure = await reconcileExternalMutation({
      strategy: "create",
      binding,
      expected: { actionFingerprint: binding.actionFingerprint, catalogHash: binding.catalogHash },
      readEvidence: vi.fn().mockResolvedValue({ rows: [{ ref: { type: "thing", id: "id" }, projection: {} }], truncated: false }),
      matches: () => { throw new Error("Authorization: Bearer secret"); },
    });
    expect(matcherFailure).toMatchObject({ authoritative: false, reason: "evaluation_failed" });
    expect(JSON.stringify(matcherFailure)).not.toContain("secret");

    const strategyMismatch = await reconcileExternalMutation({
      strategy: "delete",
      binding: { ...binding, strategy: "create" },
      expected: { actionFingerprint: binding.actionFingerprint, catalogHash: binding.catalogHash },
      readEvidence: vi.fn(),
      matches: () => true,
    });
    expect(strategyMismatch).toMatchObject({ authoritative: false, reason: "binding_mismatch" });
  });
});
