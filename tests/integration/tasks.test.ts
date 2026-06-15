import { describe, expect, it } from "vitest";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { type AdminPolicy, defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext } from "../../src/harness/action.js";

const NOW = new Date("2026-06-06T00:00:00.000Z");

function makeContext(fake: FakeWorkspace, policy: AdminPolicy = defaultAdminPolicy()): ActionContext {
  return { workspaceId: "ws-1", adminUserId: "admin-1", policy, clockify: fake.client, now: () => NOW };
}

const seed = () => ({
  projects: [{ id: "p1", name: "Website" }],
  tasks: [{ id: "t1", name: "Design", projectId: "p1" }],
});

describe("task actions", () => {
  it("clockify_tasks_list lists tasks under a project (read-gated by work_structure)", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({
      actionName: "clockify_tasks_list",
      args: { projectId: "p1" },
      context: makeContext(fake),
    });
    if (result.kind === "receipt" && result.receipt.ok) {
      expect((result.receipt.data as any).count).toBe(1);
    } else throw new Error("expected receipt");

    const off = defaultAdminPolicy();
    off.groups.work_structure = "off";
    const denied = await executeAction({
      actionName: "clockify_tasks_list",
      args: { projectId: "p1" },
      context: makeContext(fake, off),
    });
    if (denied.kind === "receipt" && !denied.receipt.ok) expect(denied.receipt.code).toBe("policy_denied");
    else throw new Error("expected policy_denied");
  });

  it("clockify_tasks_get fetches one task", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({
      actionName: "clockify_tasks_get",
      args: { projectId: "p1", id: "t1" },
      context: makeContext(fake),
    });
    if (result.kind === "receipt" && result.receipt.ok) {
      expect((result.receipt.data as any).entity).toMatchObject({ id: "t1", name: "Design" });
    } else throw new Error("expected receipt");
  });

  it("clockify_tasks_get resolves task + project by name (not just ids), clarifies on unknown", async () => {
    const fake = createFakeWorkspace(seed());
    const byName = await executeAction({
      actionName: "clockify_tasks_get",
      args: { projectName: "Website", name: "Design" },
      context: makeContext(fake),
    });
    if (byName.kind === "receipt" && byName.receipt.ok) {
      expect((byName.receipt.data as any).entity).toMatchObject({ id: "t1", name: "Design" });
    } else throw new Error(`expected a success receipt, got ${byName.kind}`);
    const ghost = await executeAction({
      actionName: "clockify_tasks_get",
      args: { projectName: "Website", name: "Ghost Task" },
      context: makeContext(fake),
    });
    expect(ghost.kind).toBe("clarify");
  });

  it("clockify_tasks_create creates a task (safe write)", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({
      actionName: "clockify_tasks_create",
      args: { projectId: "p1", name: "AIASSIST_SMOKE_task" },
      context: makeContext(fake),
    });
    if (result.kind === "receipt" && result.receipt.ok) {
      // projectId rides on the created ref so the task is one-click undoable.
      expect(result.receipt.changed?.created?.[0]).toMatchObject({ type: "task", projectId: "p1" });
    } else throw new Error("expected receipt");
    expect(fake.counts.createTask).toBe(1);
  });

  const seedWithUsers = () => ({
    ...seed(),
    users: [
      { id: "u1", name: "Alice", email: "alice@x.com", status: "ACTIVE" },
      { id: "u2", name: "Bob", email: "bob@x.com", status: "ACTIVE" },
    ],
  });

  it("clockify_tasks_create assigns members inline via assigneeIds (safe write)", async () => {
    const fake = createFakeWorkspace(seedWithUsers());
    const result = await executeAction({
      actionName: "clockify_tasks_create",
      args: { projectId: "p1", name: "AIASSIST_SMOKE_task", assigneeIds: ["u1", "u2"] },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected an ok receipt");
    const created = fake.state.tasks.find((t) => t.name === "AIASSIST_SMOKE_task") as { assigneeIds?: string[] } | undefined;
    expect(created?.assigneeIds).toEqual(["u1", "u2"]);
    expect(fake.counts.createTask).toBe(1);
  });

  it("clockify_tasks_create resolves assignee NAMES (and 'me') to ids inline", async () => {
    const fake = createFakeWorkspace(seedWithUsers());
    const result = await executeAction({
      actionName: "clockify_tasks_create",
      args: { projectId: "p1", name: "AIASSIST_SMOKE_task2", assigneeIds: ["Alice", "me"] },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected an ok receipt");
    const created = fake.state.tasks.find((t) => t.name === "AIASSIST_SMOKE_task2") as { assigneeIds?: string[] } | undefined;
    expect(created?.assigneeIds).toEqual(["u1", "admin-1"]);
  });

  it("clockify_tasks_create clarifies on an unknown assignee name (never creates a half-assigned task)", async () => {
    const fake = createFakeWorkspace(seedWithUsers());
    const result = await executeAction({
      actionName: "clockify_tasks_create",
      args: { projectId: "p1", name: "AIASSIST_SMOKE_task3", assigneeIds: ["Nobody"] },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.createTask ?? 0).toBe(0);
  });

  it("clockify_tasks_update resolves assignee NAMES to ids at preview time", async () => {
    const fake = createFakeWorkspace(seedWithUsers());
    const preview = await executeAction({
      actionName: "clockify_tasks_update",
      args: { projectId: "p1", id: "t1", assigneeIds: ["Bob", "me"] },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect((preview.operation.payload as any).patch.assigneeIds).toEqual(["u2", "admin-1"]);
  });

  it("clockify_tasks_update clarifies on an unknown assignee name (never previews a doomed commit)", async () => {
    const fake = createFakeWorkspace(seedWithUsers());
    const result = await executeAction({
      actionName: "clockify_tasks_update",
      args: { projectId: "p1", id: "t1", assigneeIds: ["Ghost"] },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.updateTask ?? 0).toBe(0);
  });

  it("clockify_tasks_update previews then updates once on commit", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_tasks_update",
      args: { projectId: "p1", id: "t1", name: "Design v2" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("high_risk_write");
    expect(fake.counts.updateTask ?? 0).toBe(0);
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.updateTask).toBe(1);
  });

  it("clockify_tasks_delete previews destructive then deletes once on commit", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_tasks_delete",
      args: { projectId: "p1", id: "t1", name: "Design" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("destructive");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.deleteTask).toBe(1);
    expect(fake.state.tasks.find((t) => t.id === "t1")).toBeUndefined();
  });

  it("clockify_tasks_rate_update converts major→minor and commits once (billing)", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_tasks_rate_update",
      args: { projectId: "p1", taskId: "t1", rateKind: "HOURLY", amount: 42 },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("billing");
    expect(preview.operation.featureGroup).toBe("invoices");
    expect((preview.operation.payload as any).amountMinor).toBe(4200);
    // Truthful preview: the admin sees the MAJOR amount (42.00), never raw minor units.
    const change = preview.preview.expectedChanges.join(" ");
    expect(change).toContain("42.00");
    expect(change).not.toContain("minor");
    expect(change).not.toContain("4200");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.updateTaskRate).toBe(1);
  });

  it("clockify_tasks_rate_update preview shows the REAL task name for a 24-hex id, not the model's unverified one", async () => {
    // r1-truthfulness-02: a 24-hex id short-circuited resolveEntityRef so the
    // billing preview echoed the MODEL-supplied taskName verbatim — the handler
    // comment promised VERIFY but didn't. The card must name the entity actually
    // mutated, or clarify if the id isn't real.
    const hexId = "0123456789abcdef01234567";
    const fake = createFakeWorkspace({
      projects: [{ id: "p1", name: "Website" }],
      tasks: [{ id: hexId, name: "Real Task", projectId: "p1" }],
    });
    const preview = await executeAction({
      actionName: "clockify_tasks_rate_update",
      args: { projectId: "p1", taskId: hexId, taskName: "Bogus Name", rateKind: "HOURLY", amount: 50 },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    const change = preview.preview.expectedChanges.join(" ");
    expect(change).toContain("Real Task");
    expect(change).not.toContain("Bogus Name");
  });

  it("clockify_tasks_rate_update resolves projectName + taskName and pins both ids", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_tasks_rate_update",
      args: { projectName: "Website", taskName: "design", rateKind: "COST", amount: 10 },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.payload).toMatchObject({ projectId: "p1", taskId: "t1", amountMinor: 1000 });
  });

  it("clockify_tasks_rate_update clarifies on an unknown task (never previews a doomed commit)", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({
      actionName: "clockify_tasks_rate_update",
      args: { projectName: "Website", taskName: "Nonexistent", rateKind: "HOURLY", amount: 5 },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.updateTaskRate ?? 0).toBe(0);
  });
});

describe("task actions — name→id resolution at preview time (live-loop FIX 1)", () => {
  it("clockify_tasks_update resolves projectName + currentName and pins both ids", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_tasks_update",
      args: { projectName: "Website", currentName: "design", name: "Design v2" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.payload).toMatchObject({ projectId: "p1", id: "t1" });
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.state.tasks[0].name).toBe("Design v2");
  });

  it("clockify_tasks_update resolves NAMES passed in the id slots (the audit-log failure shape)", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_tasks_update",
      args: { projectId: "Website", id: "Design", status: "DONE" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.payload).toMatchObject({ projectId: "p1", id: "t1" });
  });

  it("clockify_tasks_update clarifies on an unknown task name (never previews a doomed commit)", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({
      actionName: "clockify_tasks_update",
      args: { projectName: "Website", currentName: "Dezign", name: "X" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.updateTask ?? 0).toBe(0);
  });

  it("clockify_tasks_delete resolves project + task by name and deletes once on commit", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_tasks_delete",
      args: { projectName: "Website", name: "Design" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.payload).toMatchObject({ projectId: "p1", id: "t1" });
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.deleteTask).toBe(1);
  });

  it("clockify_tasks_delete resolves the project by name even when the project is ARCHIVED (live item 305)", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "p9", name: "Old Project", archived: true }],
      tasks: [{ id: "t9", name: "Leftover", projectId: "p9" }],
    });
    const preview = await executeAction({
      actionName: "clockify_tasks_delete",
      args: { projectName: "Old Project", name: "Leftover" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    expect(preview.operation.payload).toMatchObject({ projectId: "p9", id: "t9" });
  });

  it("clockify_tasks_delete clarifies when the project name itself is unknown", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({
      actionName: "clockify_tasks_delete",
      args: { projectName: "Webside", name: "Design" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.deleteTask ?? 0).toBe(0);
  });
});
