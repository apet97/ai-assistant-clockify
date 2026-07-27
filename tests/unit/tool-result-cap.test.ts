import { describe, expect, it } from "vitest";
import { capToolResultForModel, TOOL_RESULT_MAX_BYTES } from "../../src/assistant/tool-results.js";
import { errorReceipt, successReceipt } from "../../src/harness/receipts.js";

describe("TOOL_RESULT_MAX_BYTES", () => {
  it("remains exactly 24_000 bytes", () => {
    expect(TOOL_RESULT_MAX_BYTES).toBe(24_000);
  });
});

describe("capToolResultForModel", () => {
  it("passes small receipts through byte-identical", () => {
    const receipt = successReceipt({ action: "clockify_tags_list", data: { items: [{ id: "t1", name: "urgent" }] } });
    const capped = capToolResultForModel(receipt);
    expect(capped).toBe(JSON.stringify(receipt));
  });

  it("prunes oversized receipts and adds truncatedForModel", () => {
    const big = "x".repeat(30_000);
    const receipt = successReceipt({ action: "clockify_reports_detailed", data: { rows: [big] } });
    const capped = capToolResultForModel(receipt);
    expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
    expect(JSON.parse(capped).truncatedForModel).toBe(true);
  });

  it("replaces data wholesale when pruning is still too large", () => {
    const payload: Record<string, string> = {};
    for (let i = 0; i < 80; i += 1) payload[`field${i}`] = "z".repeat(4_000);
    const receipt = successReceipt({ action: "clockify_reports_detailed", data: payload });
    const capped = capToolResultForModel(receipt);
    expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
    const parsed = JSON.parse(capped) as { data: { note: string }; truncatedForModel: boolean };
    expect(parsed.truncatedForModel).toBe(true);
    expect(parsed.data.note).toMatch(/too large to show the model/u);
  });

  it("caps error receipts the same way as success receipts", () => {
    const receipt = errorReceipt({
      action: "clockify_tags_list",
      code: "failed",
      message: "z".repeat(40_000),
    });
    const capped = capToolResultForModel(receipt);
    expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
  });
});
