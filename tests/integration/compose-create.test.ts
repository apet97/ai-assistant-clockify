import { describe, expect, it } from "vitest";
import { executeAction } from "../../src/harness/actions.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext } from "../../src/harness/catalog.js";
import type { WorkspaceClient } from "../../src/clockify/client.js";

function ctxWith(fake: FakeWorkspace, client: WorkspaceClient = fake.client): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy: defaultAdminPolicy(),
    clockify: client,
    now: () => new Date("2026-06-05T00:00:00.000Z"),
  };
}

describe("create_work_package — atomic composition (Phase 3)", () => {
  it("rolls back a just-created project when a later required step (task) fails", async () => {
    const fake = createFakeWorkspace();
    const client: WorkspaceClient = {
      ...fake.client,
      createTask: async () => {
        throw new Error("Clockify rejected the task");
      },
    };
    const result = await executeAction({
      actionName: "clockify_create_work_package",
      args: { project: { name: "Phoenix" }, task: { name: "Login" } },
      context: ctxWith(fake, client),
    });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      expect(result.receipt.ok).toBe(false);
      if (!result.receipt.ok) expect(result.receipt.code).toBe("composition_failed");
    }
    // the project we created was rolled back; the timer never ran
    expect(fake.counts.createProject).toBe(1);
    expect(fake.state.deleted.some((d) => d.entityType === "project")).toBe(true);
    expect(fake.counts.createTimeEntry ?? 0).toBe(0);
  });

  it("rolls back the whole created chain (client + project) when the task fails", async () => {
    const fake = createFakeWorkspace();
    const client: WorkspaceClient = {
      ...fake.client,
      createTask: async () => {
        throw new Error("boom");
      },
    };
    await executeAction({
      actionName: "clockify_create_work_package",
      args: { client: { name: "Globex" }, project: { name: "Phoenix" }, task: { name: "Login" } },
      context: ctxWith(fake, client),
    });
    const deletedTypes = fake.state.deleted.map((d) => d.entityType);
    expect(deletedTypes).toContain("project");
    expect(deletedTypes).toContain("client");
  });

  it("does not roll back a REUSED entity (only what this op created)", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p-existing", name: "Phoenix" }] });
    const client: WorkspaceClient = {
      ...fake.client,
      createTask: async () => {
        throw new Error("boom");
      },
    };
    const result = await executeAction({
      actionName: "clockify_create_work_package",
      args: { project: { name: "Phoenix" }, task: { name: "Login" } },
      context: ctxWith(fake, client),
    });
    expect(result.kind === "receipt" && !(result as { receipt: { ok: boolean } }).receipt.ok).toBe(true);
    expect(fake.counts.createProject ?? 0).toBe(0); // reused, not created
    expect(fake.state.deleted).toHaveLength(0); // nothing created, nothing to roll back
  });

  it("treats a failing timer as best-effort: keeps the created project and warns (no rollback)", async () => {
    const fake = createFakeWorkspace();
    const client: WorkspaceClient = {
      ...fake.client,
      startTimeEntry: async () => {
        throw new Error("timer service down");
      },
    };
    const result = await executeAction({
      actionName: "clockify_create_work_package",
      args: { project: { name: "Phoenix" }, startTimer: true },
      context: ctxWith(fake, client),
    });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt" && result.receipt.ok) {
      expect((result.receipt.changed?.created ?? []).some((e) => e.type === "project")).toBe(true);
      expect((result.receipt.warnings ?? []).some((w) => /timer/i.test(w.message))).toBe(true);
    } else {
      throw new Error("expected a success receipt with a warning");
    }
    expect(fake.counts.createProject).toBe(1);
    expect(fake.state.deleted).toHaveLength(0); // project kept — a timer failure is not fatal
  });
});
