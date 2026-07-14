import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getAction } from "../../src/harness/catalog.js";
import {
  defineDurableSafeWriteAction,
} from "../../src/harness/durable-safe-write.js";
import { executeAction } from "../../src/harness/actions.js";
import { durableMutationContract } from "../../src/harness/durable-mutation-contract.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { successReceipt } from "../../src/harness/receipts.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";

afterEach(() => vi.restoreAllMocks());

const contract = durableMutationContract({
  source: "safe",
  targeting: { mode: "create_no_target" },
  strategies: ["create"],
});

function context(fake = createFakeWorkspace()) {
  const calls = { authorize: 0, prepare: 0, executing: 0, scope: 0, settle: 0 };
  return {
    fake,
    calls,
    value: {
      workspaceId: "workspace",
      adminUserId: "admin",
      policy: defaultAdminPolicy(),
      clockify: fake.client,
      authorizeWrite: async () => {
        calls.authorize += 1;
        return undefined;
      },
      operationJournal: {
        prepare() {
          calls.prepare += 1;
          return "operation";
        },
        markExecuting() {
          calls.executing += 1;
        },
        scope() {
          calls.scope += 1;
          throw new Error("scope must not be reached by this test");
        },
        settle() {
          calls.settle += 1;
        },
      },
    },
  };
}

describe("durable safe-write prepare clarification", () => {
  it("returns a grounded clarify result before authorization, journaling, or dispatch", async () => {
    const action = getAction("clockify_tags_create")!;
    const options = [{ id: "tag-1", label: "Existing tag" }];
    vi.spyOn(action, "prepareSafeWrite").mockResolvedValue({
      kind: "clarify",
      clarify: "Which tag should I use?",
      options,
    });
    const test = context();

    const result = await executeAction({
      actionName: action.name,
      args: { name: "ambiguous" },
      context: test.value,
    });

    expect(result).toEqual({
      kind: "clarify",
      message: "Which tag should I use?",
      options,
    });
    expect(test.calls).toEqual({ authorize: 0, prepare: 0, executing: 0, scope: 0, settle: 0 });
    expect(test.fake.counts.createTag ?? 0).toBe(0);
  });

  it("returns the identical clarify result through the builder's direct handler", async () => {
    let dispatches = 0;
    const options = [{ id: "one", label: "One" }];
    const action = defineDurableSafeWriteAction({
      name: "clockify_test_safe_clarify",
      description: "Test safe clarification.",
      group: "work_structure",
      schema: z.object({ name: z.string() }),
      stepName: "Test write",
      mutationContract: contract,
      prepare: () => ({ kind: "clarify", clarify: "Choose one.", options }),
      async dispatch() {
        dispatches += 1;
        return { result: successReceipt({ action: "clockify_test_safe_clarify" }) };
      },
    });

    const test = context();
    const result = await action.handler(test.value, { name: "ambiguous" });

    expect(result).toEqual({ kind: "clarify", message: "Choose one.", options });
    expect(dispatches).toBe(0);
    expect(test.calls).toEqual({ authorize: 0, prepare: 0, executing: 0, scope: 0, settle: 0 });
  });

  it("keeps a prepared branch source-compatible and dispatches once", async () => {
    let dispatches = 0;
    const action = defineDurableSafeWriteAction({
      name: "clockify_test_safe_prepared",
      description: "Test prepared safe write.",
      group: "work_structure",
      schema: z.object({ name: z.string() }),
      stepName: "Test write",
      mutationContract: contract,
      prepare: (_ctx, args) => ({
        operation: { body: { name: args.name } },
        mutationPlan: {
          mode: "single",
          steps: [{ id: "create", kind: "primary", reconciliationStrategy: "create" }],
        },
      }),
      async dispatch(_ctx, operation) {
        dispatches += 1;
        expect(operation).toEqual({ body: { name: "prepared" } });
        return { result: successReceipt({ action: "clockify_test_safe_prepared" }) };
      },
    });

    const test = context();
    const result = await action.handler(test.value, { name: "prepared" });

    expect(result).toEqual({
      kind: "receipt",
      receipt: successReceipt({ action: "clockify_test_safe_prepared" }),
    });
    expect(dispatches).toBe(1);
  });

  it("keeps prepare exceptions on the error-receipt path", async () => {
    const action = getAction("clockify_tags_create")!;
    vi.spyOn(action, "prepareSafeWrite").mockRejectedValue(new Error("prepare read failed"));
    const test = context();

    const result = await executeAction({ actionName: action.name, args: { name: "x" }, context: test.value });

    expect(result).toMatchObject({
      kind: "receipt",
      receipt: { ok: false, code: "execution_error", message: "prepare read failed" },
    });
    expect(test.calls.authorize).toBe(0);
    expect(test.calls.prepare).toBe(0);
    expect(test.fake.counts.createTag ?? 0).toBe(0);
  });

  it.each([
    { kind: "clarify", clarify: 7 },
    { kind: "clarify", clarify: "Choose", options: [{ id: "x", label: 7 }] },
    { operation: { body: {} } },
    { kind: "prepared", operation: {}, mutationPlan: { mode: "single", steps: [] } },
  ])("fails closed for malformed preparation value %#", async (malformed) => {
    const action = getAction("clockify_tags_create")!;
    vi.spyOn(action, "prepareSafeWrite").mockResolvedValue(malformed as never);
    const test = context();

    const result = await executeAction({ actionName: action.name, args: { name: "x" }, context: test.value });

    expect(result).toMatchObject({
      kind: "receipt",
      receipt: { ok: false, code: "invalid_safe_write_preparation" },
    });
    expect(test.calls).toEqual({ authorize: 0, prepare: 0, executing: 0, scope: 0, settle: 0 });
    expect(test.fake.counts.createTag ?? 0).toBe(0);
  });
});
