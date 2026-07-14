import { describe, expect, it } from "vitest";
import { createStore } from "../../src/db/store.js";

const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

describe("canonical action results", () => {
  it("keeps the full result once and returns a deterministic summary ref bounded to 65,536 bytes", () => {
    const store = createStore(":memory:");
    const data = { rows: Array.from({ length: 5_000 }, (_, index) => ({ id: `row-${index}`, value: "x".repeat(40) })) };
    const result = {
      kind: "receipt",
      receipt: {
        ok: true,
        action: "clockify_reports_detailed",
        status: "succeeded",
        ids: ["report-1"],
        changed: { created: [{ type: "report", id: "report-1" }] },
        warnings: [{ code: "bounded", message: "Large report" }],
        data,
      },
    };

    const ref = store.recordActionResult({
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      sessionId: "session-1",
      actionName: "clockify_reports_detailed",
      status: "succeeded",
      result,
    });

    expect(ref).toMatchObject({
      id: expect.any(String),
      kind: "succeeded",
      summary: {
        kind: "receipt",
        receipt: {
          action: "clockify_reports_detailed",
          status: "succeeded",
          ids: ["report-1"],
          changed: { created: [{ type: "report", id: "report-1" }] },
          warnings: [{ code: "bounded", message: "Large report" }],
          data: {
            actionResultId: expect.any(String),
            originalByteCount: expect.any(Number),
          },
        },
      },
    });
    expect(byteLength(ref.summary)).toBeLessThanOrEqual(65_536);
    expect(store.getActionResult(ref.id)).toEqual(result);
    store.close();
  });

  it("classifies partial, definitive failure, and ambiguous failure refs without losing recovery metadata", () => {
    const store = createStore(":memory:");
    const cases = [
      {
        status: "partial" as const,
        result: { kind: "partial", message: "Stopped", recovery: { hint: "Review", retryable: false } },
      },
      {
        status: "definitive_failed" as const,
        result: { kind: "receipt", receipt: { ok: false, action: "x", code: "invalid_args", recovery: { hint: "Fix", retryable: true } } },
      },
      {
        status: "outcome_unknown" as const,
        result: { kind: "receipt", receipt: { ok: false, action: "x", code: "commit_outcome_unknown", recovery: { hint: "Check", retryable: false } } },
      },
    ];

    for (const entry of cases) {
      const ref = store.recordActionResult({
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        actionName: "x",
        status: entry.status,
        result: entry.result,
      });
      expect(ref.kind).toBe(entry.status);
      expect(JSON.stringify(ref.summary)).toContain("recovery");
    }
    store.close();
  });

  it("retains IDs and recovery metadata when non-data fields also require compaction", () => {
    const store = createStore(":memory:");
    const result = {
      kind: "receipt",
      receipt: {
        ok: false,
        action: "clockify_reports_detailed",
        status: "definitive_failed",
        ids: ["report-1", "report-2"],
        error: { code: "invalid_args", message: "x".repeat(80_000) },
        recovery: { hint: "verify the filters", retryable: true },
        warnings: Array.from({ length: 1_000 }, (_, index) => ({ code: `warning-${index}`, message: "y".repeat(200) })),
      },
    };
    const ref = store.recordActionResult({
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "clockify_reports_detailed",
      status: "definitive_failed",
      result,
    });

    expect(JSON.stringify(ref.summary)).toContain("report-1");
    expect(JSON.stringify(ref.summary)).toContain("recovery");
    expect(byteLength(ref.summary)).toBeLessThanOrEqual(65_536);
    store.close();
  });

  it("preserves every required summary field even when pathological metadata forces the final fallback", () => {
    const store = createStore(":memory:");
    const pathologicalIds = Object.fromEntries(
      Array.from({ length: 2_000 }, (_, index) => [`pathological${index}Id`, `id-${index}-${"x".repeat(300)}`]),
    );
    const ref = store.recordActionResult({
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "clockify_reports_detailed",
      status: "definitive_failed",
      result: {
        kind: "receipt",
        receipt: {
          ok: false,
          action: "clockify_reports_detailed",
          status: "definitive_failed",
          ids: ["report-1", "report-2"],
          changed: { created: [{ type: "report", id: "report-1" }] },
          warnings: [{ code: "bounded", message: "Review filters" }],
          error: { code: "invalid_args", message: "Invalid filters" },
          recovery: { hint: "Verify the date range", retryable: true },
          ...pathologicalIds,
        },
      },
    });

    expect(ref.summary).toMatchObject({
      kind: "receipt",
      receipt: {
        action: "clockify_reports_detailed",
        status: "definitive_failed",
        ids: ["report-1", "report-2"],
        changed: { created: [{ type: "report", id: "report-1" }] },
        warnings: [{ code: "bounded", message: "Review filters" }],
        error: { code: "invalid_args", message: "Invalid filters" },
        recovery: { hint: "Verify the date range", retryable: true },
      },
    });
    expect(byteLength(ref.summary)).toBeLessThanOrEqual(65_536);
    store.close();
  });
});
