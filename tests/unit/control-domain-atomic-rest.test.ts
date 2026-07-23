import { describe, expect, it, vi } from "vitest";
import { createRestCore } from "../../src/clockify/rest/core.js";
import { makeSchedulingRest } from "../../src/clockify/rest/scheduling.js";
import { makeApprovalRest } from "../../src/clockify/rest/approvals.js";
import { makeWebhookRest } from "../../src/clockify/rest/webhooks.js";
import { makeUserRest } from "../../src/clockify/rest/users.js";
import { AmbiguousWriteOutcome } from "../../src/clockify/write-outcome.js";

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function core(fetchImpl: typeof fetch) {
  return createRestCore({ apiBase: "https://api.clockify.me/api/v1", auth: { apiKey: "k" }, fetchImpl });
}

describe("phase 5 control-domain atomic REST primitives", () => {
  it("exposes one-dispatch mutation methods for every owned write class", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const ports = [
      [makeSchedulingRest(core(fetchImpl), "ws-1"), ["createAssignmentAtomic", "updateAssignmentAtomic", "deleteAssignmentAtomic", "publishScheduleAtomic"]],
      [makeApprovalRest(core(fetchImpl), "ws-1"), ["submitApprovalAtomic", "setApprovalStateAtomic", "resubmitApprovalAtomic"]],
      [makeWebhookRest(core(fetchImpl), "ws-1"), ["createWebhookAtomic", "updateWebhookAtomic", "deleteWebhookAtomic"]],
      [makeUserRest(core(fetchImpl), "ws-1"), [
        "inviteUserAtomic", "updateUserRoleAtomic", "updateWorkspaceMemberRateAtomic",
        "updateWorkspaceMemberHourlyRateAtomic", "updateWorkspaceMemberCostRateAtomic", "deactivateUserAtomic",
        "createGroupAtomic", "updateGroupAtomic", "deleteGroupAtomic", "addUserToGroupAtomic", "removeUserFromGroupAtomic",
      ]],
    ] as const;
    for (const [port, methods] of ports) {
      for (const method of methods) expect(typeof (port as unknown as Record<string, unknown>)[method], method).toBe("function");
    }
  });

  it("keeps replace-style scheduling and webhook writes mutation-only after preparation", async () => {
    const schedulingFetch = vi.fn(async () => json([{ id: "a1" }]));
    const scheduling = makeSchedulingRest(core(schedulingFetch as unknown as typeof fetch), "ws-1") as any;
    await scheduling.updateAssignmentAtomic("a1", {
      userId: "u1", projectId: "p1", start: "2026-06-01", end: "2026-06-02", hoursPerDay: 6,
    });
    expect(schedulingFetch).toHaveBeenCalledTimes(1);
    expect((schedulingFetch as any).mock.calls[0]?.[1]?.method).toBe("PATCH");

    const webhookFetch = vi.fn(async () => json({ id: "w1", name: "Renamed" }));
    const webhooks = makeWebhookRest(core(webhookFetch as unknown as typeof fetch), "ws-1") as any;
    await webhooks.updateWebhookAtomic("w1", {
      name: "Renamed", url: "https://x.example/h", webhookEvent: "NEW_TIME_ENTRY",
      triggerSourceType: "WORKSPACE_ID", triggerSource: ["ws-1"],
    });
    expect(webhookFetch).toHaveBeenCalledTimes(1);
    expect((webhookFetch as any).mock.calls[0]?.[1]?.method).toBe("PUT");
  });

  it.each([
    ["assignment", (fetchImpl: typeof fetch) => (makeSchedulingRest(core(fetchImpl), "ws-1") as any).createAssignmentAtomic({ userId: "u1", projectId: "p1", start: "2026-06-01", end: "2026-06-02", hoursPerDay: 8 })],
    ["approval", (fetchImpl: typeof fetch) => (makeApprovalRest(core(fetchImpl), "ws-1") as any).submitApprovalAtomic({ period: "WEEKLY", periodStart: "2026-06-01T00:00:00Z" })],
    ["webhook", (fetchImpl: typeof fetch) => (makeWebhookRest(core(fetchImpl), "ws-1") as any).createWebhookAtomic({ name: "Hook", url: "https://x.example/h", webhookEvent: "NEW_TASK" })],
    ["invite", (fetchImpl: typeof fetch) => (makeUserRest(core(fetchImpl), "ws-1") as any).inviteUserAtomic("new@example.com", false)],
    ["group", (fetchImpl: typeof fetch) => (makeUserRest(core(fetchImpl), "ws-1") as any).createGroupAtomic("QA")],
  ] as const)("classifies a malformed successful %s create as ambiguous", async (_label, invoke) => {
    const fetchImpl = vi.fn(async () => json({ accepted: true }));
    await expect(invoke(fetchImpl as unknown as typeof fetch)).rejects.toBeInstanceOf(AmbiguousWriteOutcome);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["proxy 5xx", async () => json({ error: "bad gateway" }, 502)],
    ["transport close", async () => { throw new Error("socket closed"); }],
    ["non-JSON success", async () => new Response("upstream tunnel", { status: 200 })],
  ] as const)("never retries an ambiguous webhook create after $0", async (_label, response) => {
    const fetchImpl = vi.fn(response);
    const webhooks = makeWebhookRest(core(fetchImpl as unknown as typeof fetch), "ws-1") as any;
    await expect(webhooks.createWebhookAtomic({ name: "Hook", url: "https://x.example/h", webhookEvent: "NEW_TASK" }))
      .rejects.toBeInstanceOf(AmbiguousWriteOutcome);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
