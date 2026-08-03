import { describe, expect, it } from "vitest";
import { composeV2ProductionApp } from "../helpers/v2-production-composition.js";

/**
 * The follow-up turn, end to end through the real app/store boundary.
 *
 * The unit test pins that `buildFreshMessages` places history correctly; this
 * pins that production actually SUPPLIES it. Those are different failures: v2's
 * builder was perfectly correct and simply never received a window, which is
 * how a chat product shipped with no memory of its own conversation.
 *
 * Reproduces the shape of the 2026-08-03 session on ede5896: a first turn that
 * answers, then a terse follow-up that is meaningless without it.
 */
describe("a v2 follow-up turn can see the previous turn", () => {
  it("sends the earlier exchange to the provider, with the new message last", async () => {
    const c = await composeV2ProductionApp({
      script: [
        { text: "There is one entry, id 6a6fdef34135cca0c943b998.", toolCalls: [] },
        { text: "Updating that entry.", toolCalls: [] },
      ],
    });

    const first = await c.chat("ALL ENTRIES FOR THIS YEAR");
    expect(first.status).toBe(200);

    const second = await c.chat("UPDATE THE DESCRIPTION TO 'DESC'");
    expect(second.status).toBe(200);

    // The SECOND provider call is the one that used to be blind.
    const messages = c.providerMessages(1);
    expect(messages[0]!.role).toBe("system");

    const conversation = messages.slice(1);
    expect(conversation.length).toBeGreaterThan(1);
    // The prior exchange is present...
    const joined = conversation.map((m) => m.content).join("\n");
    expect(joined).toContain("ALL ENTRIES FOR THIS YEAR");
    expect(joined).toContain("6a6fdef34135cca0c943b998");
    // ...and the new request is LAST, so it is unambiguously what to answer.
    expect(conversation[conversation.length - 1]!.role).toBe("user");
    expect(conversation[conversation.length - 1]!.content).toBe("UPDATE THE DESCRIPTION TO 'DESC'");
    // The current message appears exactly once — history must not duplicate it.
    expect(joined.split("UPDATE THE DESCRIPTION TO 'DESC'").length - 1).toBe(1);
  });

  it("gives the first turn of a session no history to see", async () => {
    const c = await composeV2ProductionApp({ script: [{ text: "Hello.", toolCalls: [] }] });

    await c.chat("what can you do?");

    const messages = c.providerMessages(0);
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(messages[1]!.content).toBe("what can you do?");
  });
});
