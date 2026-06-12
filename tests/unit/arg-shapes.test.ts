import { describe, expect, it } from "vitest";
import { z } from "zod";
import { formatZodIssues, zNumberLike, zStringList } from "../../src/harness/arg-shapes.js";
import { executeAction } from "../../src/harness/actions.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext } from "../../src/harness/action.js";

function makeContext(fake: FakeWorkspace): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy: defaultAdminPolicy(),
    clockify: fake.client,
    now: () => new Date("2026-06-06T00:00:00.000Z"),
  };
}

describe("zStringList", () => {
  it("coerces a bare string to a single-element list (the planner's scalar habit)", () => {
    expect(zStringList().parse("u1")).toEqual(["u1"]);
  });

  it("passes arrays through unchanged and rejects non-strings", () => {
    expect(zStringList().parse(["u1", "u2"])).toEqual(["u1", "u2"]);
    expect(() => zStringList().parse(42)).toThrow();
  });

  it("passes the caller's constrained schema through (min(1) list still enforced)", () => {
    expect(() => zStringList(z.array(z.string().min(1)).min(1)).parse([])).toThrow();
  });
});

describe("zNumberLike", () => {
  it("coerces a numeric string ('40.5' → 40.5) and leaves real numbers alone", () => {
    expect(zNumberLike().parse("40.5")).toBe(40.5);
    expect(zNumberLike().parse(40)).toBe(40);
  });

  it("never coerces an empty string to 0 (a silent $0 amount would be a money bug)", () => {
    expect(() => zNumberLike().parse("")).toThrow();
    expect(() => zNumberLike().parse("abc")).toThrow();
  });

  it("applies the inner constraint AFTER coercion ('-3' fails .positive(), not the type check)", () => {
    expect(() => zNumberLike(z.number().positive()).parse("-3")).toThrow(/greater than/i);
    expect(zNumberLike(z.number().positive()).parse("3")).toBe(3);
  });
});

describe("formatZodIssues", () => {
  it("prefixes each issue with its field path so the agent loop can self-correct", () => {
    const schema = z.object({ assigneeIds: z.array(z.string()), items: z.array(z.object({ amount: z.number() })) });
    const result = schema.safeParse({ assigneeIds: 42, items: [{ amount: "x" }] });
    if (result.success) throw new Error("expected failure");
    const message = formatZodIssues(result.error);
    expect(message).toContain("assigneeIds: ");
    expect(message).toContain("items.0.amount: ");
  });

  it("renders a root-level issue without a dangling prefix", () => {
    const schema = z.string();
    const result = schema.safeParse(42);
    if (result.success) throw new Error("expected failure");
    expect(formatZodIssues(result.error)).not.toMatch(/^: /);
  });
});

describe("end-to-end through the executor", () => {
  it("tasks_create accepts assigneeIds as a bare string (no invalid_args)", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "p1", name: "Apollo" }],
      users: [{ id: "u1", name: "Alice" }],
    });
    const result = await executeAction({
      actionName: "clockify_tasks_create",
      args: { projectId: "p1", name: "AIASSIST_SMOKE_t", assigneeIds: "Alice" },
      context: makeContext(fake),
    });
    // The scalar coerces to a list, then the assignee resolves by name.
    if (result.kind === "receipt" && !result.receipt.ok) {
      throw new Error(`unexpected error receipt: ${result.receipt.code} ${result.receipt.message}`);
    }
    expect(result.kind).not.toBe("clarify");
  });

  it("an invalid_args receipt names the offending FIELD", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Apollo" }] });
    const result = await executeAction({
      actionName: "clockify_tasks_create",
      args: { projectId: "p1", name: "t", assigneeIds: 42 },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || result.receipt.ok) throw new Error("expected an error receipt");
    expect(result.receipt.code).toBe("invalid_args");
    expect(result.receipt.message).toContain("assigneeIds");
  });

  it("expenses_create accepts a numeric-string amount", async () => {
    const fake = createFakeWorkspace({ expenseCategories: [{ id: "c1", name: "Travel" }] });
    const result = await executeAction({
      actionName: "clockify_expenses_create",
      args: { amount: "125", categoryName: "Travel" },
      context: makeContext(fake),
    });
    if (result.kind !== "preview") throw new Error(`expected a preview, got ${result.kind}`);
    expect((result.operation.payload as any).input.amountMinor).toBe(12500);
  });
});
