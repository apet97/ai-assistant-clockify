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
