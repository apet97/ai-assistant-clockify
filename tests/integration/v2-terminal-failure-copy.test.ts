import { describe, expect, it, vi } from "vitest";
import { composeV2ProductionApp } from "../helpers/v2-production-composition.js";
import { DISCOVERY_META_TOOL_NAME } from "../../src/harness/api-operation.js";
import { copyFor } from "../../src/assistant-v2/terminal-reason.js";
import { V2_LIMITS } from "../../src/assistant-v2/budgets.js";

/**
 * The admin-facing end of a v2 run that dies without a reply.
 *
 * An admin typed "create tag named asdsad" in production and was shown
 * `Assistant run failed: too_many_refinements`. There was no test on this route
 * at all (`grep -rln "Assistant run failed" tests/` returned nothing), which is
 * why an internal enum reached a customer.
 *
 * Both cases below drive the REAL route over the real composed app and store.
 * Nothing here hand-authors a protocol frame or a `RunOutcome`: the only seam
 * touched is the model provider itself — scripted tool calls in the first test,
 * a throwing `completeWithTools` in the second — which is exactly the boundary
 * a real provider occupies.
 */

/** One discovery call. Identical arguments produce an identical signature. */
function search(query: string) {
  return {
    text: "",
    toolCalls: [{ id: "tc-find", name: DISCOVERY_META_TOOL_NAME, arguments: { query } }],
  };
}

describe("v2 terminal failure is reported to the admin as a sentence", () => {
  it("renders admin copy, not the internal code, when discovery runs out", async () => {
    // Spend the discovery budget, whatever it is: N distinct searches exhaust
    // it, the next is denied `too_many_refinements`, and one byte-identical
    // repeat trips the no-progress detector (runner.ts:301), which ends the run
    // carrying that denial.
    //
    // Derived from V2_LIMITS rather than hardcoded, so raising the budget
    // cannot silently turn this into a test of something else. The two extra
    // calls are why maxDiscoveryCalls must stay <= maxModelCalls - 2: above
    // that the run ends `budget_exhausted` and never reports the real reason.
    const searches = Array.from({ length: V2_LIMITS.maxDiscoveryCalls }, (_, i) => search(`tags ${i}`));
    expect(V2_LIMITS.maxDiscoveryCalls + 2).toBeLessThanOrEqual(V2_LIMITS.maxModelCalls);
    const c = await composeV2ProductionApp({
      script: [...searches, search("create a tag"), search("create a tag")],
    });
    try {
      const res = await c.chat("create tag named asdsad");

      // 502 is the route's existing status for a failed turn; unchanged here.
      expect(res.status).toBe(502);
      const body = res.body as { ok?: boolean; code?: string; message?: string };
      expect(body.ok).toBe(false);
      expect(body.code).toBe("too_many_refinements");
      expect(body.message).toBe(copyFor("too_many_refinements"));

      // The two strings the admin actually saw in production.
      expect(body.message).not.toContain("too_many_refinements");
      expect(body.message).not.toContain("Assistant run failed");
      expect(JSON.stringify(body)).not.toContain("Assistant run failed");
    } finally {
      c.close();
    }
  });

  it("contains a hostile model error: none of it reaches code or message", async () => {
    // The exact classes commit 75a87a8 proved real error messages carry.
    const JWT = "eyJhbGciOiJIUzI1NiJ9.x.y";
    const WORKSPACE_ID = "64ad1305c701cc5be7c26fe4";
    const ADMIN_TEXT = "delete every time entry for Ana";
    const hostile = `Clockify POST /workspaces/${WORKSPACE_ID}/tags failed for "${ADMIN_TEXT}" token=${JWT}`;

    const c = await composeV2ProductionApp({ script: [search("tag")] });
    try {
      // The provider seam throws — the real shape of a failed model call.
      c.model.completeWithTools = vi.fn(async () => {
        throw new Error(hostile);
      });
      // The runner logs a bounded classification; keep it off the test output
      // and assert separately that it carries none of the hostile bytes.
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

      const res = await c.chat("create tag named asdsad");

      const body = res.body as { ok?: boolean; code?: string; message?: string };
      expect(body.ok).toBe(false);
      expect(body.code).toBe("model_failed");
      expect(body.message).toBe(copyFor("model_failed"));

      const serialized = JSON.stringify(body);
      for (const secret of [JWT, WORKSPACE_ID, ADMIN_TEXT, hostile]) {
        expect(serialized, `response body must not carry ${secret}`).not.toContain(secret);
      }

      // The operator log gets a classification, never the message itself.
      const logged = errorLog.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
      expect(logged).toContain("event=model_call_failed");
      for (const secret of [JWT, WORKSPACE_ID, ADMIN_TEXT]) {
        expect(logged, `operator log must not carry ${secret}`).not.toContain(secret);
      }
      errorLog.mockRestore();
    } finally {
      vi.restoreAllMocks();
      c.close();
    }
  });
});
