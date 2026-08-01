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

/**
 * The drift guard.
 *
 * `receipt.code` is `string` and the denial producers are not closed by types, so
 * "the union is complete" cannot be a compile-time fact. This pins the codes those
 * producers can actually REACH `outcome.code` with, each read from its source. A new
 * one added upstream fails HERE — loudly — rather than silently degrading to
 * `internal_error` on an admin's screen, which is the failure mode that would
 * otherwise be invisible.
 */
describe("every reachable denial code is a member", () => {
  it.each([
    // services/api-discovery-service.ts:86,112
    ["too_many_refinements", "api-discovery-service"],
    ["invalid_args", "api-discovery-service"],
    // assistant-v2/read-execution.ts:168,233-238
    ["unavailable_for_auth_class", "read-execution"],
    ["policy_denied", "read-execution"],
    ["unknown_action", "read-execution"],
    // services/operation-preparation-service.ts:470-478
    ["host_call_budget_exceeded", "operation-preparation"],
    ["clarification_required", "operation-preparation"],
    ["presentation_limit_exceeded", "operation-preparation"],
    ["write_port_not_ready", "operation-preparation"],
    // services/action-execution-service.ts:38 (denyCode) + 176 (not-admitted tail)
    ["duplicate_tool_call_id", "action-execution"],
    ["mixed_discovery_batch", "action-execution"],
    ["budget_exhausted", "action-execution"],
    ["read_write_dependency", "action-execution"],
    ["duplicate_write", "action-execution"],
    ["tool_not_loaded", "action-execution"],
    ["stale_catalog_hash", "action-execution"],
    ["unknown_tool", "action-execution"],
    ["cancelled_before_dispatch", "action-execution"],
    ["not_admitted", "action-execution"],
    ["read_dispatch_failed", "action-execution"],
    // routes/v2-chat-pipeline.ts:49,131
    ["installation_changed", "v2-chat-pipeline"],
  ])("%s (from %s) parses to itself, not to a fallback", (code) => {
    expect(asTerminalReason(code)).toBe(code);
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
      // The `code: cause` shape action-execution-service.ts:485 used to build.
      "write_port_not_ready: Error: eyJhbGciOiJIUzI1NiJ9.x.y",
      "TOO_MANY_REFINEMENTS",
    ];
    for (const raw of hostile) {
      expect(asTerminalReason(raw), `parse of ${JSON.stringify(raw)}`).toBe("internal_error");
    }
  });

  it("routes the open invalid_* family to one honest sentence, not to our fault", () => {
    // operation-preparation-service.ts:475 denies on a PREFIX, so this family
    // cannot be enumerated. Blaming our side ("something went wrong on my
    // side") would send an admin to support over their own wording.
    for (const raw of ["invalid_something_new", "invalid_membership_rate", "invalid_query"]) {
      expect(asTerminalReason(raw)).toBe("invalid_request");
    }
    expect(copyFor("invalid_request")).not.toBe(copyFor("internal_error"));
    // Still a constant even when the prefix arrives on a hostile string.
    const hostile = "invalid_args for 64ad1305c701cc5be7c26fe4 eyJhbGciOiJIUzI1NiJ9.x.y";
    expect(copyFor(asTerminalReason(hostile))).not.toContain("64ad1305c701cc5be7c26fe4");
    expect(copyFor(asTerminalReason(hostile))).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("gives a parsed unknown the same copy as a real internal error", () => {
    const parsed: TerminalReason = asTerminalReason("something nobody enumerated");
    expect(copyFor(parsed)).toBe(copyFor("internal_error"));
  });
});
