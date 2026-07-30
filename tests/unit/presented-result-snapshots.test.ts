import { describe, expect, it } from "vitest";
import {
  PRESENTED_RESULT_STATUSES,
  PRESENTED_RESULT_MAX_FACTS,
  PRESENTED_RESULT_MAX_WARNINGS,
  PRESENTED_RESULT_MAX_REFERENCES,
  presentedResultSchema,
  presentedResultEnvelopeSchema,
  diagnosticViewSchema,
  decodePresentedResultEnvelope,
  assertNoStrayLiveControl,
  DIAGNOSTIC_VALUE_MAX_BYTES,
} from "../../src/assistant-v2/presentation/presented-result.js";

/** T15-A: the ONE authoritative v2 result envelope. Do not add coverage for a
 * second envelope shape anywhere — if a test here fails because you're
 * comparing against a parallel type, that's the plan's forbidden second
 * envelope, not a legitimate test gap. */

function baseResult(status: (typeof PRESENTED_RESULT_STATUSES)[number]) {
  return {
    status,
    title: "Create project Atlas",
    summary: "Project Atlas created.",
    facts: [{ label: "Name", value: "Atlas" }],
    warnings: [],
    references: [],
  };
}

describe("T15-A: presentedResultSchema — all seven statuses", () => {
  it.each(PRESENTED_RESULT_STATUSES)("accepts status %s", (status) => {
    expect(() => presentedResultSchema.parse(baseResult(status))).not.toThrow();
  });

  it("includes the deliberate no-op status (readiness A5)", () => {
    expect(PRESENTED_RESULT_STATUSES).toContain("no_change_needed");
    expect(PRESENTED_RESULT_STATUSES).toHaveLength(7);
  });

  it("rejects an unrecognized status", () => {
    expect(() => presentedResultSchema.parse(baseResult("in_progress" as never))).toThrow();
  });
});

describe("T15-A: strict unknown-key rejection", () => {
  it("rejects an extra top-level key on the presentation", () => {
    expect(() => presentedResultSchema.parse({ ...baseResult("succeeded"), extra: "nope" })).toThrow();
  });

  it("rejects an extra key on a fact", () => {
    expect(() =>
      presentedResultSchema.parse({
        ...baseResult("succeeded"),
        facts: [{ label: "Name", value: "Atlas", sneaky: true }],
      }),
    ).toThrow();
  });

  it("rejects an extra key on a warning", () => {
    expect(() =>
      presentedResultSchema.parse({
        ...baseResult("succeeded"),
        warnings: [{ code: "w1", message: "careful", sneaky: true }],
      }),
    ).toThrow();
  });

  it("rejects an extra key on a reference", () => {
    expect(() =>
      presentedResultSchema.parse({
        ...baseResult("succeeded"),
        references: [
          {
            id: "r1",
            conversationId: "c1",
            entityType: "project",
            externalId: "abc123",
            displayName: "Atlas",
            sourceRunId: "run1",
            bindings: {},
            status: "active",
            verifiedAt: "2026-07-26T00:00:00.000Z",
            sneaky: true,
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects an extra key on the envelope", () => {
    expect(() =>
      presentedResultEnvelopeSchema.parse({ presentation: baseResult("succeeded"), sneaky: true }),
    ).toThrow();
  });

  it("rejects an extra key on the confirmation control", () => {
    expect(() =>
      presentedResultEnvelopeSchema.parse({
        presentation: baseResult("pending_confirmation"),
        confirmation: { id: "c1", nonce: "n1", expiresAt: "2026-07-26T00:00:00.000Z", sneaky: true },
      }),
    ).toThrow();
  });
});

describe("T15-A: the recovery union", () => {
  it.each([
    { kind: "view_operation", label: "View operation", operationId: "op-1" },
    { kind: "retry_read", label: "Retry", readAttemptId: "attempt-1" },
    { kind: "start_new_chat", label: "Start a new chat" },
  ])("accepts recovery kind %o", (recovery) => {
    expect(() => presentedResultSchema.parse({ ...baseResult("failed"), recovery })).not.toThrow();
  });

  it("rejects an unrecognized recovery kind", () => {
    expect(() =>
      presentedResultSchema.parse({ ...baseResult("failed"), recovery: { kind: "retry_write", label: "x" } }),
    ).toThrow();
  });

  it("rejects a recovery variant missing its discriminated field", () => {
    expect(() =>
      presentedResultSchema.parse({ ...baseResult("failed"), recovery: { kind: "view_operation", label: "x" } }),
    ).toThrow();
  });
});

describe("T15-A: diagnostic JSON/value/byteLength validation", () => {
  it("accepts a diagnostic whose byteLength matches the exact UTF-8 length of value", () => {
    const value = { ok: true, count: 3 };
    const byteLength = Buffer.byteLength(JSON.stringify(value), "utf8");
    expect(() => diagnosticViewSchema.parse({ kind: "sanitized_receipt", byteLength, value })).not.toThrow();
  });

  it("rejects a diagnostic whose byteLength does not match value", () => {
    expect(() =>
      diagnosticViewSchema.parse({ kind: "sanitized_receipt", byteLength: 999, value: { ok: true } }),
    ).toThrow();
  });

  it("rejects a diagnostic value that is not valid JSON (e.g. undefined leaves via a function)", () => {
    expect(() =>
      diagnosticViewSchema.parse({ kind: "sanitized_receipt", byteLength: 0, value: (() => {}) as never }),
    ).toThrow();
  });

  it("rejects a byteLength over the model-facing tool-result budget", () => {
    const bigString = "x".repeat(DIAGNOSTIC_VALUE_MAX_BYTES + 1);
    expect(() =>
      diagnosticViewSchema.parse({
        kind: "sanitized_receipt",
        byteLength: DIAGNOSTIC_VALUE_MAX_BYTES + 1,
        value: bigString,
      }),
    ).toThrow();
  });
});

describe("T15-A: canonical bounds", () => {
  it(`rejects more than ${PRESENTED_RESULT_MAX_FACTS} facts`, () => {
    const facts = Array.from({ length: PRESENTED_RESULT_MAX_FACTS + 1 }, (_, i) => ({ label: `f${i}`, value: "v" }));
    expect(() => presentedResultSchema.parse({ ...baseResult("succeeded"), facts })).toThrow();
  });

  it(`accepts exactly ${PRESENTED_RESULT_MAX_FACTS} facts`, () => {
    const facts = Array.from({ length: PRESENTED_RESULT_MAX_FACTS }, (_, i) => ({ label: `f${i}`, value: "v" }));
    expect(() => presentedResultSchema.parse({ ...baseResult("succeeded"), facts })).not.toThrow();
  });

  it(`rejects more than ${PRESENTED_RESULT_MAX_WARNINGS} warnings`, () => {
    const warnings = Array.from({ length: PRESENTED_RESULT_MAX_WARNINGS + 1 }, (_, i) => ({
      code: `w${i}`,
      message: "careful",
    }));
    expect(() => presentedResultSchema.parse({ ...baseResult("succeeded"), warnings })).toThrow();
  });

  it(`rejects more than ${PRESENTED_RESULT_MAX_REFERENCES} references`, () => {
    const references = Array.from({ length: PRESENTED_RESULT_MAX_REFERENCES + 1 }, (_, i) => ({
      id: `r${i}`,
      conversationId: "c1",
      entityType: "project",
      externalId: "abc123",
      displayName: "Atlas",
      sourceRunId: "run1",
      bindings: {},
      status: "active" as const,
      verifiedAt: "2026-07-26T00:00:00.000Z",
    }));
    expect(() => presentedResultSchema.parse({ ...baseResult("succeeded"), references })).toThrow();
  });

  it("rejects an oversized title", () => {
    expect(() => presentedResultSchema.parse({ ...baseResult("succeeded"), title: "x".repeat(600) })).toThrow();
  });
});

describe("T15-A: absence of any durable nonce or live control in the envelope", () => {
  it("the presentation schema itself has no nonce-shaped key at any level", () => {
    const shape = presentedResultSchema.shape;
    const keys = [
      ...Object.keys(shape),
      ...Object.keys((shape.facts as unknown as { element: { shape: object } }).element.shape),
      ...Object.keys((shape.warnings as unknown as { element: { shape: object } }).element.shape),
      ...Object.keys((shape.references as unknown as { element: { shape: object } }).element.shape),
    ];
    expect(keys.some((k) => /nonce|secret|token|password|credential/iu.test(k))).toBe(false);
  });

  it("assertNoStrayLiveControl passes for a real pending_confirmation envelope", () => {
    const envelope = decodePresentedResultEnvelope({
      presentation: baseResult("pending_confirmation"),
      confirmation: { id: "c1", nonce: "n1", expiresAt: "2026-07-26T00:00:00.000Z" },
    });
    expect(() => assertNoStrayLiveControl(envelope)).not.toThrow();
  });

  it("assertNoStrayLiveControl fails closed if a nonce-shaped field is smuggled into presentation", () => {
    // The schema itself already rejects an unknown top-level key (proven above);
    // this exercises the defensive walk directly against a value that bypasses
    // the schema, in case a future refactor adds a permissive field somewhere.
    const smuggled = {
      presentation: { ...baseResult("succeeded"), sessionToken: "abc" },
    } as unknown as import("../../src/assistant-v2/presentation/presented-result.js").PresentedResultEnvelope;
    expect(() => assertNoStrayLiveControl(smuggled)).toThrow(/stray_live_control_field/);
  });

  it("assertNoStrayLiveControl does NOT walk diagnostic.value (arbitrary sanitized Clockify data)", () => {
    // A real Clockify entity can legitimately have a field literally named
    // "token" or similar; the diagnostic blob must not false-positive.
    const envelope = decodePresentedResultEnvelope({
      presentation: baseResult("succeeded"),
      diagnostic: { kind: "sanitized_receipt", byteLength: 36, value: { apiToken: "harmless-entity-field" } },
    });
    expect(() => assertNoStrayLiveControl(envelope)).not.toThrow();
  });

  it("the confirmation nonce is the only live control, and it is optional", () => {
    const envelope = decodePresentedResultEnvelope({ presentation: baseResult("succeeded") });
    expect(envelope.confirmation).toBeUndefined();
    expect(() => assertNoStrayLiveControl(envelope)).not.toThrow();
  });
});

describe("T15-A: decodePresentedResultEnvelope snapshots", () => {
  it("round-trips a succeeded receipt envelope", () => {
    const envelope = decodePresentedResultEnvelope({
      presentation: baseResult("succeeded"),
      actionResultId: "ar-1",
      diagnostic: { kind: "sanitized_receipt", byteLength: 11, value: { ok: true } },
    });
    expect(envelope).toMatchInlineSnapshot(`
      {
        "actionResultId": "ar-1",
        "diagnostic": {
          "byteLength": 11,
          "kind": "sanitized_receipt",
          "value": {
            "ok": true,
          },
        },
        "presentation": {
          "facts": [
            {
              "label": "Name",
              "value": "Atlas",
            },
          ],
          "references": [],
          "status": "succeeded",
          "summary": "Project Atlas created.",
          "title": "Create project Atlas",
          "warnings": [],
        },
      }
    `);
  });

  it("round-trips a no_change_needed envelope (deliberate no-op, readiness A5)", () => {
    const envelope = decodePresentedResultEnvelope({
      presentation: {
        ...baseResult("no_change_needed"),
        summary: "",
        warnings: [{ code: "warning_0", message: "No running timer to stop." }],
      },
      actionResultId: "ar-noop",
    });
    expect(envelope.presentation.status).toBe("no_change_needed");
    expect(envelope.presentation.warnings).toEqual([{ code: "warning_0", message: "No running timer to stop." }]);
  });

  it("round-trips a pending_confirmation envelope with the live control", () => {
    const envelope = decodePresentedResultEnvelope({
      presentation: baseResult("pending_confirmation"),
      confirmation: { id: "c1", nonce: "n1", expiresAt: "2026-07-26T00:00:00.000Z" },
    });
    expect(envelope.confirmation).toEqual({ id: "c1", nonce: "n1", expiresAt: "2026-07-26T00:00:00.000Z" });
    expect(envelope.presentation.status).toBe("pending_confirmation");
  });
});
