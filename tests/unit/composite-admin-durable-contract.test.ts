import { describe, expect, it } from "vitest";
import { executeAction } from "../../src/harness/actions.js";
import { getAction } from "../../src/harness/catalog.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext } from "../../src/harness/action.js";

const ACTIONS = [
  "clockify_create_work_package",
  "clockify_delete_entity",
  "clockify_update_entity",
  "clockify_onboard_user",
  "clockify_setup_project",
  "clockify_setup_task",
] as const;

function context(fake: FakeWorkspace): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy: defaultAdminPolicy(),
    clockify: fake.client,
    now: () => new Date("2026-07-14T09:00:00.000Z"),
  };
}

describe("composite/admin durable mutation contracts", () => {
  it.each(ACTIONS)("migrates %s to an exact durable contract", (name) => {
    const action = getAction(name);
    expect(action?.mutationWorkflow, name).toBe("durable");
    expect(action?.mutationContract, name).toMatchObject({
      operationData: { normalized: true, nonsecret: true },
      mutationPlan: { exact: true },
      reconciliation: { stepBound: true, requiresCompleteEvidence: true },
    });
  });

  it("prepares the work-package safe write with one step per host mutation", async () => {
    const action = getAction("clockify_create_work_package")!;
    const fake = createFakeWorkspace();
    const prepared = await action.prepareSafeWrite!(context(fake), {
      client: { name: "Acme" },
      project: { name: "Apollo", clientName: "Acme" },
      task: { name: "Build" },
      startTimer: true,
    });
    expect(prepared).toMatchObject({
      mutationPlan: {
        mode: "curated",
        steps: [
          { id: "create-client", kind: "primary", reconciliationStrategy: "create" },
          { id: "create-project", kind: "primary", reconciliationStrategy: "create" },
          { id: "create-task", kind: "primary", reconciliationStrategy: "create" },
          { id: "start-timer", kind: "primary", reconciliationStrategy: "create" },
        ],
      },
    });
  });

  it("previews setup-task with its exact dynamic atomic plan and parent snapshot", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Apollo" }] });
    const preview = await executeAction({
      actionName: "clockify_setup_task",
      args: { projectId: "p1", name: "Build", rate: 50 },
      context: context(fake),
    });
    expect(preview).toMatchObject({
      kind: "preview",
      operation: {
        targetSnapshots: [{ relation: "parent", ref: { type: "project", id: "p1" } }],
        mutationPlan: {
          mode: "curated",
          steps: [
            { id: "create-task", kind: "primary", reconciliationStrategy: "create" },
            { id: "set-task-rate", kind: "primary", reconciliationStrategy: "update" },
          ],
        },
      },
    });
  });

  it("previews onboard-user with invite plus one step per resolved group", async () => {
    const fake = createFakeWorkspace({ groups: [{ id: "g1", name: "Engineering" }] });
    const preview = await executeAction({
      actionName: "clockify_onboard_user",
      args: { email: "ada@example.com", groups: ["Engineering"] },
      context: context(fake),
    });
    expect(preview).toMatchObject({
      kind: "preview",
      operation: {
        targetSnapshots: [{ relation: "parent", ref: { type: "group", id: "g1" } }],
        mutationPlan: {
          mode: "curated",
          steps: [
            { id: "invite-user", kind: "primary", reconciliationStrategy: "create" },
            { id: "add-user-to-group-0", kind: "primary", reconciliationStrategy: "update" },
          ],
        },
      },
    });
  });
});
