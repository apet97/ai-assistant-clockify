import { describe, expect, it } from "vitest";
import { executeAction } from "../../src/harness/actions.js";
import { type AdminPolicy, defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext } from "../../src/harness/action.js";

const NOW = new Date("2026-06-06T00:00:00.000Z");
function makeContext(fake: FakeWorkspace, policy: AdminPolicy = defaultAdminPolicy()): ActionContext {
  return { workspaceId: "ws-1", adminUserId: "admin-1", policy, clockify: fake.client, now: () => NOW };
}

describe("audit actions", () => {
  it("audit_logs_search is read-gated and returns capped entries", async () => {
    const fake = createFakeWorkspace();
    const ok = await executeAction({ actionName: "clockify_audit_logs_search", args: { actions: ["CREATE_PROJECT"], start: "2026-06-01T00:00:00Z", end: "2026-06-07T00:00:00Z" }, context: makeContext(fake) });
    if (ok.kind === "receipt" && ok.receipt.ok) {
      expect((ok.receipt.data as any).count).toBe(1);
      expect((ok.receipt.data as any).truncated).toBe(false);
    } else throw new Error("expected receipt");
    expect(fake.counts.searchAuditLog).toBe(1);

    const off = defaultAdminPolicy();
    off.groups.audit_log = "off";
    const denied = await executeAction({ actionName: "clockify_audit_logs_search", args: { actions: ["CREATE_PROJECT"], start: "s", end: "e" }, context: makeContext(fake, off) });
    if (denied.kind === "receipt" && !denied.receipt.ok) expect(denied.receipt.code).toBe("policy_denied");
    else throw new Error("expected policy_denied");
  });

  it("audit_logs_search rejects an empty actions list (invalid_args)", async () => {
    const fake = createFakeWorkspace();
    const bad = await executeAction({ actionName: "clockify_audit_logs_search", args: { actions: [], start: "s", end: "e" }, context: makeContext(fake) });
    if (bad.kind === "receipt" && !bad.receipt.ok) expect(bad.receipt.code).toBe("invalid_args");
    else throw new Error("expected invalid_args");
  });

  it("entity_changes_list reads the change feed", async () => {
    const fake = createFakeWorkspace();
    const r = await executeAction({ actionName: "clockify_entity_changes_list", args: { changeType: "created" }, context: makeContext(fake) });
    if (r.kind === "receipt" && r.receipt.ok) expect((r.receipt.data as any).changeType).toBe("created");
    else throw new Error("expected receipt");
    expect(fake.counts.listEntityChanges).toBe(1);
  });
});
