import { describe, expect, it } from "vitest";
import { validateWriteAuthorityOperation } from "../../src/harness/write-authority.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";

/**
 * A `null` array is the ABSENCE of data, not undeclared data.
 *
 * Production, 2026-08-03: every attempt to edit a time entry's description
 * failed with `write_port_not_ready`. The operator log named the cause
 * `intent_capability_denied`, and the exact verdict was
 *
 *   undeclared_server_derived_path:operation.body.tagIds
 *
 * `clockify_entries_update` is a GET-then-PUT full replace, so its body carries
 * the entry's CURRENT `tagIds`. Clockify returns `null` there for an entry with
 * no tags. The authority declares `operation.body.tagIds[]` — the ELEMENT path
 * — and `collectOperationLeaves` emits an empty array as no leaves at all but a
 * `null` as the bare scalar `operation.body.tagIds`, which matches nothing.
 *
 * So: an entry WITH tags was editable and an entry WITHOUT tags was not. The
 * fixtures all had tags, which is why 5,700 tests were green while the feature
 * was unusable on a real workspace.
 *
 * This is not one action's typo. Every action whose declaration covers only an
 * element path breaks the moment the wire returns `null` for that array, and
 * Clockify returns `null` for optional id lists throughout.
 */
describe("a null array is covered by its declared element path", () => {
  const action = MODEL_API_ACTION_CATALOG.get("clockify_entries_update")!;
  const plan = {
    mode: "single" as const,
    maxHostCalls: 1,
    steps: [{ id: "update-time-entry", kind: "primary" as const, reconciliationStrategy: "update" as const }],
  };
  const payloadWith = (tagIds: unknown) => ({
    id: "6a6d5afd34aa2a09efc4c7c7",
    description: "123",
    body: {
      start: "2026-08-02T22:01:00Z",
      end: "2026-08-02T22:15:00Z",
      description: "123",
      projectId: "69c99ec58206e6e7a30f7c67",
      taskId: null,
      tagIds,
      billable: true,
    },
  });

  it("admits the exact production operation that was refused", () => {
    expect(validateWriteAuthorityOperation(action, payloadWith(null), plan)).toBeUndefined();
  });

  it("treats null, undefined and empty identically — all carry no data", () => {
    for (const value of [null, undefined, []]) {
      expect(validateWriteAuthorityOperation(action, payloadWith(value), plan), JSON.stringify(value)).toBeUndefined();
    }
  });

  it("keeps admitting a populated array, which always worked", () => {
    expect(validateWriteAuthorityOperation(action, payloadWith(["6a1b2c3d4e5f60718293a4b5"]), plan)).toBeUndefined();
  });

  it("still refuses a genuinely undeclared id path", () => {
    const smuggled = payloadWith(null) as unknown as { body: Record<string, unknown> };
    smuggled.body.approvalRequestId = "6a1b2c3d4e5f60718293a4b5";
    expect(validateWriteAuthorityOperation(action, smuggled, plan))
      .toBe("undeclared_server_derived_path:operation.body.approvalRequestId");
  });
});
