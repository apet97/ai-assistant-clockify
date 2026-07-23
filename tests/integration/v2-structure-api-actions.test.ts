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
