import { describe, expect, it } from "vitest";
import { toolsForModel } from "../../src/harness/tools.js";

/**
 * Tool schema diet (model-perf, exact ~11.7% byte cut): the model-visible JSON Schema
 * carries the structural boundary the provider and harness both enforce. Keep
 * `additionalProperties:false`; only presentation-only noise may be stripped.
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

  it("keeps closed object schemas while stripping minLength:1 and defaults", () => {
    let closedObjects = 0;
    for (const t of tools) {
      walk(t.parameters, (node) => {
        if (node.type === "object" && node.properties) {
          expect(node.additionalProperties).toBe(false);
          closedObjects++;
        }
        expect(node.minLength).not.toBe(1);
        expect("default" in node).toBe(false);
      });
    }
    expect(closedObjects).toBeGreaterThan(100);
  });

  it("keeps the SIGNAL — enums, object type, and a real nested object-schema additionalProperties", () => {
    const json = JSON.stringify(tools);
    expect(json).toContain('"enum"'); // enums are decision-critical, never stripped
    const policy = tools.find((t) => t.name === "assistant_update_permissions");
    expect(policy).toBeDefined();
    expect((policy!.parameters as { type?: string }).type).toBe("object");
    // a record/map arg keeps its object-valued additionalProperties.
    let keptObjectAddlProps = false;
    walk(policy!.parameters, (node) => {
      if (node.additionalProperties && typeof node.additionalProperties === "object") keptObjectAddlProps = true;
    });
    expect(keptObjectAddlProps).toBe(true);
  });
});
