import { describe, expect, it } from "vitest";
import { executeAction } from "../../src/harness/actions.js";
import { type AdminPolicy, defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext } from "../../src/harness/action.js";

const NOW = new Date("2026-06-10T12:00:00.000Z");

function makeContext(overrides: Partial<ActionContext> = {}, policy: AdminPolicy = defaultAdminPolicy()): ActionContext {
  const fake = createFakeWorkspace();
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy,
    clockify: fake.client,
    now: () => NOW,
    ...overrides,
  };
}

describe("assistant_recent_outcomes — recap answers come from the AUDIT LOG, not chat memory (live items 304/316)", () => {
  it("reports per-action success/failure + the error taxonomy from the audited outcomes", async () => {
    const sinceArgs: Array<string | undefined> = [];
    const context = makeContext({
      recentOutcomes: (sinceIso) => {
        sinceArgs.push(sinceIso);
        return {
          outcomes: [
            { actionName: "clockify_log_work", ok: true },
            { actionName: "clockify_approvals_submit", ok: false, code: "clockify_error" },
          ],
          confirmationStatuses: ["succeeded", "cancelled"],
        };
      },
    });
    const result = await executeAction({ actionName: "assistant_recent_outcomes", args: {}, context });
    if (result.kind !== "receipt" || !result.receipt.ok) {
      throw new Error(`expected a success receipt, got ${JSON.stringify(result)}`);
    }
    const metrics = (result.receipt.data as { metrics: any }).metrics;
    expect(metrics.totals).toMatchObject({ actions: 2, succeeded: 1, failed: 1 });
    expect(metrics.byAction).toContainEqual({
      action: "clockify_approvals_submit",
      total: 1,
      succeeded: 0,
      failed: 1,
    });
    expect(metrics.errorsByCode).toContainEqual({ code: "clockify_error", count: 1 });
    expect(metrics.confirmations).toMatchObject({ previewed: 2, confirmed: 1, cancelled: 1 });
    // The window defaults to the last 24h, resolved server-side from ctx.now.
    expect(sinceArgs[0]).toBe(new Date(NOW.getTime() - 24 * 3_600_000).toISOString());
  });

  it("honors an explicit sinceHours window", async () => {
    const sinceArgs: Array<string | undefined> = [];
    const context = makeContext({
      recentOutcomes: (sinceIso) => {
        sinceArgs.push(sinceIso);
        return { outcomes: [], confirmationStatuses: [] };
      },
    });
    const result = await executeAction({
      actionName: "assistant_recent_outcomes",
      args: { sinceHours: 2 },
      context,
    });
    expect(result.kind).toBe("receipt");
    expect(sinceArgs[0]).toBe(new Date(NOW.getTime() - 2 * 3_600_000).toISOString());
  });

  it("returns an honest error when the route did not provide the capability", async () => {
    const result = await executeAction({ actionName: "assistant_recent_outcomes", args: {}, context: makeContext() });
    if (result.kind !== "receipt" || result.receipt.ok) throw new Error("expected an error receipt");
    expect(result.receipt.code).toBe("unsupported");
  });

  it("is gated like a read (workspace_settings off → policy_denied)", async () => {
    const off = defaultAdminPolicy();
    off.groups.workspace_settings = "off";
    const result = await executeAction({
      actionName: "assistant_recent_outcomes",
      args: {},
      context: makeContext(
        { recentOutcomes: () => ({ outcomes: [], confirmationStatuses: [] }) },
        off,
      ),
    });
    if (result.kind !== "receipt" || result.receipt.ok) throw new Error("expected an error receipt");
    expect(result.receipt.code).toBe("policy_denied");
  });
});
