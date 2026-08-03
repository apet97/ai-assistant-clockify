import { describe, expect, it } from "vitest";
import { buildV2SystemPrompt } from "../../src/assistant-v2/prompt.js";

/**
 * A4 (readiness plan Part V.A) — the D-1 skip was licensed by the prompt itself:
 * "discover operations you do not already have loaded" told the model discovery
 * was only for MISSING tools, so a plausible stale write tool already in the
 * loaded set suppressed the search. The contract now: discovery is expected
 * whenever the turn requests a change, regardless of what appears loaded,
 * because already-loaded tools may be stale.
 */
describe("v2 system prompt discovery licence", () => {
  const prompt = buildV2SystemPrompt();

  it("requires discovery whenever the turn requests a change, regardless of loaded tools", () => {
    expect(prompt).toContain(
      "Use assistant_find_api_operations to discover the operations each request needs.",
    );
    expect(prompt).toContain(
      "When a turn requests a change, run discovery in that turn before proposing any write operation; already-loaded tools may be stale.",
    );
  });

  it("no longer licenses skipping discovery because a tool appears loaded", () => {
    expect(prompt).not.toContain("do not already have loaded");
  });

  it("keeps the loaded-tools-only call rule alongside the discovery requirement", () => {
    expect(prompt).toContain("Call only tools that are currently loaded in this conversation.");
  });
});

/**
 * The mixed-batch trap, observed in production on 737fddd.
 *
 * The prompt said "use assistant_find_api_operations to discover the operations
 * each request needs" and "call only tools that are currently loaded" — and said
 * nothing about keeping the two apart. A run put a search and
 * `clockify_entries_list` in one response, was refused `mixed_discovery_batch`,
 * and spent the rest of its discovery budget trying to understand why. The
 * runtime refuses that batch, so the prompt must say so up front rather than
 * teaching it through denials.
 *
 * The second rule addresses what the run did NEXT: it told the admin, as fact,
 * that Clockify has no bulk-update endpoint — a claim it never verified through
 * any search or result.
 */
describe("v2 system prompt keeps searches and calls in separate steps", () => {
  const prompt = buildV2SystemPrompt();

  it("states the mixed-batch rule the runtime enforces", () => {
    expect(prompt).toContain(
      "Never put assistant_find_api_operations and a loaded-tool call in the same response",
    );
  });

  it("forbids asserting unverified Clockify capabilities and requires honest scale", () => {
    expect(prompt).toMatch(/never state what Clockify can or cannot do/i);
    expect(prompt).toMatch(/stages|one run/i);
  });
});
