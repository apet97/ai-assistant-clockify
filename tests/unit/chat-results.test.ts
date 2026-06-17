import { describe, expect, it } from "vitest";
import { truthfulReplyText } from "../../src/routes/chat-results.js";

// truthfulReplyText is the single-turn truthfulness override: the model narrates
// the batch outcome BEFORE the actions run, so an optimistic "Done!" must be
// replaced when the receipts disagree with it.
const okReceipt = (n = "a") => ({ kind: "receipt", receipt: { ok: true, changed: { created: [{ type: "tag", id: n, name: n }] } } });
const failReceipt = () => ({ kind: "receipt", receipt: { ok: false, code: "x", message: "nope" } });

describe("truthfulReplyText — single-turn actions outcome", () => {
  it("PARTIAL failure: replaces the optimistic narration with a count-accurate line", () => {
    const results = [okReceipt("a"), failReceipt()];
    const out = truthfulReplyText(results, "Done! Created both tags.", "actions");
    expect(out).not.toMatch(/Done!/);
    expect(out).toMatch(/1 of 2/);
    expect(out).toMatch(/failed/i);
  });

  it("ALL-failed still reports nothing was changed", () => {
    const results = [failReceipt(), failReceipt()];
    const out = truthfulReplyText(results, "Done! Created both tags.", "actions");
    expect(out).toMatch(/nothing was changed/i);
  });

  it("ALL-success leaves the model's truthful narration untouched", () => {
    const results = [okReceipt("a")];
    const out = truthfulReplyText(results, "Done! Created the tag.", "actions");
    expect(out).toBe("Done! Created the tag.");
  });
});
