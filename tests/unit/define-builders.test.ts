import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineReadAction,
  defineRiskyAction,
  type ActionContext,
  type ConfirmableOperation,
} from "../../src/harness/action.js";
import { successReceipt } from "../../src/harness/receipts.js";

/**
 * Parity proof for the two action builders. These assert that the builders emit
 * byte-identical ActionResult / operation shapes to the current hand-rolled
 * scaffold (the thing the existing per-area workflow tests rely on). The builder
 * keeps `args` typed from the schema; the operation `payload` is the established
 * `Record<string, unknown>` the commit casts (same ergonomics as the old code).
 */

// Minimal fake context: only the fields the builders' generated handlers/commits
// touch are real; the rest are cast placeholders.
const ctx = {} as unknown as ActionContext;

describe("defineRiskyAction", () => {
  const schema = z.object({ id: z.string().min(1) });
  type RiskyDef = Parameters<typeof defineRiskyAction<typeof schema>>[0];

  function build(previewImpl: RiskyDef["preview"], extra?: Partial<RiskyDef>) {
    return defineRiskyAction<typeof schema>({
      name: "demo_risky",
      description: "Demo risky action.",
      group: "work_structure",
      risks: ["high_risk_write"],
      schema,
      preview: previewImpl,
      async commit(_c, payload) {
        const { id } = payload as { id: string };
        return successReceipt({
          action: "demo_risky",
          entity: "demo",
          changed: { updated: [{ type: "demo", id }] },
        });
      },
      ...extra,
    });
  }

  it("(i) preview path emits a {kind:'preview'} with identity derived from name/group/risks", async () => {
    const action = build(async (_c, args) => ({
      actionLabel: "Do thing",
      targets: [{ type: "demo", id: args.id }],
      expectedChanges: ["change A"],
      reversibility: "reversible",
      warnings: ["careful"],
      payload: { id: args.id },
    }));

    const result = await action.handler(ctx, { id: "x1" });
    expect(result.kind).toBe("preview");
    if (result.kind !== "preview") throw new Error("expected preview");

    expect(result.preview).toEqual({
      actionLabel: "Do thing",
      featureGroup: "work_structure",
      riskLabels: ["high_risk_write"],
      targets: [{ type: "demo", id: "x1" }],
      expectedChanges: ["change A"],
      reversibility: "reversible",
      warnings: ["careful"],
    });
    expect(result.operation).toMatchObject({
      actionName: "demo_risky",
      featureGroup: "work_structure",
      risks: ["high_risk_write"],
      payload: { id: "x1" },
    });
    expect(result.operation.operationId).toEqual(expect.any(String));

    // Stored ActionDefinition identity is also derived from group/risks/name.
    expect(action.name).toBe("demo_risky");
    expect(action.featureGroup).toBe("work_structure");
    expect(action.risks).toEqual(["high_risk_write"]);
  });

  it("(i) warnings default to [] when the preview omits them", async () => {
    const action = build(async (_c, args) => ({
      actionLabel: "Do thing",
      targets: [{ type: "demo", id: args.id }],
      expectedChanges: ["change A"],
      reversibility: "reversible",
      payload: { id: args.id },
    }));

    const result = await action.handler(ctx, { id: "x1" });
    if (result.kind !== "preview") throw new Error("expected preview");
    expect(result.preview.warnings).toEqual([]);
  });

  it("(ii) preview callback returning {clarify, options} yields {kind:'clarify', message, options}", async () => {
    const options = [{ id: "a", label: "A" }];
    const action = build(async () => ({ clarify: "which one?", options }));

    const result = await action.handler(ctx, { id: "x1" });
    expect(result).toEqual({ kind: "clarify", message: "which one?", options });
  });

  it("(ii) clarify without options yields options: undefined", async () => {
    const action = build(async () => ({ clarify: "no matches" }));

    const result = await action.handler(ctx, { id: "x1" });
    expect(result).toEqual({ kind: "clarify", message: "no matches", options: undefined });
  });

  it("(iii) generated commit delegates to def.commit with operation.payload", async () => {
    let seen: Record<string, unknown> | undefined;
    const action = defineRiskyAction<typeof schema>({
      name: "demo_risky",
      description: "Demo risky action.",
      group: "work_structure",
      risks: ["high_risk_write"],
      schema,
      async preview(_c, args) {
        return {
          actionLabel: "x",
          targets: [],
          expectedChanges: [],
          reversibility: "r",
          payload: { id: args.id },
        };
      },
      async commit(_c, payload) {
        seen = payload;
        return successReceipt({ action: "demo_risky", entity: "demo" });
      },
    });

    const operation: ConfirmableOperation = {
      operationId: "op-p9",
      actionName: "demo_risky",
      featureGroup: "work_structure",
      risks: ["high_risk_write"],
      payload: { id: "p9" },
    };
    const receipt = await action.commit!(ctx, operation);
    expect(seen).toEqual({ id: "p9" });
    expect(receipt).toMatchObject({ ok: true });
  });

  it("(iv) idempotencyKey unwraps operation.payload", async () => {
    let seenPayload: Record<string, unknown> | undefined;
    const action = build(
      async (_c, args) => ({
        actionLabel: "x",
        targets: [],
        expectedChanges: [],
        reversibility: "r",
        payload: { id: args.id },
      }),
      {
        idempotencyKey(payload) {
          seenPayload = payload;
          return `key:${(payload as { id: string }).id}`;
        },
      },
    );

    const operation: ConfirmableOperation = {
      operationId: "op-k7",
      actionName: "demo_risky",
      featureGroup: "work_structure",
      risks: ["high_risk_write"],
      payload: { id: "k7" },
    };
    expect(action.idempotencyKey).toBeDefined();
    expect(action.idempotencyKey!(operation)).toBe("key:k7");
    expect(seenPayload).toEqual({ id: "k7" });
  });

  it("(iv) idempotencyKey is omitted entirely when not provided", () => {
    const action = build(async (_c, args) => ({
      actionLabel: "x",
      targets: [],
      expectedChanges: [],
      reversibility: "r",
      payload: { id: args.id },
    }));
    expect(action.idempotencyKey).toBeUndefined();
  });

  it("makes the one durable operation id available to preview, commit, and idempotency", async () => {
    const seen: { preview?: string; commit?: string; idempotency?: string } = {};
    const action = defineRiskyAction({
      name: "demo_durable",
      description: "Durable risky action.",
      group: "invoices",
      risks: ["billing"],
      schema,
      mutationWorkflow: "durable",
      async preview(_c, args, operationId) {
        seen.preview = operationId;
        return {
          actionLabel: "Create invoice",
          targets: [],
          expectedChanges: [],
          reversibility: "Delete it.",
          payload: { id: args.id },
          mutationPlan: {
            mode: "single" as const,
            steps: [{ id: "create-invoice", kind: "primary" as const }],
          },
        };
      },
      async commit(_c, _payload, operation) {
        seen.commit = operation.operationId;
        return successReceipt({ action: "demo_durable" });
      },
      idempotencyKey(_payload, operation) {
        seen.idempotency = operation.operationId;
        return operation.operationId;
      },
    });

    const preview = await action.handler(ctx, { id: "invoice-input" });
    if (preview.kind !== "preview") throw new Error("expected preview");
    expect(preview.operation.mutationPlan).toEqual({
      mode: "single",
      steps: [{ id: "create-invoice", kind: "primary" }],
    });
    expect(seen.preview).toBe(preview.operation.operationId);
    expect(action.mutationWorkflow).toBe("durable");

    await action.commit!(ctx, preview.operation);
    expect(action.idempotencyKey!(preview.operation)).toBe(preview.operation.operationId);
    expect(seen).toEqual({
      preview: preview.operation.operationId,
      commit: preview.operation.operationId,
      idempotency: preview.operation.operationId,
    });
  });

  it("passes resolveFeatureGroup through unchanged (receives args)", async () => {
    let seenArgs: { id: string } | undefined;
    const action = build(
      async (_c, args) => ({
        actionLabel: "x",
        targets: [],
        expectedChanges: [],
        reversibility: "r",
        payload: { id: args.id },
      }),
      {
        resolveFeatureGroup(args) {
          seenArgs = args as { id: string };
          return "invoices";
        },
      },
    );
    expect(action.resolveFeatureGroup).toBeDefined();
    expect(action.resolveFeatureGroup!({ id: "a" })).toBe("invoices");
    expect(seenArgs).toEqual({ id: "a" });
  });
});

describe("defineReadAction", () => {
  const schema = z.object({ id: z.string().min(1) });

  it("(v) yields {kind:'receipt'} wrapping the handler's receipt, and risks ['read']", async () => {
    const receipt = successReceipt({ action: "demo_read", entity: "demo", data: { ok: 1 } });
    const action = defineReadAction({
      name: "demo_read",
      description: "Demo read action.",
      group: "work_structure",
      schema,
      async handler() {
        return receipt;
      },
    });

    expect(action.risks).toEqual(["read"]);
    expect(action.featureGroup).toBe("work_structure");
    expect(action.commit).toBeUndefined();

    const result = await action.handler(ctx, { id: "x1" });
    expect(result).toEqual({ kind: "receipt", receipt });
  });
});
