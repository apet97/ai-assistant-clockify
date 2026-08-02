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
 * The known-codes half of the drift guard.
 *
 * `receipt.code` is `string` and the denial producers are not closed by types, so
 * "the union is complete" cannot be a compile-time fact. This pins the codes those
 * producers are known to reach `outcome.code` with today, each read from its
 * source, so a change to one of THEM is caught.
 *
 * It cannot, on its own, detect a NEW code added upstream — nothing here reads
 * source. The header comment used to claim it could; that claim was false, and
 * the extraction guard below is the mechanism it promised.
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

/**
 * The drift guard the header comment used to promise.
 *
 * The list above is hand-written, so it can only catch a change to a code
 * someone already thought of. This one derives the producer set from SOURCE:
 * it reads the six files that put a literal denial code on this field and
 * fails when one of them grows a code the admin-facing union cannot express.
 *
 * WHAT IT CANNOT SEE, stated plainly so this comment does not repeat the
 * overclaim it replaces:
 *   - a code built from a variable or a template literal,
 *   - a code arriving through a pass-through (`code: preparation.code`),
 *   - a code produced outside these six files and forwarded in.
 * It catches LITERAL drift only. That is strictly more than the zero the
 * previous mechanism caught, and it is not everything.
 *
 * The producers are the five named in `terminal-reason.ts` plus
 * `discovery/api-search-tool.ts`, which owns `LoadedToolValidationFailure` —
 * every member of that union becomes a denial code through `denyCode`, and
 * leaving it out would rebuild the same blind spot one file over.
 */
describe("source-derived drift guard", () => {
  const ROOT = new URL("../../src/", import.meta.url);
  const PRODUCERS = [
    "services/api-discovery-service.ts",
    "assistant-v2/read-execution.ts",
    "services/operation-preparation-service.ts",
    "services/action-execution-service.ts",
    "routes/v2-chat-pipeline.ts",
    "assistant-v2/discovery/api-search-tool.ts",
  ];

  /**
   * Codes that reach this field as literals but are deliberately NOT members.
   * Each entry is a decision, not a silence — an unexplained addition here is
   * the same failure the guard exists to prevent.
   */
  const ALLOWED_NON_MEMBERS = new Map<string, string>([
    // Read-port internal outcomes. They reach `lastDenialCode` and therefore
    // degrade to `internal_error` copy on an admin's screen. That is a real
    // gap, recorded rather than fixed: adding members to `TerminalReason` is
    // a product copy decision, out of scope for this contract repair.
    ["clarification_already_active", "read-execution: degrades to internal_error (known gap)"],
    ["unexpected_action_result", "read-execution: degrades to internal_error (known gap)"],
    // Preparation-internal codes. Since the write-preparation catch was
    // bounded to its allowlist, these can no longer escape as `outcome.code`
    // — they are folded into `write_port_not_ready`.
    ["missing_mutation_plan", "operation-preparation: internal, folded into write_port_not_ready"],
    ["preparation_failed", "operation-preparation: internal, folded into write_port_not_ready"],
    ["read_failed", "read-execution: the bounded fallback, parsed as internal_error by design"],
    // Discovery notices, not denials: `discovery.search` returns these under
    // `kind: "notice"` and they never populate `outcome.code`.
    ["no_available_operation_for_auth_class", "api-search-tool: a notice kind, not a denial"],
    ["model_unavailable", "v2-chat-pipeline: a route-level code, not a run terminal reason"],
    ["clarification_not_pending", "v2-chat-pipeline: a route-level code, not a run terminal reason"],
    ["clarification_not_found", "v2-chat-pipeline: a route-level code, not a run terminal reason"],
    ["clarification_continuation_failed", "v2-chat-pipeline: a route-level code, not a run terminal reason"],
    ["operation_id_conflict", "v2-chat-pipeline: a route-level code, not a run terminal reason"],
    ["not_found", "v2-chat-pipeline: a 404 route-level code, not a run terminal reason"],
    ["run_awaiting_confirmation", "v2-chat-pipeline: a route-level code, not a run terminal reason"],
    // `failRunWithEvent` persists the RAW code for audit fidelity
    // (`run-service.ts:105-112`); a stranded prior run is failed in the
    // background and its code is never rendered as this turn's outcome.
    ["stranded_active_run", "v2-chat-pipeline: an audit-only run failure code"],
  ]);

  /**
   * Literal denial positions only. Object-literal `code: "…"` next to a
   * `kind`/`denyCode` position, equality comparisons against a caught code,
   * and the two union declarations whose members become codes verbatim.
   */
  function extract(source: string): string[] {
    const found = new Set<string>();
    const patterns = [
      /\bdenyCode\(\s*"([a-z][a-z0-9_]*)"/g,
      /\bcode:\s*"([a-z][a-z0-9_]*)"/g,
      /\b(?:raw|thrown)\s*===\s*"([a-z][a-z0-9_]*)"/g,
    ];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) found.add(match[1]!);
    }
    // The two declarations whose members become denial codes verbatim, read by
    // NAME rather than by "any union of string literals" — the loose form
    // swept up unrelated unions (`"definitive_failed" | "outcome_unknown"`)
    // and would have made the allowlist absorb everything.
    const declarations = [
      /type LoadedToolValidationFailure\s*=([^;]+);/,
      /function denyCode\(reason:([^)]+)\)/,
    ];
    for (const declaration of declarations) {
      const body = declaration.exec(source)?.[1];
      if (!body) continue;
      for (const match of body.matchAll(/"([a-z][a-z0-9_]*)"/g)) found.add(match[1]!);
    }
    return [...found];
  }

  it("finds no literal denial code the admin-facing union cannot express", async () => {
    const { readFile } = await import("node:fs/promises");
    const unexplained: string[] = [];
    for (const producer of PRODUCERS) {
      const source = await readFile(new URL(producer, ROOT), "utf8");
      for (const code of extract(source)) {
        if (asTerminalReason(code) === code) continue;
        if (code.startsWith("invalid_")) continue;
        if (ALLOWED_NON_MEMBERS.has(code)) continue;
        unexplained.push(`${producer}: ${code}`);
      }
    }
    expect(unexplained, "add a TerminalReason member, or an explained allowlist entry").toEqual([]);
  });

  it("actually reads the producers (a guard that finds nothing proves nothing)", async () => {
    const { readFile } = await import("node:fs/promises");
    let total = 0;
    for (const producer of PRODUCERS) {
      total += extract(await readFile(new URL(producer, ROOT), "utf8")).length;
    }
    // If a refactor moves these codes out of literal positions, the guard goes
    // blind while still passing. This is the tripwire for that.
    expect(total).toBeGreaterThan(20);
  });
});
