import { describe, expect, it } from "vitest";
import { errorReceipt, hasChanges, successReceipt } from "../../src/harness/receipts.js";

describe("receipts", () => {
  it("includes a non-empty changed bucket", () => {
    const receipt = successReceipt({
      action: "clockify_create_work_package",
      entity: "tag",
      ids: { workspaceId: "ws-1" },
      changed: { created: [{ type: "tag", id: "t1", name: "Deep Work" }] },
    });
    expect(receipt.ok).toBe(true);
    expect(receipt.changed?.created?.[0].id).toBe("t1");
    expect(receipt.entity).toBe("tag");
  });

  it("omits empty change buckets when clean", () => {
    const receipt = successReceipt({
      action: "clockify_status",
      changed: { created: [], updated: [], deleted: [], reused: [] },
    });
    expect(receipt.changed).toBeUndefined();
  });

  it("omits empty optional fields", () => {
    const receipt = successReceipt({ action: "clockify_status" });
    expect(receipt.changed).toBeUndefined();
    expect(receipt.warnings).toBeUndefined();
    expect(receipt.next).toBeUndefined();
    expect(receipt.ids).toBeUndefined();
  });

  it("hasChanges reflects non-empty buckets", () => {
    expect(hasChanges(undefined)).toBe(false);
    expect(hasChanges({ created: [], updated: [] })).toBe(false);
    expect(hasChanges({ created: [{ type: "x", id: "1" }] })).toBe(true);
  });

  it("error receipt includes code and a recovery hint", () => {
    const receipt = errorReceipt({
      action: "clockify_delete_entity",
      code: "policy_denied",
      message: "Billing writes are disabled in your assistant permissions.",
    });
    expect(receipt.ok).toBe(false);
    expect(receipt.code).toBe("policy_denied");
    expect(receipt.recovery).toBeDefined();
    expect(receipt.recovery?.hint).toBeTruthy();
  });

  it("error receipt preserves a provided recovery hint", () => {
    const receipt = errorReceipt({
      action: "clockify_prepare_invoice",
      code: "policy_denied",
      message: "denied",
      recovery: { hint: "Ask me to enable billing writes.", retryable: true },
    });
    expect(receipt.recovery?.hint).toBe("Ask me to enable billing writes.");
    expect(receipt.recovery?.retryable).toBe(true);
  });
});
