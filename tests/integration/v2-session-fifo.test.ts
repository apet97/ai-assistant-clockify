import { describe, expect, it } from "vitest";
import request from "supertest";
import {
  composeV2ProductionApp,
  discoverThenCall,
} from "../helpers/v2-production-composition.js";

/**
 * Closure-plan PR 2 (F21): clarification resolution runs under the ONE
 * composition-owned session FIFO shared with chat/confirm/undo. A clarification
 * resolve that is still mid-flight holds the session lock, so a concurrent
 * ordinary chat message for the SAME session cannot start until the resolve
 * settles — arrival order is execution order.
 */

const TWO_ALICES = {
  users: [
    { id: "aaaaaaaaaaaaaaaaaaaaaaa1", name: "Alice", email: "alice.one@example.com" },
    { id: "aaaaaaaaaaaaaaaaaaaaaaa2", name: "Alice", email: "alice.two@example.com" },
  ],
};

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("v2 shared session FIFO", () => {
  it("serializes a chat message behind an in-flight clarification resolve", async () => {
    const c = await composeV2ProductionApp({
      script: discoverThenCall("list time entries", {
        name: "clockify_entries_list",
        arguments: { userId: "Alice" },
      }),
      seed: TWO_ALICES,
    });

    await c.chat("list Alice's entries");
    const runId = c.activeRunId();
    const clarification = c.store.getActiveClarificationForRun(c.runScope(runId))!;

    // Instrument the model AFTER the suspension: the next model call belongs to
    // the resolve's resumed run and BLOCKS until released; the chat turn's call
    // is identified by its own message text.
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = c.model.completeWithTools;
    c.model.completeWithTools = (async (messages, tools) => {
      if (JSON.stringify(messages).includes("hello after the resolve")) {
        order.push("chat-model");
      } else {
        order.push("resume-model");
        await gate;
      }
      return original(messages, tools);
    }) as typeof original;

    const resolveResponse = request(c.app)
      .post(`/api/clarifications/${clarification.id}/resolve`)
      .set("Cookie", c.cookie)
      .send({ optionId: "aaaaaaaaaaaaaaaaaaaaaaa2" })
      .then((res) => {
        order.push("resolve-settled");
        return res;
      });
    await until(() => order.includes("resume-model"));

    const chatResponse = c.chat("hello after the resolve").then((res) => {
      order.push("chat-settled");
      return res;
    });
    // The session lock is HELD by the resolve: the chat turn must not reach the
    // provider while the resolve is still blocked.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(order).toEqual(["resume-model"]);

    release();
    const [resolved, chatted] = await Promise.all([resolveResponse, chatResponse]);
    expect(resolved.status).toBe(200);
    expect(chatted.status).toBe(200);
    // Server-side execution order is the arrival order: the resolve's model
    // work strictly precedes the chat turn's. (Client-observed settlement of
    // the resolve response races the next request's start and is not asserted.)
    expect(order[0]).toBe("resume-model");
    expect(order.indexOf("resume-model")).toBeLessThan(order.indexOf("chat-model"));
    expect(order).toContain("resolve-settled");
    expect(order).toContain("chat-settled");
  });
});
