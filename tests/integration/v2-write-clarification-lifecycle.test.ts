import { describe, expect, it } from "vitest";
import request from "supertest";
import {
  composeV2ProductionApp,
  discoverThenCall,
  ndjsonFrames,
} from "../helpers/v2-production-composition.js";

/**
 * Closure-plan PR 4 (F19), end to end through the real composition: an
 * ambiguous WRITE produces grounded chips; selecting an option prepares
 * exactly one operation with ZERO mutation and moves the SAME run directly to
 * awaiting_confirmation with a live preview; Confirm commits and terminalizes
 * the run. No synthetic success card ever appears before confirmation.
 */

const ALPHA_ONE = "aaaaaaaaaaaaaaaaaaaaaaa1";
const ALPHA_TWO = "aaaaaaaaaaaaaaaaaaaaaaa2";

const SEED = {
  tags: [
    { id: ALPHA_ONE, name: "urgent" },
    { id: ALPHA_TWO, name: "urgent" },
  ] as never,
};

const SCRIPT = discoverThenCall("delete a tag", {
  name: "clockify_tags_delete",
  arguments: { name: "urgent" },
});

describe("v2 write clarification lifecycle (F19)", () => {
  it("walks ambiguous write → chips → option → preview → Confirm → terminal run", async () => {
    const c = await composeV2ProductionApp({ script: SCRIPT, seed: SEED });

    // 1. The ambiguous write suspends on a REAL durable clarification.
    const res = await c.chat("delete the urgent tag");
    expect(res.status).toBe(200);
    const runId = c.activeRunId();
    expect(c.store.getRun(c.getRunScope(runId))?.phase).toBe("awaiting_clarification");
    const row = c.store.getActiveClarificationForRun(c.runScope(runId))!;
    expect(row.status).toBe("pending");
    expect(row.originalToolName).toBe("clockify_tags_delete");
    expect(row.candidates.map((cand) => cand.externalId).sort()).toEqual([ALPHA_ONE, ALPHA_TWO]);
    expect(c.clockifyMutations()).toBe(0);
    expect(c.store.countPendingConfirmations(c.sessionId, new Date().toISOString())).toBe(0);

    // 2. Selecting an option prepares ONE operation, zero mutation, and the
    // resolve response itself carries the live preview control.
    const resolved = await request(c.app)
      .post(`/api/clarifications/${row.id}/resolve`)
      .set("Cookie", c.cookie)
      .send({ optionId: ALPHA_TWO });
    expect(resolved.status, resolved.text).toBe(200);
    const frames = ndjsonFrames(resolved.text) as Array<{
      type: string;
      attachment?: { kind: string; envelope?: { confirmation?: { id: string; nonce: string } } };
    }>;
    const control = frames.find((f) => f.attachment?.kind === "pending_confirmation")!
      .attachment!.envelope!.confirmation!;
    expect(control.nonce.length).toBeGreaterThan(0);
    expect(c.clockifyMutations()).toBe(0);

    // The SAME run moved directly to awaiting_confirmation, bound to the
    // prepared operation; the clarification row resolved onto that operation.
    const run = c.store.getRun(c.getRunScope(runId))!;
    expect(run.phase).toBe("awaiting_confirmation");
    expect(run.continuation.kind).toBe("awaiting_operations");
    const settledRow = c.store.getPendingClarification(row.id, c.runScope(runId))!;
    expect(settledRow.status).toBe("resolved");
    expect(settledRow.selectedOptionId).toBe(ALPHA_TWO);
    expect(settledRow.operationId).toBeTruthy();
    // No fabricated completed-write entry exists before confirmation.
    expect(run.completedResults.some((r) => r.actionName === "clockify_tags_delete")).toBe(false);

    // 3. Confirm commits the write against the CHOSEN project and settles the run.
    const confirmed = await request(c.app)
      .post(`/api/confirmations/${control.id}/confirm`)
      .set("Cookie", c.cookie)
      .send({ nonce: control.nonce });
    expect(confirmed.status).toBe(200);
    expect(c.clockifyMutations()).toBeGreaterThanOrEqual(1);
    expect(c.store.getRun(c.getRunScope(runId))?.phase).toBe("completed");
    expect(c.store.getActiveRunForSession(c.sessionId, c.workspaceId, c.adminUserId)).toBeUndefined();

    // 4. The session is immediately usable.
    const next = await c.chat("thanks, what changed?");
    expect(next.status).toBe(200);
  });
});
