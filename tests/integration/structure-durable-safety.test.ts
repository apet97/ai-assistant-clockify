import { describe, expect, it } from "vitest";
import { AmbiguousWriteOutcome, DefinitiveWriteFailure } from "../../src/clockify/write-outcome.js";
import type { ActionContext } from "../../src/harness/action.js";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import { STRUCTURE_CREATE_RECONCILIATION_CANDIDATE_MAX } from "../../src/harness/safety-limits.js";

function context(fake: FakeWorkspace, clockify = fake.client): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy: defaultAdminPolicy(),
    clockify,
    now: () => new Date("2026-06-06T00:00:00.000Z"),
  };
}

describe("structure/time durable target and outcome safety", () => {
  it("rejects target drift before sending a tag update", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "tag-1", name: "Original" }] });
    const preview = await executeAction({
      actionName: "clockify_tags_update",
      args: { id: "tag-1", name: "Requested" },
      context: context(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected preview");
    fake.state.tags[0]!.name = "Changed elsewhere";

    const result = await commitConfirmedOperation(context(fake), preview.operation);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("stale_target");
    expect(fake.counts.updateTagAtomic ?? 0).toBe(0);
  });

  it("rejects parent drift before sending a task update", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "project-1", name: "Original project" }],
      tasks: [{ id: "task-1", name: "Task", projectId: "project-1" }],
    });
    const preview = await executeAction({
      actionName: "clockify_tasks_update",
      args: { projectId: "project-1", id: "task-1", name: "Requested" },
      context: context(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected preview");
    fake.state.projects[0]!.name = "Changed elsewhere";

    const result = await commitConfirmedOperation(context(fake), preview.operation);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("stale_parent");
    expect(fake.counts.updateTaskAtomic ?? 0).toBe(0);
  });

  it("detects drift in a raw project field omitted from the summary projection", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "project-1", name: "Project", color: "#111111" } as never],
    });
    const preview = await executeAction({
      actionName: "clockify_projects_archive",
      args: { id: "project-1" },
      context: context(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected preview");
    (fake.state.projects[0] as unknown as { color: string }).color = "#222222";

    const result = await commitConfirmedOperation(context(fake), preview.operation);

    expect(result).toMatchObject({ ok: false, code: "stale_target" });
    expect(fake.counts.archiveProjectAtomic ?? 0).toBe(0);
  });

  it("does not trust a syntactically valid but missing 24-hex project id", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_projects_estimate_update",
      args: { id: "aaaaaaaaaaaaaaaaaaaaaaaa", fields: { estimate: { type: "MANUAL" } } },
      context: context(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.updateProjectEstimateAtomic ?? 0).toBe(0);
  });

  it("does not bypass the durable journal to restore archive state after a definitive project delete failure", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "project-1", name: "Project", archived: false }] });
    const preview = await executeAction({
      actionName: "clockify_projects_delete",
      args: { id: "project-1" },
      context: context(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected preview");
    const clockify = {
      ...fake.client,
      deleteProjectAtomic: async () => {
        throw new DefinitiveWriteFailure("DELETE", "/projects/project-1", "rejected", 400);
      },
    };

    const result = await commitConfirmedOperation(context(fake, clockify), preview.operation);

    expect(result).toMatchObject({ kind: "partial", recovery: { retryable: false } });
    expect(fake.state.projects[0]).toMatchObject({ id: "project-1", archived: true });
    expect(fake.counts.updateProjectAtomic ?? 0).toBe(0);
  });

  it("reconciles socket-close-after-apply project deletion and does not compensate", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "project-1", name: "Project", archived: false }] });
    const preview = await executeAction({
      actionName: "clockify_projects_delete",
      args: { id: "project-1" },
      context: context(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected preview");
    const clockify = {
      ...fake.client,
      deleteProjectAtomic: async (id: string) => {
        fake.state.projects = fake.state.projects.filter((project) => project.id !== id);
        throw new AmbiguousWriteOutcome("DELETE", `/projects/${id}`, "socket closed");
      },
    };

    const result = await commitConfirmedOperation(context(fake, clockify), preview.operation);

    expect(result.ok).toBe(true);
    expect(fake.state.projects).toHaveLength(0);
    expect(fake.counts.updateProjectAtomic ?? 0).toBe(0);
  });

  it("does not compensate an ambiguous project delete that remains observable", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "project-1", name: "Project", archived: false }] });
    const preview = await executeAction({
      actionName: "clockify_projects_delete",
      args: { id: "project-1" },
      context: context(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected preview");
    const clockify = {
      ...fake.client,
      deleteProjectAtomic: async (id: string) => {
        throw new AmbiguousWriteOutcome("DELETE", `/projects/${id}`, "proxy 502", 502);
      },
    };

    const result = await commitConfirmedOperation(context(fake, clockify), preview.operation);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("commit_outcome_unknown");
    expect(fake.state.projects[0]).toMatchObject({ id: "project-1", archived: true });
    expect(fake.counts.updateProjectAtomic ?? 0).toBe(0);
  });

  it("returns partial when definitive delete failure is followed by ambiguous compensation", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "project-1", name: "Project", archived: false }] });
    const preview = await executeAction({
      actionName: "clockify_projects_delete",
      args: { id: "project-1" },
      context: context(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected preview");
    const clockify = {
      ...fake.client,
      updateProjectAtomic: async (id: string, _body: Record<string, unknown>) => {
        throw new AmbiguousWriteOutcome("PUT", `/projects/${id}`, "compensation response lost");
      },
      deleteProjectAtomic: async (id: string) => {
        throw new DefinitiveWriteFailure("DELETE", `/projects/${id}`, "rejected", 400);
      },
    };

    const result = await commitConfirmedOperation(context(fake, clockify), preview.operation);

    expect(result).toMatchObject({ kind: "partial" });
    expect(fake.state.projects[0]).toMatchObject({ archived: true });
  });

  it("reconciles one exact project created before an ambiguous response", async () => {
    const fake = createFakeWorkspace();
    let dispatches = 0;
    fake.client.createProjectAtomic = async (input) => {
      dispatches += 1;
      fake.state.projects.push({ id: "project-created", ...input } as never);
      throw new AmbiguousWriteOutcome("POST", "/projects", "socket closed");
    };

    const result = await executeAction({
      actionName: "clockify_projects_create",
      args: { name: "Created", billable: true, color: "#123456" },
      context: context(fake),
    });

    expect(result).toMatchObject({ kind: "receipt", receipt: { ok: true } });
    expect(dispatches).toBe(1);
  });

  it("stops project reconciliation before an over-budget candidate detail scan", async () => {
    const fake = createFakeWorkspace();
    fake.client.createProjectAtomic = async (input) => {
      for (let index = 0; index <= STRUCTURE_CREATE_RECONCILIATION_CANDIDATE_MAX; index += 1) {
        fake.state.projects.push({ id: `project-candidate-${index}`, ...input } as never);
      }
      throw new AmbiguousWriteOutcome("POST", "/projects", "socket closed");
    };

    const result = await executeAction({
      actionName: "clockify_projects_create",
      args: { name: "Created" },
      context: context(fake),
    });

    expect(result).toMatchObject({ kind: "receipt", receipt: { ok: false, code: "commit_outcome_unknown" } });
    expect(fake.counts.getProjectMutationState ?? 0).toBe(0);
  });

  it("does not dispatch project create when its complete baseline is truncated", async () => {
    const fake = createFakeWorkspace({ listTruncated: { listProjects: true } });

    const result = await executeAction({
      actionName: "clockify_projects_create",
      args: { name: "Unsafe baseline" },
      context: context(fake),
    });

    expect(result).toMatchObject({ kind: "receipt", receipt: { ok: false } });
    expect(fake.counts.createProjectAtomic ?? 0).toBe(0);
  });

  it("keeps task create unknown when ambiguous evidence has two exact matches", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "project-1", name: "Project" }] });
    let dispatches = 0;
    fake.client.createTaskAtomic = async (input) => {
      dispatches += 1;
      fake.state.tasks.push(
        { id: "task-created-1", ...input },
        { id: "task-created-2", ...input },
      );
      throw new AmbiguousWriteOutcome("POST", "/tasks", "proxy response lost");
    };

    const result = await executeAction({
      actionName: "clockify_tasks_create",
      args: { projectId: "project-1", name: "Created" },
      context: context(fake),
    });

    expect(result).toMatchObject({ kind: "receipt", receipt: { ok: false, code: "commit_outcome_unknown" } });
    expect(dispatches).toBe(1);
  });

  it("never enriches a client after an ambiguous composite base create", async () => {
    const fake = createFakeWorkspace({ currencies: [{ id: "currency-eur", code: "EUR" }] });
    let dispatches = 0;
    fake.client.createClientBaseAtomic = async (input) => {
      dispatches += 1;
      fake.state.clients.push({ id: "client-created", ...input });
      throw new AmbiguousWriteOutcome("POST", "/clients", "socket closed");
    };

    const result = await executeAction({
      actionName: "clockify_clients_create",
      args: { name: "Created", currency: "EUR" },
      context: context(fake),
    });

    expect(result).toMatchObject({ kind: "receipt", receipt: { ok: false, code: "commit_outcome_unknown" } });
    expect(dispatches).toBe(1);
    expect(fake.counts.updateClientAtomic ?? 0).toBe(0);
  });

  it("stops client reconciliation before an over-budget candidate detail scan", async () => {
    const fake = createFakeWorkspace();
    fake.client.createClientBaseAtomic = async (input) => {
      for (let index = 0; index <= STRUCTURE_CREATE_RECONCILIATION_CANDIDATE_MAX; index += 1) {
        fake.state.clients.push({ id: `client-candidate-${index}`, ...input });
      }
      throw new AmbiguousWriteOutcome("POST", "/clients", "socket closed");
    };

    const result = await executeAction({
      actionName: "clockify_clients_create",
      args: { name: "Created" },
      context: context(fake),
    });

    expect(result).toMatchObject({ kind: "receipt", receipt: { ok: false, code: "commit_outcome_unknown" } });
    expect(fake.counts.getClientMutationState ?? 0).toBe(0);
  });
});
