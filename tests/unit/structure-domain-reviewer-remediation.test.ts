import { describe, expect, it } from "vitest";
import { AmbiguousWriteOutcome, DefinitiveWriteFailure } from "../../src/clockify/write-outcome.js";
import type { ActionContext } from "../../src/harness/action.js";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";

function context(fake: FakeWorkspace, clockify = fake.client): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy: defaultAdminPolicy(),
    clockify,
    now: () => new Date("2026-06-06T00:00:00.000Z"),
  };
}

async function preview(
  fake: FakeWorkspace,
  actionName: string,
  args: Record<string, unknown>,
  clockify = fake.client,
) {
  const result = await executeAction({ actionName, args, context: context(fake, clockify) });
  if (result.kind !== "preview") throw new Error(`expected preview, got ${result.kind}`);
  return result.operation;
}

describe("Task 7 reviewer remediation", () => {
  it.each([
    {
      actionName: "clockify_clients_create",
      args: { name: "Created" },
      list: "listClients" as const,
      count: "createClientBaseAtomic",
      insert(fake: FakeWorkspace) {
        fake.state.clients.push({ id: "concurrent-client", name: "Created" });
      },
    },
    {
      actionName: "clockify_tags_create",
      args: { name: "Created" },
      list: "listTags" as const,
      count: "createTag",
      insert(fake: FakeWorkspace) {
        fake.state.tags.push({ id: "concurrent-tag", name: "Created" });
      },
    },
  ])("rejects $actionName when its complete create baseline changes immediately before POST", async (testCase) => {
    const fake = createFakeWorkspace();
    const original = fake.client[testCase.list].bind(fake.client);
    let reads = 0;
    (fake.client[testCase.list] as typeof original) = async (...args: Parameters<typeof original>) => {
      reads += 1;
      if (reads === 2) testCase.insert(fake);
      return original(...args);
    };

    const result = await executeAction({
      actionName: testCase.actionName,
      args: testCase.args,
      context: context(fake),
    });

    expect(result).toMatchObject({ kind: "receipt", receipt: { ok: false } });
    expect(fake.counts[testCase.count] ?? 0).toBe(0);
    expect(reads).toBe(2);
  });

  it("derives task DONE replacement intent and its fingerprint from one raw read", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "project-1", name: "Project" }],
      tasks: [{ id: "task-1", name: "Task", projectId: "project-1", status: "ACTIVE", opaque: { version: 1 } } as never],
    });
    const original = fake.client.prepareTaskUpdate.bind(fake.client);
    let rawReads = 0;
    fake.client.prepareTaskUpdate = async (...args) => {
      rawReads += 1;
      const body = await original(...args);
      if (rawReads === 1) {
        fake.state.tasks[0] = { ...fake.state.tasks[0]!, opaque: { version: 2 } } as never;
      }
      return body;
    };
    const operation = await preview(fake, "clockify_tasks_delete", { projectId: "project-1", id: "task-1" });

    const result = await commitConfirmedOperation(context(fake), operation);

    expect(result).toMatchObject({ ok: false, code: "stale_target" });
    expect(fake.counts.updateTaskAtomic ?? 0).toBe(0);
    expect(fake.counts.deleteTaskAtomic ?? 0).toBe(0);
  });

  it("reconciles an ambiguous client update from the exact lossless raw document", async () => {
    const fake = createFakeWorkspace({
      clients: [{
        id: "client-1", name: "Client", ccEmails: ["old@example.com"], currencyId: "currency-old",
        opaque: { retained: true },
      } as never],
      currencies: [{ id: "currency-new", code: "EUR" }],
    });
    const originalUpdate = fake.client.updateClientAtomic.bind(fake.client);
    const clockify = {
      ...fake.client,
      getClient: async (id: string) => {
        const row = fake.state.clients.find((candidate) => candidate.id === id);
        return row ? { id: row.id, name: row.name, archived: row.archived } : null;
      },
      updateClientAtomic: async (id: string, body: Record<string, unknown>) => {
        await originalUpdate(id, body);
        throw new AmbiguousWriteOutcome("PUT", `/clients/${id}`, "socket closed");
      },
    };
    const operation = await preview(fake, "clockify_clients_update", {
      id: "client-1",
      ccEmails: ["new@example.com"],
      currency: "EUR",
      fields: { opaque: { retained: true, revision: 2 } },
    }, clockify);

    const result = await commitConfirmedOperation(context(fake, clockify), operation);

    expect(result).toMatchObject({ ok: true });
    expect(fake.counts.updateClientAtomic).toBe(1);
  });

  it("reconciles an ambiguous project update from color, visibility, rates, and retained raw fields", async () => {
    const fake = createFakeWorkspace({
      projects: [{
        id: "project-1", name: "Project", color: "#111111", isPublic: true,
        hourlyRate: { amount: 1000 }, opaque: { retained: true },
      } as never],
    });
    const originalUpdate = fake.client.updateProjectAtomic.bind(fake.client);
    const clockify = {
      ...fake.client,
      getProject: async (id: string) => {
        const row = fake.state.projects.find((candidate) => candidate.id === id);
        return row ? { id: row.id, name: row.name, archived: row.archived, billable: row.billable } : null;
      },
      updateProjectAtomic: async (id: string, body: Record<string, unknown>) => {
        await originalUpdate(id, body);
        throw new AmbiguousWriteOutcome("PUT", `/projects/${id}`, "socket closed");
      },
    };
    const operation = await preview(fake, "clockify_projects_update", {
      id: "project-1", color: "#222222", isPublic: false, hourlyRate: 25,
    }, clockify);

    const result = await commitConfirmedOperation(context(fake, clockify), operation);

    expect(result).toMatchObject({ ok: true });
    expect(fake.counts.updateProjectAtomic).toBe(1);
    expect(fake.state.projects[0]).toMatchObject({ opaque: { retained: true } });
  });

  it("reconciles an ambiguous task update from billable and preserved raw fields", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "project-1", name: "Project" }],
      tasks: [{ id: "task-1", name: "Task", projectId: "project-1", status: "ACTIVE", billable: true, opaque: { revision: 1 } } as never],
    });
    const originalUpdate = fake.client.updateTaskAtomic.bind(fake.client);
    const clockify = {
      ...fake.client,
      getTask: async (projectId: string, id: string) => {
        const row = fake.state.tasks.find((candidate) => candidate.projectId === projectId && candidate.id === id);
        return row ? { id: row.id, name: row.name, projectId: row.projectId, assigneeIds: row.assigneeIds, billable: (row as { billable?: boolean }).billable } : null;
      },
      updateTaskAtomic: async (projectId: string, id: string, body: Record<string, unknown>) => {
        await originalUpdate(projectId, id, body);
        throw new AmbiguousWriteOutcome("PUT", `/projects/${projectId}/tasks/${id}`, "socket closed");
      },
    };
    const operation = await preview(fake, "clockify_tasks_update", {
      projectId: "project-1", id: "task-1", billable: false,
    }, clockify);

    const result = await commitConfirmedOperation(context(fake, clockify), operation);

    expect(result).toMatchObject({ ok: true });
    expect(fake.counts.updateTaskAtomic).toBe(1);
    expect(fake.state.tasks[0]).toMatchObject({ opaque: { revision: 1 }, billable: false });
  });

  it.each([
    {
      actionName: "clockify_projects_delete",
      args: { id: "project-1" },
      seed: { projects: [{ id: "project-1", name: "Project", archived: false }] },
      deleteMethod: "deleteProjectAtomic" as const,
      restoreMethod: "updateProjectAtomic",
      changedMethod: "archiveProjectAtomic",
      changedCount: 1,
      restoreCount: 0,
    },
    {
      actionName: "clockify_clients_delete",
      args: { id: "client-1" },
      seed: { clients: [{ id: "client-1", name: "Client", archived: false }] },
      deleteMethod: "deleteClientAtomic" as const,
      restoreMethod: "updateClientAtomic",
      changedMethod: "updateClientAtomic",
      changedCount: 1,
      restoreCount: 1,
    },
    {
      actionName: "clockify_tasks_delete",
      args: { projectId: "project-1", id: "task-1" },
      seed: {
        projects: [{ id: "project-1", name: "Project" }],
        tasks: [{ id: "task-1", name: "Task", projectId: "project-1", status: "ACTIVE" } as never],
      },
      deleteMethod: "deleteTaskAtomic" as const,
      restoreMethod: "updateTaskAtomic",
      changedMethod: "updateTaskAtomic",
      changedCount: 1,
      restoreCount: 1,
    },
  ])("never bypasses the journal with direct $actionName compensation", async (testCase) => {
    const fake = createFakeWorkspace(testCase.seed);
    const operation = await preview(fake, testCase.actionName, testCase.args);
    const clockify = {
      ...fake.client,
      [testCase.deleteMethod]: async () => {
        throw new DefinitiveWriteFailure("DELETE", "/delete", "rejected", 400);
      },
    };

    const result = await commitConfirmedOperation(context(fake, clockify), operation);

    expect(result).toMatchObject({ kind: "partial", recovery: { retryable: false } });
    expect(fake.counts[testCase.changedMethod]).toBe(testCase.changedCount);
    expect(fake.counts[testCase.restoreMethod] ?? 0).toBe(testCase.restoreCount);
  });
});
