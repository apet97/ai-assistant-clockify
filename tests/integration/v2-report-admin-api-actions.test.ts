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
