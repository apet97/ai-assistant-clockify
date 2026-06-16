import { describe, expect, it } from "vitest";
import { leftBehindNote } from "../../src/harness/compose.js";

/**
 * Enterprise audit (silent failure): composite rollback warnings were computed but
 * every caller hardcoded "Nothing partial was left behind." even when rollback itself
 * failed and orphaned entities remained. This pins the truthful note.
 */
describe("leftBehindNote", () => {
  it("reassures only when rollback was clean", () => {
    expect(leftBehindNote([])).toBe("Nothing partial was left behind.");
  });

  it("warns and names the orphans when rollback itself failed", () => {
    const note = leftBehindNote([
      { message: "couldn't delete project Apollo" },
      { message: "couldn't delete task Backend" },
    ]);
    expect(note).toContain("could NOT be rolled back");
    expect(note).toContain("project Apollo");
    expect(note).toContain("task Backend");
    expect(note).not.toContain("Nothing partial");
  });
});
