import { describe, expect, it } from "vitest";
import { executeAction, commitConfirmedOperation } from "../../src/harness/actions.js";
import type { ActionContext } from "../../src/harness/action.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";

/**
 * Preview AND commit for `clockify_entries_update`.
 *
 * There was no such test. `v2-time-entry-api-actions.test.ts` has one named
 * "previews with GET support then commits one PUT" whose body only previews and
 * asserts ZERO mutations — so the confirm half of the most-used write in the
 * product was never exercised, and it was broken in production:
 *
 *   "The target changed or could not be verified. No Clockify mutation was sent."
 *
 * Cause: `fetchStructureSnapshot` re-verifies the target before dispatch and
 * requires the re-fetched projection to carry a string `id`. For a time entry
 * that projection is `prepareTimeEntryUpdate({id})`, and the REAL adapter
 * returns `{start,end,description,projectId,taskId,tagIds,billable}` — no `id`.
 * Verification therefore failed every time, for every entry.
 *
 * The fake hid it by spreading the whole stored row, which does have an `id`.
 * It now returns exactly the adapter's seven keys, so this test fails without
 * the fix.
 */

const NOW = new Date("2026-06-05T12:00:00.000Z");

function makeContext(fake: FakeWorkspace): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy: defaultAdminPolicy(),
    clockify: fake.client,
    now: () => NOW,
    timeZone: "UTC",
    weekStartsOn: 1,
  } as ActionContext;
}

describe("clockify_entries_update commits, not just previews", () => {
  it("verifies the target and sends exactly one PUT for a TAGLESS entry", async () => {
    // Tagless and task-less: the production shape, where Clockify sends nulls.
    const fake = createFakeWorkspace({
      entries: [{ id: "e1", description: "", start: "2026-06-05T09:00:00Z", end: "2026-06-05T10:00:00Z" }],
    });
    const ctx = makeContext(fake);

    const preview = await executeAction({
      actionName: "clockify_entries_update",
      args: { id: "e1", description: "123" },
      context: ctx,
    });
    if (preview.kind !== "preview") throw new Error(`expected preview, got ${preview.kind}`);
    expect(fake.counts.updateTimeEntryAtomic ?? 0).toBe(0);

    const receipt = await commitConfirmedOperation(ctx, preview.operation);

    // The whole point: the pre-dispatch verification must PASS.
    expect(JSON.stringify(receipt)).not.toContain("could not be verified");
    expect(receipt.ok).toBe(true);
    expect(fake.counts.updateTimeEntryAtomic).toBe(1);
  });
});
