import { describe, expect, it } from "vitest";
import { actionStatusLabel } from "../../src/harness/action-labels.js";

describe("actionStatusLabel", () => {
  it("uses the curated override when one exists", () => {
    expect(actionStatusLabel("clockify_period_report")).toBe("Building the period report");
    expect(actionStatusLabel("assistant_recent_outcomes")).toBe("Checking the audit log");
  });

  it("humanizes unknown action names mechanically (prefix stripped, sentence case)", () => {
    expect(actionStatusLabel("clockify_projects_rate_update")).toBe("Projects rate update");
    expect(actionStatusLabel("clockify_invoices_items_add")).toBe("Invoices items add");
  });

  it("never returns an empty label", () => {
    expect(actionStatusLabel("")).toBe("Working");
    expect(actionStatusLabel("clockify_")).toBe("Working");
    expect(actionStatusLabel("no_prefix_name")).toBe("No prefix name");
  });
});
