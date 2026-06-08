import { describe, expect, it } from "vitest";
import { z } from "zod";
import { summarizeArgs } from "../../src/harness/arg-summary.js";
import { ACTION_CATALOG, getAction } from "../../src/harness/catalog.js";

describe("summarizeArgs — plain Zod schemas", () => {
  it("renders a required scalar field", () => {
    expect(summarizeArgs(z.object({ name: z.string().min(1) }))).toBe("name: string");
  });

  it("marks optional fields with ?", () => {
    expect(summarizeArgs(z.object({ count: z.number().optional() }))).toBe("count?: number");
  });

  it("treats a default as optional", () => {
    expect(summarizeArgs(z.object({ unit: z.string().default("major") }))).toBe("unit?: string");
  });

  it("renders booleans and enums (enum values inline)", () => {
    expect(summarizeArgs(z.object({ flag: z.boolean() }))).toBe("flag: boolean");
    expect(summarizeArgs(z.object({ status: z.enum(["A", "B", "C"]) }))).toBe("status: A|B|C");
  });

  it("renders arrays as <elem>[] and nested objects as object", () => {
    expect(summarizeArgs(z.object({ tags: z.array(z.string()).optional() }))).toBe("tags?: string[]");
    expect(summarizeArgs(z.object({ items: z.array(z.object({ x: z.string() })).optional() }))).toBe(
      "items?: object[]",
    );
    expect(summarizeArgs(z.object({ meta: z.object({ x: z.string() }) }))).toBe("meta: object");
  });

  it("renders a union as a|b", () => {
    expect(summarizeArgs(z.object({ when: z.union([z.boolean(), z.object({})]) }))).toBe("when: boolean|object");
  });

  it("unwraps z.preprocess to reach the underlying object", () => {
    const schema = z.preprocess((x) => x, z.object({ a: z.string() }));
    expect(summarizeArgs(schema)).toBe("a: string");
  });

  it("renders an empty object as (none)", () => {
    expect(summarizeArgs(z.object({}).strip())).toBe("(none)");
  });

  it("truncates a long enum with an ellipsis", () => {
    const big = z.object({ kind: z.enum(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]) });
    const sig = summarizeArgs(big);
    expect(sig.startsWith("kind: a|b|c|d|e|f|g|h")).toBe(true);
    expect(sig).toContain("…");
  });

  it("keeps a signature within a bounded length", () => {
    const wide = z.object(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`field${i}`, z.string()])));
    expect(summarizeArgs(wide).length).toBeLessThanOrEqual(201);
  });
});

describe("summarizeArgs — real catalog actions", () => {
  it("create_work_package shows the nested entities and the startTimer union", () => {
    const sig = summarizeArgs(getAction("clockify_create_work_package")!.schema);
    expect(sig).toContain("project?:");
    expect(sig).toContain("startTimer?:");
    expect(sig).toContain("boolean"); // startTimer is boolean|object
  });

  it("invoices_create shows clientName and items[]", () => {
    const sig = summarizeArgs(getAction("clockify_invoices_create")!.schema);
    expect(sig).toContain("clientName?: string");
    expect(sig).toContain("items?: object[]");
  });

  it("tags_delete shows both id? and name?", () => {
    const sig = summarizeArgs(getAction("clockify_tags_delete")!.schema);
    expect(sig).toContain("id?: string");
    expect(sig).toContain("name?: string");
  });

  it("list_entities shows the required entityType enum values", () => {
    const sig = summarizeArgs(getAction("clockify_list_entities")!.schema);
    expect(sig).toContain("entityType:");
    expect(sig).not.toContain("entityType?:"); // it is required
    expect(sig).toContain("tag|project");
  });

  it("update_permissions (preprocess) shows the groups field", () => {
    const sig = summarizeArgs(getAction("assistant_update_permissions")!.schema);
    expect(sig).toContain("groups");
  });

  it("never throws on any catalog action and always returns a non-empty string", () => {
    for (const action of ACTION_CATALOG) {
      const sig = summarizeArgs(action.schema);
      expect(typeof sig).toBe("string");
      expect(sig.length).toBeGreaterThan(0);
    }
  });
});
