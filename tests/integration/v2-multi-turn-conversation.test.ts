import { describe, expect, it } from "vitest";
import { HISTORY_WINDOW_MESSAGES } from "../../src/routes/chat-constants.js";
import { composeV2ProductionApp } from "../helpers/v2-production-composition.js";

describe("v2 multi-turn conversation history", () => {
  it("includes the previous question and answer before the new request", async () => {
    const c = await composeV2ProductionApp({
      script: [
        { text: "There is one matching entry.", toolCalls: [] },
        { text: "I would update that entry.", toolCalls: [] },
      ],
    });

    const first = await c.chat("list my time entries");
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const second = await c.chat("update the description on that one");
    expect(second.status, JSON.stringify(second.body)).toBe(200);

    const messages = c.providerMessages(1);
    const conversation = messages.slice(1);
    const joined = conversation.map((message) => message.content).join("\n");
    expect(joined).toContain("list my time entries");
    expect(joined).toContain("There is one matching entry.");
    const last = conversation.at(-1);
    expect(last?.role).toBe("user");
    expect(last?.content).toBe("update the description on that one");
  });

  it("resolves a terse both follow-up against the earlier either-or request", async () => {
    const c = await composeV2ProductionApp({
      script: [
        { text: "A is available; B is also available.", toolCalls: [] },
        { text: "Showing both.", toolCalls: [] },
      ],
    });

    const first = await c.chat("show me A or B");
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const second = await c.chat("both");
    expect(second.status, JSON.stringify(second.body)).toBe(200);

    const joined = c.providerMessages(1).map((message) => message.content).join("\n");
    expect(joined).toContain("show me A or B");
    expect(joined).toContain("both");
  });

  it("bounds a long conversation by the configured history window", async () => {
    const c = await composeV2ProductionApp({
      script: Array.from({ length: 15 }, (_, index) => ({ text: `answer-${index}`, toolCalls: [] })),
    });

    for (let index = 0; index < 15; index += 1) {
      const response = await c.chat(`message-${index}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    }

    const messages = c.providerMessages(14);
    expect(messages.length).toBeGreaterThan(2);
    expect(messages.length).toBeLessThanOrEqual(HISTORY_WINDOW_MESSAGES + 2);
  });

  it("includes the current message exactly once", async () => {
    const c = await composeV2ProductionApp({
      script: [
        { text: "First answer.", toolCalls: [] },
        { text: "Second answer.", toolCalls: [] },
      ],
    });

    await c.chat("first request");
    const current = "second request";
    const response = await c.chat(current);
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const joined = c.providerMessages(1).map((message) => message.content).join("\n");
    expect(joined.split(current).length - 1).toBe(1);
  });
});
