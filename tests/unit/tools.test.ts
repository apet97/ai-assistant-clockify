import { describe, expect, it } from "vitest";
import { z } from "zod";
import { actionParametersSchema, toolsForModel } from "../../src/harness/tools.js";
import { ACTION_CATALOG, getAction } from "../../src/harness/catalog.js";
import { INTERNAL_ACTION_CATALOG } from "../../src/harness/api-catalog.js";

function paramsFor(name: string): Record<string, unknown> {
  const tool = toolsForModel(INTERNAL_ACTION_CATALOG).find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.parameters;
}

describe("actionParametersSchema", () => {
  it("produces an object JSON schema and strips the $schema key", () => {
    const schema = actionParametersSchema(z.object({ name: z.string().min(1), count: z.number().optional() }));
    expect(schema.type).toBe("object");
    expect(schema).not.toHaveProperty("$schema");
    const props = schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("name");
    expect(props).toHaveProperty("count");
    expect(schema.required).toEqual(["name"]);
  });

  it("unwraps z.preprocess to the inner object schema", () => {
    const schema = actionParametersSchema(z.preprocess((x) => x, z.object({ a: z.string() })));
    expect(schema.type).toBe("object");
    expect((schema.properties as Record<string, unknown>)).toHaveProperty("a");
  });
});

describe("toolsForModel", () => {
  it("returns one tool per catalog action with a non-empty description and an object schema", () => {
    const tools = toolsForModel(INTERNAL_ACTION_CATALOG);
    expect(tools.length).toBe(ACTION_CATALOG.length);
    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters.type).toBe("object");
      expect(tool.parameters).not.toHaveProperty("$schema");
    }
  });

  it("exposes the canonical arg shapes (create_work_package nests project, not projectName)", () => {
    const props = paramsFor("clockify_create_work_package").properties as Record<string, unknown>;
    expect(props).toHaveProperty("project");
    expect(props).toHaveProperty("startTimer");
    expect(props).not.toHaveProperty("projectName");
  });

  it("invoices_create exposes clientName + items; update_permissions exposes groups", () => {
    const inv = paramsFor("clockify_invoices_create").properties as Record<string, unknown>;
    expect(inv).toHaveProperty("clientName");
    expect(inv).toHaveProperty("items");
    const perm = paramsFor("assistant_update_permissions").properties as Record<string, unknown>;
    expect(perm).toHaveProperty("groups");
  });

  it("a no-arg action yields an empty-properties object schema", () => {
    const props = paramsFor("assistant_show_permissions").properties as Record<string, unknown>;
    expect(Object.keys(props)).toHaveLength(0);
  });

  it("zStringList/zNumberLike fields still advertise the CANONICAL types to the model", () => {
    // The harness tolerates a scalar, but the tool schema must keep nudging the
    // model toward the canonical array/number (preprocess unwraps to the inner).
    const tasks = paramsFor("clockify_tasks_create").properties as Record<string, { type?: string }>;
    expect(tasks.assigneeIds?.type).toBe("array");
    const expenses = paramsFor("clockify_expenses_create").properties as Record<string, { type?: string }>;
    expect(expenses.amount?.type).toBe("number");
  });

  it("the tool definitions carry no secret-bearing field names", () => {
    const serialized = JSON.stringify(toolsForModel(INTERNAL_ACTION_CATALOG));
    expect(serialized).not.toContain("addonToken");
    expect(serialized).not.toContain("sessionSecret");
    expect(serialized.toLowerCase()).not.toContain("apikey");
  });

  it("getAction stays the source of truth (every tool maps to a real action)", () => {
    for (const tool of toolsForModel(INTERNAL_ACTION_CATALOG)) {
      expect(getAction(tool.name)).toBeDefined();
    }
  });
});
