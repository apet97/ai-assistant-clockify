import { describe, expect, it } from "vitest";
import { sanitizeStoredReplyForModel } from "../../src/routes/api.js";

/**
 * Live item 318: a long session saturated with the deterministic
 * truthful-preview reply ("Review the change below…") taught the model to
 * REPRODUCE that boilerplate as its own answer with zero tool calls. The
 * stored history keeps the exact text (it's what the admin saw); only the
 * model-visible copy is rewritten into a neutral factual note.
 */
describe("sanitizeStoredReplyForModel", () => {
  it("rewrites the single-preview boilerplate into a neutral factual note", () => {
    const out = sanitizeStoredReplyForModel(
      'Review the change below and click "Confirm" to apply it. Nothing has been changed yet.',
    );
    expect(out).not.toContain('click "Confirm"');
    expect(out).not.toContain("Review the change below");
    expect(out).toContain("button confirmation");
  });

  it("rewrites the batch-preview boilerplate too", () => {
    const out = sanitizeStoredReplyForModel(
      'I\'ve prepared 3 changes — review them below and click "Confirm all" to apply. Nothing has been changed yet.',
    );
    expect(out).not.toContain('click "Confirm all"');
    expect(out).toContain("button confirmation");
  });

  it("leaves ordinary assistant replies byte-identical", () => {
    const texts = [
      "Here are your projects: Alpha, Beta.",
      "Done — the tag was created.",
      "I couldn't find an active project named \"X\".",
    ];
    for (const text of texts) expect(sanitizeStoredReplyForModel(text)).toBe(text);
  });
});
