import { describe, expect, it } from "vitest";
import { executeAction } from "../../src/harness/actions.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext } from "../../src/harness/catalog.js";
import type { WorkspaceClient } from "../../src/clockify/client.js";
import { DefinitiveWriteFailure } from "../../src/clockify/write-outcome.js";

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
  it("preflights a missing task parent before creating any earlier entity", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_create_work_package",
      args: { tag: { name: "urgent" }, task: { name: "Login" } },
      context: ctxWith(fake),
    });

    expect(result.kind).toBe("clarify");
    expect(fake.counts.createTag ?? 0).toBe(0);
    expect(fake.counts.createTask ?? 0).toBe(0);
  });

  it("returns partial and retains a just-created project when the later task definitively fails", async () => {
    const fake = createFakeWorkspace();
    const client: WorkspaceClient = {
      ...fake.client,
      createTaskAtomic: async () => {
        throw new DefinitiveWriteFailure("POST", "/tasks", "Clockify rejected the task", 400);
      },
    };
    const result = await executeAction({
      actionName: "clockify_create_work_package",
      args: { project: { name: "Phoenix" }, task: { name: "Login" } },
      context: ctxWith(fake, client),
    });
    expect(result).toMatchObject({ kind: "partial", receipt: { ok: true } });
    expect(fake.counts.createProjectAtomic).toBe(1);
    expect(fake.state.projects.some((project) => project.name === "Phoenix")).toBe(true);
    expect(fake.state.deleted).toEqual([]);
    expect(fake.counts.startTimeEntryAtomic ?? 0).toBe(0);
  });

  it("reports the retained client + project chain when the task definitively fails", async () => {
    const fake = createFakeWorkspace();
    const client: WorkspaceClient = {
      ...fake.client,
      createTaskAtomic: async () => {
        throw new DefinitiveWriteFailure("POST", "/tasks", "boom", 400);
      },
    };
    const result = await executeAction({
      actionName: "clockify_create_work_package",
      args: { client: { name: "Globex" }, project: { name: "Phoenix" }, task: { name: "Login" } },
      context: ctxWith(fake, client),
    });
    expect(result).toMatchObject({ kind: "partial", receipt: { ok: true } });
    expect(fake.state.deleted).toEqual([]);
    expect(fake.state.clients.some((client) => client.name === "Globex")).toBe(true);
    expect(fake.state.projects.some((project) => project.name === "Phoenix")).toBe(true);
  });

  it("does not roll back a REUSED entity (only what this op created)", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p-existing", name: "Phoenix" }] });
    const client: WorkspaceClient = {
      ...fake.client,
      createTaskAtomic: async () => {
        throw new DefinitiveWriteFailure("POST", "/tasks", "boom", 400);
      },
    };
    const result = await executeAction({
      actionName: "clockify_create_work_package",
      args: { project: { name: "Phoenix" }, task: { name: "Login" } },
      context: ctxWith(fake, client),
    });
    expect(result.kind === "receipt" && !(result as { receipt: { ok: boolean } }).receipt.ok).toBe(true);
    expect(fake.counts.createProjectAtomic ?? 0).toBe(0); // reused, not created
    expect(fake.state.deleted).toHaveLength(0); // nothing created, nothing to roll back
  });

  it("returns partial for a definitive timer failure and retains the created project", async () => {
    const fake = createFakeWorkspace();
    const client: WorkspaceClient = {
      ...fake.client,
      startTimeEntryAtomic: async () => {
        throw new DefinitiveWriteFailure("POST", "/time-entries", "timer service down", 503);
      },
    };
    const result = await executeAction({
      actionName: "clockify_create_work_package",
      args: { project: { name: "Phoenix" }, startTimer: true },
      context: ctxWith(fake, client),
    });
    expect(result).toMatchObject({ kind: "partial", receipt: { ok: true } });
    expect(result.kind === "partial" && result.receipt.changed?.created?.some((entity) => entity.type === "project")).toBe(true);
    expect(fake.counts.createProjectAtomic).toBe(1);
    expect(fake.state.deleted).toHaveLength(0); // project kept — a timer failure is not fatal
  });
});
