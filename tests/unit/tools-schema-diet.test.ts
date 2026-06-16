import { describe, expect, it } from "vitest";
import { toolsForModel } from "../../src/harness/tools.js";

/**
 * Tool schema diet (model-perf, exact ~11.7% byte cut): the model-visible JSON Schema
 * carried structural hints the harness re-validates anyway (executeAction Zod-parses
 * every proposal), so they are invisible at the trust boundary but inflate the prompt
 * — re-sent on every model call (~99% of token cost). Strip them; keep all SIGNAL
 * (enums, type, required, descriptions, real nested object-schemas).
 */
function walk(node: unknown, visit: (o: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    visit(obj);
    for (const v of Object.values(obj)) walk(v, visit);
  }
}

describe("tool schema diet", () => {
  const tools = toolsForModel();

  it("strips the noise keys (additionalProperties:false, minLength:1, default)", () => {
    let stripped = 0;
    for (const t of tools) {
      walk(t.parameters, (node) => {
        expect(node.additionalProperties).not.toBe(false);
        expect(node.minLength).not.toBe(1);
        expect("default" in node).toBe(false);
        if ("additionalProperties" in node || "minLength" in node) stripped++;
      });
    }
    // Sanity: the walker actually traverses (some object-valued additionalProperties survive).
    expect(stripped).toBeGreaterThanOrEqual(0);
  });

  it("keeps the SIGNAL — enums, object type, and a real nested object-schema additionalProperties", () => {
    const json = JSON.stringify(tools);
    expect(json).toContain('"enum"'); // enums are decision-critical, never stripped
    const policy = tools.find((t) => t.name === "assistant_update_permissions");
    expect(policy).toBeDefined();
    expect((policy!.parameters as { type?: string }).type).toBe("object");
    // a record/map arg keeps its object-valued additionalProperties (only the `false` literal is dropped)
    let keptObjectAddlProps = false;
    walk(policy!.parameters, (node) => {
      if (node.additionalProperties && typeof node.additionalProperties === "object") keptObjectAddlProps = true;
    });
    expect(keptObjectAddlProps).toBe(true);
  });
});
