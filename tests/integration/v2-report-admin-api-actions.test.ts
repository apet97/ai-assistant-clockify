import { describe, expect, it } from "vitest";
import { executeAction } from "../../src/harness/actions.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { actionFingerprintForDefinition, getAction } from "../../src/harness/catalog.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import type { ActionContext } from "../../src/harness/action.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";

const NOW = new Date("2026-06-06T00:00:00.000Z");

const REPORT_API_ACTIONS = [
  "clockify_reports_summary",
  "clockify_reports_detailed",
  "clockify_reports_weekly",
] as const;

const INTERNAL_ONLY_REPORT_ACTIONS = [
  "clockify_period_report",
] as const;

function makeContext(fake: FakeWorkspace): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy: defaultAdminPolicy(),
    clockify: fake.client,
    now: () => NOW,
    timeZone: "UTC",
    weekStartsOn: 1,
  };
}

describe("v2 report API actions", () => {
  it("exposes summary, detailed, and weekly reports on MODEL_API and hides period_report", () => {
    const modelNames = new Set(MODEL_API_ACTION_CATALOG.actions.map((action) => action.name));
    for (const name of REPORT_API_ACTIONS) {
      expect(modelNames.has(name), name).toBe(true);
      expect(getAction(name)?.apiExposure).toBe("api");
      expect(getAction(name)?.apiOperation?.host).toBe("reports");
      expect(getAction(name)?.apiOperation?.method).toBe("POST");
    }
    expect(getAction("clockify_reports_summary")?.apiOperation?.operationId).toBe("generateSummaryReport");
    expect(getAction("clockify_reports_detailed")?.apiOperation?.operationId).toBe("generateDetailedReport");
    expect(getAction("clockify_reports_weekly")?.apiOperation?.operationId).toBe("generateWeeklyReport");
    for (const name of INTERNAL_ONLY_REPORT_ACTIONS) {
      expect(modelNames.has(name), name).toBe(false);
      expect(getAction(name)?.apiExposure).toBe("composite");
    }
  });

  it("clockify_reports_summary resolves server dates and calls the reports host", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_reports_summary",
      args: { dateRangeStart: "today", dateRangeEnd: "today", groups: ["PROJECT"] },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected receipt");
    expect(fake.counts.summaryReport).toBe(1);
    expect((result.receipt.data as { truncated?: boolean }).truncated).toBe(false);
  });

  it("changes the catalog fingerprint when report presentation metadata changes", () => {
    const action = getAction("clockify_reports_detailed");
    if (!action) throw new Error("missing reports_detailed action");
    const baseline = actionFingerprintForDefinition(action);
    const altered = actionFingerprintForDefinition({
      ...action,
      presentation: { presenterId: action.presentation!.presenterId, version: action.presentation!.version + 1 },
    });
    expect(altered).not.toBe(baseline);
  });
});

describe("v2 audit API actions", () => {
  const ENTITY_CHANGE_API_ACTIONS = [
    "clockify_entity_changes_created",
    "clockify_entity_changes_updated",
    "clockify_entity_changes_deleted",
  ] as const;

  it("exposes three literal entity-change reads on MODEL_API and hides the changeType wrapper", () => {
    const modelNames = new Set(MODEL_API_ACTION_CATALOG.actions.map((action) => action.name));
    for (const name of ENTITY_CHANGE_API_ACTIONS) {
      expect(modelNames.has(name), name).toBe(true);
      expect(getAction(name)?.apiExposure).toBe("api");
    }
    expect(getAction("clockify_entity_changes_created")?.apiOperation?.operationId).toBe("getCreatedEntityInfo");
    expect(getAction("clockify_entity_changes_updated")?.apiOperation?.operationId).toBe("getUpdatedEntityInfo");
    expect(getAction("clockify_entity_changes_deleted")?.apiOperation?.operationId).toBe("getDeletedEntityInfo");
    expect(modelNames.has("clockify_entity_changes_list")).toBe(false);
    expect(getAction("clockify_entity_changes_list")?.apiExposure).toBe("generic");
    expect(modelNames.has("clockify_audit_logs_search")).toBe(false);
    expect(getAction("clockify_audit_logs_search")?.availabilityByAuthClass.addon.reason).toBe(
      "official_operation_id_missing",
    );
  });

  it("clockify_entity_changes_created reads the created feed with one GET", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_entity_changes_created",
      args: {},
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected receipt");
    expect((result.receipt.data as { changeType?: string }).changeType).toBe("created");
    expect(fake.counts.listEntityChanges).toBe(1);
  });
});

describe("v2 workspace API actions", () => {
  const WORKSPACE_API_ACTIONS = [
    "clockify_workspace_get",
    "clockify_templates_list",
    "clockify_templates_get",
  ] as const;

  it("exposes workspace and template reads on MODEL_API with exact project correlations", () => {
    const modelNames = new Set(MODEL_API_ACTION_CATALOG.actions.map((action) => action.name));
    for (const name of WORKSPACE_API_ACTIONS) {
      expect(modelNames.has(name), name).toBe(true);
      expect(getAction(name)?.apiExposure).toBe("api");
    }
    expect(getAction("clockify_workspace_get")?.apiOperation?.operationId).toBe("getWorkspaceOfUser");
    expect(getAction("clockify_templates_list")?.apiOperation?.operationId).toBe("getProjects");
    expect(getAction("clockify_templates_get")?.apiOperation?.operationId).toBe("getProject");
    expect(getAction("clockify_templates_list")?.apiOperation?.path).toBe("/workspaces/{workspaceId}/projects");
    expect(getAction("clockify_templates_get")?.adapterEndpoints?.support).toContain(
      ["read", "api", "GET", "/workspaces/{workspaceId}/projects", "workspace.ts"].join("\0"),
    );
  });

  it("clockify_templates_get resolves a template name server-side", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "tpl-1", name: "Onboarding template", archived: false }],
    });
    const result = await executeAction({
      actionName: "clockify_templates_get",
      args: { name: "Onboarding template" },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected receipt");
    expect((result.receipt.data as { entity?: { id?: string } }).entity?.id).toBe("tpl-1");
  });
});

describe("v2 holiday API actions", () => {
  it("exposes bounded create/update on MODEL_API and keeps list-scan get composite", () => {
    const modelNames = new Set(MODEL_API_ACTION_CATALOG.actions.map((action) => action.name));
    for (const name of ["clockify_holidays_create", "clockify_holidays_update"] as const) {
      expect(modelNames.has(name), name).toBe(true);
      expect(getAction(name)?.apiExposure).toBe("api");
    }
    expect(modelNames.has("clockify_holidays_get")).toBe(false);
    expect(getAction("clockify_holidays_get")?.apiExposure).toBe("composite");
    expect(getAction("clockify_holidays_create")?.materialFields?.find(
      (field): field is Extract<typeof field, { kind: "array_item" }> =>
        field.kind === "array_item" && field.containerPath === "/userIds",
    )?.maxItems).toBe(8);
  });

  it("clockify_holidays_create executes with one POST and bounded scope arrays", async () => {
    const fake = createFakeWorkspace({
      users: [{ id: "admin-1", name: "Admin", email: "a@example.com" }],
      holidays: [],
    });
    const result = await executeAction({
      actionName: "clockify_holidays_create",
      args: { name: "Team day", startDate: "2026-12-25", userIds: ["me"] },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected receipt");
    expect(fake.counts.createHolidayAtomic).toBe(1);
  });
});

describe("v2 webhook API actions", () => {
  it("exposes bounded create/update/list/get/logs/delete on MODEL_API and keeps events local", () => {
    const modelNames = new Set(MODEL_API_ACTION_CATALOG.actions.map((action) => action.name));
    for (const name of [
      "clockify_webhooks_list",
      "clockify_webhooks_get",
      "clockify_webhooks_logs",
      "clockify_webhooks_create",
      "clockify_webhooks_update",
      "clockify_webhooks_delete",
    ] as const) {
      expect(modelNames.has(name), name).toBe(true);
      expect(getAction(name)?.apiExposure).toBe("api");
      expect(getAction(name)?.availabilityByAuthClass.addon.available).toBe(false);
      expect(getAction(name)?.availabilityByAuthClass.addon.reason).toBe("unsupported_auth_class");
    }
    expect(modelNames.has("clockify_webhooks_events")).toBe(false);
    expect(getAction("clockify_webhooks_events")?.apiExposure).toBe("local");
    expect(getAction("clockify_webhooks_create")?.materialFields?.find(
      (field): field is Extract<typeof field, { kind: "array_item" }> =>
        field.kind === "array_item" && field.containerPath === "/triggerSource",
    )?.maxItems).toBe(17);
  });

  it("clockify_webhooks_list parses the workspaceWebhookCount envelope", async () => {
    const fake = createFakeWorkspace({ webhooks: [{ id: "wh-1", name: "Notify", url: "https://example.com/h", webhookEvent: "TIME_ENTRY_CREATED" }] });
    const result = await executeAction({
      actionName: "clockify_webhooks_list",
      args: {},
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected receipt");
    expect(fake.counts.listWebhooks).toBe(1);
  });
});
