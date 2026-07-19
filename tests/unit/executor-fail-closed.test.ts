import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ActionContext, ActionDefinition, ActionResult } from "../../src/harness/action.js";
import { successReceipt } from "../../src/harness/receipts.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";

/**
 * Pins the two fail-closed tripwires in `executeAction` (src/harness/actions.ts)
 * that no catalog action exercises (catalog actions return previews for risky
 * writes and carry a real risk label):
 *
 *  1. `risky_without_confirmation` — the last-line guard of the core invariant
 *     "a risky action must never execute on first proposal". A misbehaving
 *     handler that returns an ok receipt instead of a preview is BLOCKED and
 *     flagged, never allowed to mutate-and-report-success.
 *  2. `unclassified_action` — the fail-closed default: an action whose risk set
 *     is neither an explicit read nor a safe_write nor confirmation-requiring is
 *     REFUSED rather than executed.
 *
 * Done by stubbing the catalog's `getAction` so we can inject pathological
 * actions; the rest of `executeAction` (policy gate, risk classifier, dispatch)
 * runs for real. An accidental inversion/removal of either guard fails CI here.
 */

// A mutable handle the hoisted vi.mock factory reads, so each test can swap the
// action `getAction` returns without re-mocking the module.
const stub = vi.hoisted(() => ({ action: undefined as ActionDefinition | undefined }));

vi.mock("../../src/harness/catalog.js", () => ({
  getAction: (_name: string): ActionDefinition | undefined => stub.action,
}));

// Import AFTER the mock is registered so `executeAction` binds to the stub.
const { executeAction } = await import("../../src/harness/actions.js");

function makeContext(fake: FakeWorkspace): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy: defaultAdminPolicy(),
    clockify: fake.client,
    now: () => new Date("2026-06-11T00:00:00.000Z"),
  };
}

describe("executeAction fail-closed tripwires", () => {
  beforeEach(() => {
    stub.action = undefined;
  });

  it("blocks a misbehaving risky handler that returns an ok receipt (risky_without_confirmation)", async () => {
    const fake = createFakeWorkspace();
    let handlerRan = false;
    // A destructive (confirmation-required) action whose handler MISBEHAVES by
    // returning a success receipt on first proposal instead of a preview.
    stub.action = {
      kind: "risky_write",
      name: "evil_destroy",
      description: "stub",
      featureGroup: "work_structure",
      risks: ["destructive"],
      schema: z.object({}),
      async handler(): Promise<ActionResult> {
        handlerRan = true;
        return { kind: "receipt", receipt: successReceipt({ action: "evil_destroy" }) };
      },
      async commit() {
        return successReceipt({ action: "evil_destroy" });
      },
    };

    const result = await executeAction({
      actionName: "evil_destroy",
      args: {},
      context: makeContext(fake),
    });

    expect(result.kind).toBe("receipt");
    if (result.kind !== "receipt") throw new Error("expected a receipt");
    expect(result.receipt.ok).toBe(false);
    if (result.receipt.ok) throw new Error("expected an error receipt");
    expect(result.receipt.code).toBe("risky_without_confirmation");
    // The handler's ok receipt was DISCARDED, not returned.
    expect(handlerRan).toBe(true);
    // No mutation reached the workspace (the stub handler never touches it; the
    // guard returns before any commit path).
    expect(Object.keys(fake.counts)).toHaveLength(0);
  });

  it("refuses an action whose risks are neither read nor safe nor confirmation-requiring (unclassified_action)", async () => {
    const fake = createFakeWorkspace();
    let handlerRan = false;
    // risks: [] — not a read, not a safe_write, not confirmation-requiring.
    stub.action = {
      kind: "invalid",
      name: "unclassified_thing",
      description: "stub",
      featureGroup: "work_structure",
      risks: [],
      schema: z.object({}),
      async handler(): Promise<ActionResult> {
        handlerRan = true;
        return { kind: "receipt", receipt: successReceipt({ action: "unclassified_thing" }) };
      },
    } as unknown as ActionDefinition;

    const result = await executeAction({
      actionName: "unclassified_thing",
      args: {},
      context: makeContext(fake),
    });

    expect(result.kind).toBe("receipt");
    if (result.kind !== "receipt") throw new Error("expected a receipt");
    expect(result.receipt.ok).toBe(false);
    if (result.receipt.ok) throw new Error("expected an error receipt");
    expect(result.receipt.code).toBe("unclassified_action");
    // The handler was never invoked — the action is refused before dispatch.
    expect(handlerRan).toBe(false);
    expect(Object.keys(fake.counts)).toHaveLength(0);
  });
});
