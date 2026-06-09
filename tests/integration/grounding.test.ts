import { describe, expect, it } from "vitest";
import { executeAction } from "../../src/harness/actions.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext } from "../../src/harness/catalog.js";

function ctx(fake: FakeWorkspace): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy: defaultAdminPolicy(),
    clockify: fake.client,
    now: () => new Date("2026-06-05T00:00:00.000Z"),
  };
}

describe("Phase 4 — constraint surfacing in previews", () => {
  it("warns IN THE PREVIEW that line items need a configured invoice item type (no $0 surprise)", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "c1", name: "qwen" }] });
    const result = await executeAction({
      actionName: "clockify_invoices_create",
      args: { clientName: "qwen", items: [{ description: "charge", quantity: 1, amount: 1000 }] },
      context: ctx(fake),
    });
    expect(result.kind).toBe("preview");
    if (result.kind === "preview") {
      expect(result.preview.warnings.some((w) => /invoice item type/i.test(w))).toBe(true);
    }
  });

  it("does not add the item-type caveat when the invoice has no line items", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "c1", name: "qwen" }] });
    const result = await executeAction({
      actionName: "clockify_invoices_create",
      args: { clientName: "qwen" },
      context: ctx(fake),
    });
    expect(result.kind).toBe("preview");
    if (result.kind === "preview") {
      expect(result.preview.warnings.some((w) => /invoice item type/i.test(w))).toBe(false);
    }
  });
});

describe("Phase 4 — clarifies are specific (offer options, never 'go list them')", () => {
  it("invoices_create offers the existing clients when the named one isn't found", async () => {
    const fake = createFakeWorkspace({
      clients: [
        { id: "c1", name: "Acme" },
        { id: "c2", name: "Globex" },
      ],
    });
    const result = await executeAction({
      actionName: "clockify_invoices_create",
      args: { clientName: "Qwen" },
      context: ctx(fake),
    });
    expect(result.kind).toBe("clarify");
    if (result.kind === "clarify") {
      expect((result.options ?? []).length).toBeGreaterThan(0);
      expect(result.message.toLowerCase()).not.toContain("list your");
    }
  });

  it("projects_delete offers existing projects when the named one isn't found", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Website" }] });
    const result = await executeAction({
      actionName: "clockify_projects_delete",
      args: { name: "Nonexistent" },
      context: ctx(fake),
    });
    expect(result.kind).toBe("clarify");
    if (result.kind === "clarify") expect((result.options ?? []).length).toBeGreaterThan(0);
  });

  it("tags_delete offers existing tags when the named one isn't found", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "Billable" }] });
    const result = await executeAction({
      actionName: "clockify_tags_delete",
      args: { name: "Nonexistent" },
      context: ctx(fake),
    });
    expect(result.kind).toBe("clarify");
    if (result.kind === "clarify") expect((result.options ?? []).length).toBeGreaterThan(0);
  });

  it("create_work_package offers existing clients when a project's clientName isn't found", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "c1", name: "Acme" }] });
    const result = await executeAction({
      actionName: "clockify_create_work_package",
      args: { project: { name: "Phoenix", clientName: "Nonexistent" } },
      context: ctx(fake),
    });
    expect(result.kind).toBe("clarify");
    if (result.kind === "clarify") {
      expect((result.options ?? []).length).toBeGreaterThan(0);
      expect(result.message.toLowerCase()).not.toContain("list your");
    }
  });
});
