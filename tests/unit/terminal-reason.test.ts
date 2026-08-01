import { describe, expect, it } from "vitest";
import {
  asTerminalReason,
  copyFor,
  TERMINAL_REASONS,
  type TerminalReason,
} from "../../src/assistant-v2/terminal-reason.js";

/**
 * The admin-facing half of the v2 terminal-failure contract.
 *
 * Every assertion here iterates `TERMINAL_REASONS` rather than hand-listing
 * sentences: a test that repeats the copy rots the moment the copy is edited,
 * and would then be pinning a stale string instead of the property.
 */
describe("terminal reason copy", () => {
  it("is total: every reason has non-empty admin copy", () => {
    for (const reason of TERMINAL_REASONS) {
      const copy = copyFor(reason);
      expect(copy, `copy for ${reason}`).toBeTypeOf("string");
      expect(copy.trim().length, `copy for ${reason} is non-empty`).toBeGreaterThan(0);
    }
  });

  it("leaks no internal identifier into admin copy", () => {
    for (const reason of TERMINAL_REASONS) {
      const copy = copyFor(reason);
      // The reason itself, the underscore that marks every internal enum in
      // this codebase, and any snake_case token at all.
      //
      // The identifier check applies only to snake_case members. `cancelled`
      // is a single ordinary English word, and forbidding it would forbid the
      // clearest possible sentence; the underscore and snake_case assertions
      // below are what actually carry this property.
      if (reason.includes("_")) {
        expect(copy, `copy for ${reason} must not name the reason`).not.toContain(reason);
      }
      expect(copy, `copy for ${reason} must not contain an underscore`).not.toContain("_");
      expect(copy, `copy for ${reason} must not contain snake_case`).not.toMatch(/[a-z]+_[a-z]+/);
    }
  });

  it("tells the admin whether anything changed", () => {
    for (const reason of TERMINAL_REASONS) {
      expect(copyFor(reason), `copy for ${reason} states the effect`).toMatch(/nothing.{0,12}changed/i);
    }
  });

  it("keeps the exported list in step with the union", () => {
    expect(new Set(TERMINAL_REASONS).size, "no duplicate members").toBe(TERMINAL_REASONS.length);
  });
});

describe("terminal reason parsing is closed", () => {
  it("passes through every known reason unchanged", () => {
    for (const reason of TERMINAL_REASONS) {
      expect(asTerminalReason(reason)).toBe(reason);
    }
  });

  it("collapses anything unrecognized to internal_error", () => {
    const hostile = [
      "nope",
      "",
      'Clockify POST /workspaces/64ad1305c701cc5be7c26fe4/tags -> 500: {"x":1}',
      // The open `invalid_*` family that operation-preparation-service.ts:475
      // admits, and the `code: cause` shape action-execution-service.ts:485
      // builds — neither is a member, and neither may reach an admin.
      "invalid_something_new",
      "write_port_not_ready: Error: eyJhbGciOiJIUzI1NiJ9.x.y",
      "TOO_MANY_REFINEMENTS",
    ];
    for (const raw of hostile) {
      expect(asTerminalReason(raw), `parse of ${JSON.stringify(raw)}`).toBe("internal_error");
    }
  });

  it("gives a parsed unknown the same copy as a real internal error", () => {
    const parsed: TerminalReason = asTerminalReason("something nobody enumerated");
    expect(copyFor(parsed)).toBe(copyFor("internal_error"));
  });
});
