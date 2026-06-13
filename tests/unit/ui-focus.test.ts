import { describe, expect, it } from "vitest";
import { removeCardReturningFocus } from "../../src/ui/shared.js";

/**
 * r1-ux-copy-a11y-04 (WCAG 2.4.3 Focus Order): when Confirm/Cancel removes the
 * preview card, keyboard focus sits on the just-clicked button INSIDE the card.
 * Plain `card.remove()` drops focus to <body>, so the next Tab restarts from the
 * page top. `removeCardReturningFocus` pairs the removal with a focus return so
 * focus always lands on a stable target (mount points it at the composer input).
 *
 * The vitest env is "node" (no DOM); the focus-return DECISION/ORCHESTRATION is
 * the extractable logic — the actual `.focus()` is DOM glue verified by the
 * type-check + vite build.
 */
describe("removeCardReturningFocus (focus is not lost to <body> after Confirm/Cancel)", () => {
  it("returns focus exactly once whenever the card is removed", () => {
    const calls: string[] = [];
    removeCardReturningFocus(
      () => calls.push("remove"),
      () => calls.push("focus"),
    );
    // Focus must be returned (not left on the removed button → <body>) ...
    expect(calls).toContain("focus");
    // ... and only once.
    expect(calls.filter((c) => c === "focus")).toHaveLength(1);
  });

  it("returns focus AFTER removing the card (the target is settled first)", () => {
    const calls: string[] = [];
    removeCardReturningFocus(
      () => calls.push("remove"),
      () => calls.push("focus"),
    );
    expect(calls).toEqual(["remove", "focus"]);
  });

  it("still removes the card even if returning focus throws (best-effort focus)", () => {
    let removed = false;
    expect(() =>
      removeCardReturningFocus(
        () => {
          removed = true;
        },
        () => {
          throw new Error("focus target detached");
        },
      ),
    ).not.toThrow();
    expect(removed).toBe(true);
  });
});
