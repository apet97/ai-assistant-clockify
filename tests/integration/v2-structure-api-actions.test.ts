import { describe, expect, it } from "vitest";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { actionFingerprintForDefinition, getAction } from "../../src/harness/catalog.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import type { ActionContext } from "../../src/harness/action.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";

const NOW = new Date("2026-06-06T00:00:00.000Z");

const NEW_PROJECT_API_ACTIONS = [
  "clockify_projects_delete_archived",
  "clockify_projects_member_hourly_rate_update",
  "clockify_projects_member_cost_rate_update",
  "clockify_projects_memberships_replace",
  "clockify_projects_estimate_update",
] as const;

const NEW_TASK_API_ACTIONS = [
  "clockify_tasks_delete_completed",
  "clockify_tasks_status_update",
  "clockify_tasks_assignees_replace",
  "clockify_tasks_hourly_rate_update",
  "clockify_tasks_cost_rate_update",
] as const;

const INTERNAL_ONLY_TASK_ACTIONS = [
  "clockify_setup_task",
  "clockify_tasks_delete",
  "clockify_tasks_rate_update",
] as const;

const INTERNAL_ONLY_PROJECT_ACTIONS = [
  "clockify_setup_project",
  "clockify_projects_delete",
  "clockify_projects_rate_update",
  "clockify_projects_memberships_update",
] as const;

function makeContext(fake: FakeWorkspace): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy: defaultAdminPolicy(),
    clockify: fake.client,
    now: () => NOW,
  };
}

describe("v2 project structure API actions", () => {
  it("exposes atomic project actions on MODEL_API and hides v1 composites/generics", () => {
    const modelNames = new Set(MODEL_API_ACTION_CATALOG.actions.map((action) => action.name));
    for (const name of NEW_PROJECT_API_ACTIONS) {
      expect(modelNames.has(name), name).toBe(true);
      expect(getAction(name)?.apiExposure).toBe("api");
    }
    for (const name of INTERNAL_ONLY_PROJECT_ACTIONS) {
      expect(modelNames.has(name), name).toBe(false);
      expect(getAction(name)?.apiExposure).not.toBe("api");
    }
  });

  it("refuses delete_archived preview for an active project", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Website", archived: false }] });
    const result = await executeAction({
      actionName: "clockify_projects_delete_archived",
      args: { id: "p1" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    if (result.kind === "clarify") {
      expect(result.message).toContain("still active");
    }
    expect(fake.counts.deleteProjectAtomic ?? 0).toBe(0);
  });

  it("delete_archived commits with a single DELETE for an archived project", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Website", archived: true }] });
    const preview = await executeAction({
      actionName: "clockify_projects_delete_archived",
      args: { id: "p1" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected preview");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.deleteProjectAtomic).toBe(1);
    expect(fake.counts.archiveProjectAtomic ?? 0).toBe(0);
  });

  it("routes hourly and cost member-rate actions through distinct fake REST ports", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "p1", name: "Website" }],
      projectMemberships: { p1: [{ userId: "admin-1" }] },
    });
    const hourlyPreview = await executeAction({
      actionName: "clockify_projects_member_hourly_rate_update",
      args: { projectId: "p1", userId: "me", amount: 75 },
      context: makeContext(fake),
    });
    if (hourlyPreview.kind !== "preview") throw new Error("expected hourly preview");
    await commitConfirmedOperation(makeContext(fake), hourlyPreview.operation);
    expect(fake.counts.updateProjectMemberHourlyRateAtomic).toBe(1);
    expect(fake.counts.updateProjectMemberCostRateAtomic ?? 0).toBe(0);

    const costPreview = await executeAction({
      actionName: "clockify_projects_member_cost_rate_update",
      args: { projectId: "p1", userId: "me", amount: 40 },
      context: makeContext(fake),
    });
    if (costPreview.kind !== "preview") throw new Error("expected cost preview");
    await commitConfirmedOperation(makeContext(fake), costPreview.operation);
    expect(fake.counts.updateProjectMemberCostRateAtomic).toBe(1);
  });

  it("changes the catalog fingerprint when project API presentation metadata changes", () => {
    const action = getAction("clockify_projects_delete_archived");
    if (!action) throw new Error("missing delete_archived action");
    const baseline = actionFingerprintForDefinition(action);
    const altered = actionFingerprintForDefinition({
      ...action,
      presentation: { presenterId: action.presentation!.presenterId, version: action.presentation!.version + 1 },
    });
    expect(altered).not.toBe(baseline);
  });
});

describe("v2 task structure API actions", () => {
  it("exposes atomic task actions on MODEL_API and hides v1 composites/generics", () => {
    const modelNames = new Set(MODEL_API_ACTION_CATALOG.actions.map((action) => action.name));
    for (const name of NEW_TASK_API_ACTIONS) {
      expect(modelNames.has(name), name).toBe(true);
      expect(getAction(name)?.apiExposure).toBe("api");
    }
    for (const name of INTERNAL_ONLY_TASK_ACTIONS) {
      expect(modelNames.has(name), name).toBe(false);
      expect(getAction(name)?.apiExposure).not.toBe("api");
    }
    expect(modelNames.has("clockify_tasks_create")).toBe(true);
    expect(modelNames.has("clockify_tasks_update")).toBe(true);
  });

  it("refuses delete_completed preview for a non-DONE task", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "p1", name: "Website" }],
      tasks: [{ id: "t1", name: "Design", projectId: "p1", status: "ACTIVE" } as any],
    });
    const result = await executeAction({
      actionName: "clockify_tasks_delete_completed",
      args: { projectId: "p1", id: "t1" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    if (result.kind === "clarify") {
      expect(result.message).toContain("not DONE");
    }
    expect(fake.counts.deleteTaskAtomic ?? 0).toBe(0);
  });

  it("delete_completed commits with a single DELETE for a DONE task", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "p1", name: "Website" }],
      tasks: [{ id: "t1", name: "Design", projectId: "p1", status: "DONE" } as any],
    });
    const preview = await executeAction({
      actionName: "clockify_tasks_delete_completed",
      args: { projectId: "p1", id: "t1" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected preview");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.deleteTaskAtomic).toBe(1);
    expect(fake.counts.updateTaskAtomic ?? 0).toBe(0);
  });

  it("routes hourly and cost task-rate actions through distinct fake REST ports", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "p1", name: "Website" }],
      tasks: [{ id: "t1", name: "Design", projectId: "p1" }],
    });
    const hourlyPreview = await executeAction({
      actionName: "clockify_tasks_hourly_rate_update",
      args: { projectId: "p1", taskId: "t1", amount: 75 },
      context: makeContext(fake),
    });
    if (hourlyPreview.kind !== "preview") throw new Error("expected hourly preview");
    await commitConfirmedOperation(makeContext(fake), hourlyPreview.operation);
    expect(fake.counts.updateTaskHourlyRateAtomic).toBe(1);
    expect(fake.counts.updateTaskCostRateAtomic ?? 0).toBe(0);

    const costPreview = await executeAction({
      actionName: "clockify_tasks_cost_rate_update",
      args: { projectId: "p1", taskId: "t1", amount: 40 },
      context: makeContext(fake),
    });
    if (costPreview.kind !== "preview") throw new Error("expected cost preview");
    await commitConfirmedOperation(makeContext(fake), costPreview.operation);
    expect(fake.counts.updateTaskCostRateAtomic).toBe(1);
  });

  it("changes the catalog fingerprint when task API presentation metadata changes", () => {
    const action = getAction("clockify_tasks_delete_completed");
    if (!action) throw new Error("missing delete_completed action");
    const baseline = actionFingerprintForDefinition(action);
    const altered = actionFingerprintForDefinition({
      ...action,
      presentation: { presenterId: action.presentation!.presenterId, version: action.presentation!.version + 1 },
    });
    expect(altered).not.toBe(baseline);
  });
});

const NEW_CLIENT_API_ACTIONS = [
  "clockify_clients_create_base",
  "clockify_clients_delete_archived",
] as const;

const INTERNAL_ONLY_CLIENT_ACTIONS = [
  "clockify_clients_create",
  "clockify_clients_delete",
] as const;

describe("v2 client structure API actions", () => {
  it("exposes atomic client actions on MODEL_API and hides v1 composites", () => {
    const modelNames = new Set(MODEL_API_ACTION_CATALOG.actions.map((action) => action.name));
    for (const name of NEW_CLIENT_API_ACTIONS) {
      expect(modelNames.has(name), name).toBe(true);
      expect(getAction(name)?.apiExposure).toBe("api");
    }
    for (const name of INTERNAL_ONLY_CLIENT_ACTIONS) {
      expect(modelNames.has(name), name).toBe(false);
      expect(getAction(name)?.apiExposure).not.toBe("api");
    }
    expect(modelNames.has("clockify_clients_list")).toBe(true);
    expect(modelNames.has("clockify_clients_get")).toBe(true);
    expect(modelNames.has("clockify_clients_update")).toBe(true);
    expect(modelNames.has("clockify_clients_archive")).toBe(true);
  });

  it("refuses delete_archived preview for an active client", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "c1", name: "Acme", archived: false }] });
    const result = await executeAction({
      actionName: "clockify_clients_delete_archived",
      args: { id: "c1" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    if (result.kind === "clarify") {
      expect(result.message).toContain("still active");
    }
    expect(fake.counts.deleteClientAtomic ?? 0).toBe(0);
  });

  it("delete_archived commits with a single DELETE for an archived client", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "c1", name: "Acme", archived: true }] });
    const preview = await executeAction({
      actionName: "clockify_clients_delete_archived",
      args: { id: "c1" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected preview");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.deleteClientAtomic).toBe(1);
    expect(fake.counts.archiveClientAtomic ?? 0).toBe(0);
  });

  it("create_base executes with a single POST and no enrichment PUT", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_clients_create_base",
      args: { name: "AIASSIST_SMOKE_c" },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected receipt");
    expect(fake.counts.createClientBaseAtomic).toBe(1);
    expect(fake.counts.updateClientAtomic ?? 0).toBe(0);
  });

  it("changes the catalog fingerprint when client API presentation metadata changes", () => {
    const action = getAction("clockify_clients_delete_archived");
    if (!action) throw new Error("missing delete_archived action");
    const baseline = actionFingerprintForDefinition(action);
    const altered = actionFingerprintForDefinition({
      ...action,
      presentation: { presenterId: action.presentation!.presenterId, version: action.presentation!.version + 1 },
    });
    expect(altered).not.toBe(baseline);
  });
});
