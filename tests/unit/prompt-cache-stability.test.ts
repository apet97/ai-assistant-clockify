import { describe, expect, it } from "vitest";
import { toolsForModel } from "../../src/harness/tools.js";
import { buildToolSystemPrompt } from "../../src/assistant/prompts.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";

/**
 * Prompt-cache stability guard (STEP 3 — 0 request-byte change). Providers (DeepSeek,
 * OpenAI-compatible) bill cached prompt tokens at a fraction of the price, but only the
 * longest STABLE prefix of a request is cached. Our prefix is the tool array + the
 * system prompt — so if a future change injects anything per-call (a timestamp, a
 * nonce, Math.random, request-specific text) into either, every call would cache-miss
 * and silently cost more. These pins fail loudly if that prefix ever stops being
 * byte-stable across calls (only the server's currentDate is allowed to vary).
 */
describe("prompt-cache prefix stability", () => {
  it("toolsForModel() is byte-identical (and the same memoized reference) across calls", () => {
    expect(toolsForModel()).toBe(toolsForModel()); // memoized: same reference
    expect(JSON.stringify(toolsForModel())).toBe(JSON.stringify(toolsForModel()));
  });

  it("a subset view is byte-identical across calls for the same name set", () => {
    const names = new Set(["clockify_status", "clockify_tags_delete"]);
    expect(JSON.stringify(toolsForModel(names))).toBe(JSON.stringify(toolsForModel(names)));
  });

  it("buildToolSystemPrompt is deterministic for identical inputs (no hidden per-call data)", () => {
    const input = { policy: defaultAdminPolicy(), authClass: "addon" as const, currentDate: "2026-06-16" };
    expect(buildToolSystemPrompt(input)).toBe(buildToolSystemPrompt(input));
  });

  it("the system prompt is stable across calls EXCEPT for the server currentDate", () => {
    const base = { policy: defaultAdminPolicy(), authClass: "addon" as const };
    const a = buildToolSystemPrompt({ ...base, currentDate: "2026-06-16" });
    const b = buildToolSystemPrompt({ ...base, currentDate: "2026-09-09" });
    // The ONLY allowed variation is the injected date string; normalize it and the
    // rest of the prompt — the cacheable prefix — must be byte-identical.
    expect(a.replaceAll("2026-06-16", "DATE")).toBe(b.replaceAll("2026-09-09", "DATE"));
  });
});
