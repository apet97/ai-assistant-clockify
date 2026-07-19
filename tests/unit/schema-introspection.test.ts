import { describe, expect, it } from "vitest";
import { z } from "zod";
import { inspectZodSchema } from "../../src/harness/schema-introspection.js";

describe("inspectZodSchema — pinned Zod 3 compatibility", () => {
  it("normalizes the wrapper, object, collection, and union shapes used by argument summaries", () => {
    const object = z.object({ name: z.string() });
    const optional = z.string().optional();
    const array = z.array(z.number());
    const union = z.union([z.string(), z.boolean()]);

    expect(inspectZodSchema(optional)).toMatchObject({ typeName: "ZodOptional", innerType: optional.unwrap() });
    expect(inspectZodSchema(object).shape).toEqual({ name: object.shape.name });
    expect(inspectZodSchema(array)).toMatchObject({ typeName: "ZodArray", type: array.element });
    expect(inspectZodSchema(union).options).toEqual(union.options);
  });

  it("fails closed to an empty description for a non-Zod value", () => {
    expect(inspectZodSchema({ typeName: "ZodObject" })).toEqual({});
  });
});
